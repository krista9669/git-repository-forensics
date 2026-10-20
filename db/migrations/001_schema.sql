-- Git Repository Forensics — core schema.
-- PostgreSQL 17 + pgvector. Applied by scripts/migrate.ts inside one transaction.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
CREATE TYPE user_role       AS ENUM ('admin', 'analyst');
CREATE TYPE repo_source     AS ENUM ('remote', 'local');
CREATE TYPE job_status      AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE change_kind     AS ENUM ('A', 'M', 'D', 'R', 'C', 'T');

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id             BIGSERIAL PRIMARY KEY,
    email          TEXT        NOT NULL,
    display_name   TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
    password_hash  TEXT        NOT NULL,
    role           user_role   NOT NULL DEFAULT 'analyst',
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
-- Case-insensitive uniqueness of e-mail addresses.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- Only a SHA-256 hash of the session token is stored, so a database leak
-- does not leak usable session cookies.
CREATE TABLE sessions (
    token_hash  TEXT        PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Repositories and analysis jobs
-- ---------------------------------------------------------------------------
CREATE TABLE repositories (
    id                BIGSERIAL   PRIMARY KEY,
    name              TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    source_type       repo_source NOT NULL,
    -- https URL for remote repositories, path relative to LOCAL_REPO_ROOT for local ones
    source            TEXT        NOT NULL,
    branch            TEXT,
    created_by        BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_analyzed_at  TIMESTAMPTZ,
    head_sha          CHAR(40),
    CONSTRAINT repositories_source_uq UNIQUE (source_type, source),
    CONSTRAINT repositories_remote_https CHECK (source_type <> 'remote' OR source LIKE 'https://%')
);

CREATE TABLE analysis_jobs (
    id             BIGSERIAL   PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    requested_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    status         job_status  NOT NULL DEFAULT 'queued',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    worker_id      TEXT,
    error          TEXT,
    stats          JSONB,
    CHECK (started_at IS NULL OR started_at >= created_at),
    -- a queued job can be cancelled before it ever starts
    CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at)),
    CHECK (status NOT IN ('queued', 'running') OR finished_at IS NULL),
    CHECK (status <> 'running' OR started_at IS NOT NULL)
);
-- At most one queued-or-running job per repository.
CREATE UNIQUE INDEX analysis_jobs_one_active_uq
    ON analysis_jobs (repository_id) WHERE status IN ('queued', 'running');
-- Workers poll the queue oldest-first.
CREATE INDEX analysis_jobs_queue_idx ON analysis_jobs (created_at) WHERE status = 'queued';
CREATE INDEX analysis_jobs_repo_idx  ON analysis_jobs (repository_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Mined repository data (fully rebuilt on every analysis)
-- ---------------------------------------------------------------------------
-- One row per distinct author identity (e-mail, lower-cased) within a repository.
CREATE TABLE developers (
    id             BIGSERIAL   PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    email          TEXT        NOT NULL,
    name           TEXT        NOT NULL,
    UNIQUE (repository_id, email)
);

CREATE TABLE commits (
    id             BIGSERIAL   PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    sha            CHAR(40)    NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
    author_id      BIGINT      NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    authored_at    TIMESTAMPTZ NOT NULL,
    committed_at   TIMESTAMPTZ NOT NULL,
    parent_count   SMALLINT    NOT NULL CHECK (parent_count >= 0),
    is_merge       BOOLEAN     GENERATED ALWAYS AS (parent_count > 1) STORED,
    subject        TEXT        NOT NULL,
    body           TEXT        NOT NULL DEFAULT '',
    files_changed  INTEGER     NOT NULL DEFAULT 0 CHECK (files_changed >= 0),
    insertions     INTEGER     NOT NULL DEFAULT 0 CHECK (insertions >= 0),
    deletions      INTEGER     NOT NULL DEFAULT 0 CHECK (deletions >= 0),
    UNIQUE (repository_id, sha)
);
CREATE INDEX commits_repo_time_idx   ON commits (repository_id, authored_at DESC);
CREATE INDEX commits_author_idx      ON commits (author_id);
-- Full-text search over commit messages.
CREATE INDEX commits_message_fts_idx ON commits
    USING GIN (to_tsvector('english', subject || ' ' || body));

CREATE TABLE files (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT    NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path           TEXT      NOT NULL,
    exists_at_head BOOLEAN   NOT NULL DEFAULT FALSE,
    UNIQUE (repository_id, path)
);

CREATE TABLE file_changes (
    commit_id    BIGINT      NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    file_id      BIGINT      NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
    change       change_kind NOT NULL,
    old_path     TEXT,
    -- NULL for binary files, where git reports no line counts
    insertions   INTEGER     CHECK (insertions >= 0),
    deletions    INTEGER     CHECK (deletions >= 0),
    PRIMARY KEY (commit_id, file_id),
    CHECK (change NOT IN ('R', 'C') OR old_path IS NOT NULL)
);
CREATE INDEX file_changes_file_idx ON file_changes (file_id);

-- Line-level change hunks (from `git log -p -U0`) for the most recent commits.
CREATE TABLE hunks (
    id         BIGSERIAL PRIMARY KEY,
    commit_id  BIGINT  NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    file_id    BIGINT  NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
    old_start  INTEGER NOT NULL CHECK (old_start >= 0),
    old_lines  INTEGER NOT NULL CHECK (old_lines >= 0),
    new_start  INTEGER NOT NULL CHECK (new_start >= 0),
    new_lines  INTEGER NOT NULL CHECK (new_lines >= 0)
);
CREATE INDEX hunks_file_idx   ON hunks (file_id, new_start);
CREATE INDEX hunks_commit_idx ON hunks (commit_id);

-- Change coupling: files that tend to change in the same commits.
-- Each unordered pair is stored once, with file_a_id < file_b_id.
CREATE TABLE coupling_edges (
    repository_id  BIGINT  NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    file_a_id      BIGINT  NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    file_b_id      BIGINT  NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    cochanges      INTEGER NOT NULL CHECK (cochanges > 0),
    -- P(B changes | A changes) and P(A changes | B changes)
    confidence_ab  REAL    NOT NULL CHECK (confidence_ab BETWEEN 0 AND 1),
    confidence_ba  REAL    NOT NULL CHECK (confidence_ba BETWEEN 0 AND 1),
    -- |A ∩ B| / |A ∪ B|
    jaccard        REAL    NOT NULL CHECK (jaccard BETWEEN 0 AND 1),
    PRIMARY KEY (file_a_id, file_b_id),
    CHECK (file_a_id < file_b_id)
);
CREATE INDEX coupling_repo_strength_idx ON coupling_edges (repository_id, jaccard DESC);
CREATE INDEX coupling_b_idx             ON coupling_edges (file_b_id);

-- Code ownership from `git blame` at HEAD: lines currently attributed to each developer.
CREATE TABLE file_ownership (
    file_id       BIGINT  NOT NULL REFERENCES files(id)      ON DELETE CASCADE,
    developer_id  BIGINT  NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    lines         INTEGER NOT NULL CHECK (lines > 0),
    PRIMARY KEY (file_id, developer_id)
);
CREATE INDEX file_ownership_dev_idx ON file_ownership (developer_id);

-- Bag-of-words feature vectors of commit messages for similarity search.
CREATE TABLE commit_embeddings (
    commit_id  BIGINT      PRIMARY KEY REFERENCES commits(id) ON DELETE CASCADE,
    embedding  vector(256) NOT NULL
);
CREATE INDEX commit_embeddings_hnsw_idx
    ON commit_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    action       TEXT        NOT NULL,
    target_type  TEXT,
    target_id    BIGINT,
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER repositories_touch
    BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The system must always keep at least one active administrator.
CREATE FUNCTION protect_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.role = 'admin' AND OLD.is_active
       AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NOT NEW.is_active)
       AND NOT EXISTS (SELECT 1 FROM users
                       WHERE role = 'admin' AND is_active AND id <> OLD.id) THEN
        RAISE EXCEPTION 'cannot remove or demote the last active administrator'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER users_protect_last_admin
    BEFORE UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION protect_last_admin();

