-- Git Repository Forensics — schema change 002: team analytics.
--
-- Evolves the schema created by 001 in place (ALTER / DROP / CREATE) instead
-- of editing 001, so databases that already ran 001 upgrade without data loss.
-- Applied in a single transaction by lib/migrate.ts.

-- ---------------------------------------------------------------------------
-- 1. Bot identities
-- ---------------------------------------------------------------------------
-- Dependabot, Renovate, GitHub Actions and similar accounts commit often but
-- own no knowledge; counting them as authors distorts every "how many people"
-- metric. A stored generated column keeps the flag consistent with the e-mail
-- and name without any application code having to maintain it.
ALTER TABLE developers
    ADD COLUMN is_bot BOOLEAN GENERATED ALWAYS AS (
        email ~* '(\[bot\]@|^bot@|dependabot|renovate|github-actions)'
        OR name ~* '\[bot\]$'
    ) STORED;

-- ---------------------------------------------------------------------------
-- 2. Audit actions are snake_case identifiers (e.g. login_failed)
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_action_format CHECK (action ~ '^[a-z][a-z_]{1,62}$');

-- ---------------------------------------------------------------------------
-- 3. Replace an index
-- ---------------------------------------------------------------------------
-- Per-developer timelines filter on the author and sort by date. A composite
-- index serves both, and makes the single-column one redundant.
DROP INDEX commits_author_idx;
CREATE INDEX commits_author_time_idx ON commits (author_id, authored_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Redefine file_hotspots to ignore bots
-- ---------------------------------------------------------------------------
-- A view's query cannot be altered in place when it gains a join, so it is
-- dropped and recreated. The column list is unchanged for existing readers.
DROP VIEW file_hotspots;

CREATE VIEW file_hotspots AS
SELECT f.repository_id,
       f.id                                                    AS file_id,
       f.path,
       f.exists_at_head,
       count(fc.commit_id)                                     AS revisions,
       count(DISTINCT c.author_id) FILTER (WHERE NOT d.is_bot) AS authors,
       COALESCE(sum(fc.insertions + fc.deletions), 0)          AS churn,
       max(c.authored_at)                                      AS last_changed_at
FROM files f
JOIN file_changes fc ON fc.file_id = f.id
JOIN commits c       ON c.id = fc.commit_id
JOIN developers d    ON d.id = c.author_id
GROUP BY f.id;

-- ---------------------------------------------------------------------------
-- 5. Stored procedure: session housekeeping
-- ---------------------------------------------------------------------------
-- Called on every sign-in (CALL purge_expired_sessions()). Returns how many
-- sessions were removed through its INOUT parameter.
CREATE PROCEDURE purge_expired_sessions(INOUT removed INTEGER DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM sessions WHERE expires_at < now();
    GET DIAGNOSTICS removed = ROW_COUNT;
END $$;