-- When a job finishes successfully, stamp the repository.
CREATE FUNCTION stamp_repository_analyzed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded' THEN
        UPDATE repositories SET last_analyzed_at = NEW.finished_at
         WHERE id = NEW.repository_id;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER analysis_jobs_stamp
    AFTER UPDATE OF status ON analysis_jobs
    FOR EACH ROW EXECUTE FUNCTION stamp_repository_analyzed();

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------
CREATE VIEW developer_activity AS
SELECT d.repository_id,
       d.id                                   AS developer_id,
       d.name,
       d.email,
       count(c.id)                            AS commits,
       count(c.id) FILTER (WHERE c.is_merge)  AS merges,
       COALESCE(sum(c.insertions), 0)         AS insertions,
       COALESCE(sum(c.deletions), 0)          AS deletions,
       min(c.authored_at)                     AS first_commit_at,
       max(c.authored_at)                     AS last_commit_at,
       count(DISTINCT c.authored_at::date)    AS active_days
FROM developers d
LEFT JOIN commits c ON c.author_id = d.id
GROUP BY d.repository_id, d.id;

-- Hotspots: files changed often, by many people, with high churn.
CREATE VIEW file_hotspots AS
SELECT f.repository_id,
       f.id                                          AS file_id,
       f.path,
       f.exists_at_head,
       count(fc.commit_id)                           AS revisions,
       count(DISTINCT c.author_id)                   AS authors,
       COALESCE(sum(fc.insertions + fc.deletions), 0) AS churn,
       max(c.authored_at)                            AS last_changed_at
FROM files f
JOIN file_changes fc ON fc.file_id = f.id
JOIN commits c       ON c.id = fc.commit_id
GROUP BY f.id;

-- Monthly activity per repository, refreshed by the worker after each analysis.
CREATE MATERIALIZED VIEW monthly_activity AS
SELECT c.repository_id,
       date_trunc('month', c.authored_at)::date AS month,
       count(*)                                 AS commits,
       count(DISTINCT c.author_id)              AS authors,
       sum(c.insertions)                        AS insertions,
       sum(c.deletions)                         AS deletions
FROM commits c
GROUP BY 1, 2;
CREATE UNIQUE INDEX monthly_activity_uq ON monthly_activity (repository_id, month);

-- Bus factor: the smallest number of developers who together own more than
-- half of the blamed lines at HEAD.
CREATE FUNCTION bus_factor(p_repository_id BIGINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    WITH per_dev AS (
        SELECT o.developer_id, sum(o.lines) AS lines
        FROM file_ownership o
        JOIN files f ON f.id = o.file_id
        WHERE f.repository_id = p_repository_id
        GROUP BY o.developer_id
    ), ranked AS (
        SELECT lines,
               sum(lines) OVER (ORDER BY lines DESC, developer_id
                                ROWS UNBOUNDED PRECEDING) AS running,
               sum(lines) OVER ()                         AS total
        FROM per_dev
    )
    -- a developer is needed while the owners before them hold at most half
    SELECT count(*)::int FROM ranked WHERE running - lines <= total / 2.0
$$;
