// Read-side queries used by pages and API routes. All values are bound as
// parameters; expensive aggregates are cached in Redis per repository and the
// cache is cleared by the worker after each re-analysis.
import { query, queryOne } from "./db";
import { cached } from "./redis";
import { cypher } from "./neo4j";
import { embed, toPgVector } from "./analysis/embedding";

const TTL = 600;
const key = (repoId: number, name: string) => `cache:repo:${repoId}:${name}`;

export type RepoListRow = {
  id: number;
  name: string;
  source_type: "remote" | "local";
  source: string;
  branch: string | null;
  last_analyzed_at: string | null;
  created_by: number | null;
  job_status: string | null;
  commits: number;
};

export function listRepositories() {
  return query<RepoListRow>(
    `SELECT r.id::int, r.name, r.source_type, r.source, r.branch, r.last_analyzed_at,
            r.created_by::int, j.status AS job_status,
            (SELECT count(*)::int FROM commits c WHERE c.repository_id = r.id) AS commits
       FROM repositories r
       LEFT JOIN LATERAL (SELECT status FROM analysis_jobs
                           WHERE repository_id = r.id ORDER BY created_at DESC LIMIT 1) j ON TRUE
      ORDER BY r.name`,
  );
}

export function getRepository(id: number) {
  return queryOne<RepoListRow & { head_sha: string | null }>(
    `SELECT id::int, name, source_type, source, branch, last_analyzed_at, created_by::int, head_sha
       FROM repositories WHERE id = $1`,
    [id],
  );
}

export type JobRow = {
  id: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  stats: Record<string, unknown> | null;
  requested_by_name: string | null;
};

export function listJobs(repoId: number, limit = 10) {
  return query<JobRow>(
    `SELECT j.id::int, j.status, j.created_at, j.started_at, j.finished_at, j.error, j.stats,
            u.display_name AS requested_by_name
       FROM analysis_jobs j LEFT JOIN users u ON u.id = j.requested_by
      WHERE j.repository_id = $1
      ORDER BY j.created_at DESC LIMIT $2`,
    [repoId, limit],
  );
}

export type Summary = {
  commits: number;
  merges: number;
  developers: number;
  files_at_head: number;
  first_commit: string | null;
  last_commit: string | null;
  coupling_edges: number;
  bus_factor: number;
};

export const repoSummary = (repoId: number) =>
  cached(key(repoId, "summary"), TTL, async () =>
    (await queryOne<Summary>(
      `SELECT (SELECT count(*)::int FROM commits WHERE repository_id = $1)                      AS commits,
              (SELECT count(*)::int FROM commits WHERE repository_id = $1 AND is_merge)         AS merges,
              (SELECT count(*)::int FROM developers WHERE repository_id = $1)                   AS developers,
              (SELECT count(*)::int FROM files WHERE repository_id = $1 AND exists_at_head)     AS files_at_head,
              (SELECT min(authored_at) FROM commits WHERE repository_id = $1)                   AS first_commit,
              (SELECT max(authored_at) FROM commits WHERE repository_id = $1)                   AS last_commit,
              (SELECT count(*)::int FROM coupling_edges WHERE repository_id = $1)               AS coupling_edges,
              bus_factor($1)                                                                    AS bus_factor`,
      [repoId],
    ))!,
  );

export type MonthRow = { month: string; commits: number; authors: number; insertions: number; deletions: number };

export const monthlyActivity = (repoId: number) =>
  cached(key(repoId, "monthly"), TTL, () =>
    query<MonthRow>(
      `SELECT to_char(month, 'YYYY-MM') AS month, commits::int, authors::int,
              insertions::int, deletions::int
         FROM monthly_activity WHERE repository_id = $1 ORDER BY month`,
      [repoId],
    ),
  );

export type DeveloperRow = {
  developer_id: number;
  name: string;
  email: string;
  commits: number;
  merges: number;
  insertions: number;
  deletions: number;
  first_commit_at: string | null;
  last_commit_at: string | null;
  active_days: number;
  owned_lines: number;
  ownership_share: number;
};

export const developers = (repoId: number) =>
  cached(key(repoId, "developers"), TTL, () =>
    query<DeveloperRow>(
      `WITH owned AS (
         SELECT o.developer_id, sum(o.lines) AS lines
           FROM file_ownership o JOIN files f ON f.id = o.file_id
          WHERE f.repository_id = $1 GROUP BY o.developer_id
       )
       SELECT a.developer_id::int, a.name, a.email, a.commits::int, a.merges::int,
              a.insertions::int, a.deletions::int, a.first_commit_at, a.last_commit_at,
              a.active_days::int,
              COALESCE(o.lines, 0)::int AS owned_lines,
              COALESCE(o.lines / NULLIF(sum(o.lines) OVER (), 0), 0)::float AS ownership_share
         FROM developer_activity a LEFT JOIN owned o ON o.developer_id = a.developer_id
        WHERE a.repository_id = $1
        ORDER BY a.commits DESC, a.name`,
      [repoId],
    ),
  );

export type HotspotRow = {
  file_id: number;
  path: string;
  revisions: number;
  authors: number;
  churn: number;
  last_changed_at: string;
  coupled_files: number;
};

export const hotspots = (repoId: number, limit = 50) =>
  cached(key(repoId, `hotspots:${limit}`), TTL, () =>
    query<HotspotRow>(
      `SELECT h.file_id::int, h.path, h.revisions::int, h.authors::int, h.churn::int, h.last_changed_at,
              (SELECT count(*)::int FROM coupling_edges e
                WHERE e.file_a_id = h.file_id OR e.file_b_id = h.file_id) AS coupled_files
         FROM file_hotspots h
        WHERE h.repository_id = $1 AND h.exists_at_head
        ORDER BY h.revisions DESC, h.churn DESC, h.path
        LIMIT $2`,
      [repoId, limit],
    ),
  );

export type CouplingRow = {
  file_a_id: number;
  file_a: string;
  file_b_id: number;
  file_b: string;
  cochanges: number;
  confidence_ab: number;
  confidence_ba: number;
  jaccard: number;
};

export const coupling = (repoId: number, minJaccard = 0, limit = 100) =>
  cached(key(repoId, `coupling:${minJaccard}:${limit}`), TTL, () =>
    query<CouplingRow>(
      `SELECT e.file_a_id::int, a.path AS file_a, e.file_b_id::int, b.path AS file_b,
              e.cochanges, e.confidence_ab, e.confidence_ba, e.jaccard
         FROM coupling_edges e
         JOIN files a ON a.id = e.file_a_id
         JOIN files b ON b.id = e.file_b_id
        WHERE e.repository_id = $1 AND e.jaccard >= $2
          AND a.exists_at_head AND b.exists_at_head
        ORDER BY e.jaccard DESC, e.cochanges DESC
        LIMIT $3`,
      [repoId, minJaccard, limit],
    ),
  );

// ---------------------------------------------------------------------------
// Single file
// ---------------------------------------------------------------------------
export function getFile(repoId: number, fileId: number) {
  return queryOne<{ id: number; path: string; exists_at_head: boolean }>(
    "SELECT id::int, path, exists_at_head FROM files WHERE id = $1 AND repository_id = $2",
    [fileId, repoId],
  );
}

export function fileHistory(fileId: number, limit = 50) {
  return query<{
    sha: string; subject: string; authored_at: string; author: string;
    change: string; old_path: string | null; insertions: number | null; deletions: number | null;
  }>(
    `SELECT c.sha, c.subject, c.authored_at, d.name AS author,
            fc.change, fc.old_path, fc.insertions, fc.deletions
       FROM file_changes fc
       JOIN commits c    ON c.id = fc.commit_id
       JOIN developers d ON d.id = c.author_id
      WHERE fc.file_id = $1
      ORDER BY c.authored_at DESC LIMIT $2`,
    [fileId, limit],
  );
}

export function fileOwners(fileId: number) {
  return query<{ developer_id: number; name: string; lines: number; share: number }>(
    `SELECT d.id::int AS developer_id, d.name, o.lines,
            (o.lines::float / sum(o.lines) OVER ()) AS share
       FROM file_ownership o JOIN developers d ON d.id = o.developer_id
      WHERE o.file_id = $1 ORDER BY o.lines DESC`,
    [fileId],
  );
}

/** Files coupled to `fileId`; `confidence` is P(other changes | this file changes). */
export function coupledFiles(fileId: number) {
  return query<{ file_id: number; path: string; cochanges: number; confidence: number; jaccard: number }>(
    `SELECT f.id::int AS file_id, f.path, e.cochanges,
            CASE WHEN e.file_a_id = $1 THEN e.confidence_ab ELSE e.confidence_ba END AS confidence,
            e.jaccard
       FROM coupling_edges e
       JOIN files f ON f.id = CASE WHEN e.file_a_id = $1 THEN e.file_b_id ELSE e.file_a_id END
      WHERE e.file_a_id = $1 OR e.file_b_id = $1
      ORDER BY confidence DESC, e.cochanges DESC LIMIT 25`,
    [fileId],
  );
}

/** How often each 10-line region of the file was touched by a recorded hunk. */
export function hunkHeatmap(fileId: number) {
  return query<{ bucket_start: number; hunks: number }>(
    `SELECT (greatest(new_start, 1) - 1) / 10 * 10 + 1 AS bucket_start, count(*)::int AS hunks
       FROM hunks WHERE file_id = $1
      GROUP BY 1 ORDER BY 1`,
    [fileId],
  );
}

// ---------------------------------------------------------------------------
// Commits: recent, full-text search and vector similarity
// ---------------------------------------------------------------------------
export type CommitRow = {
  sha: string;
  subject: string;
  authored_at: string;
  author: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  is_merge: boolean;
  headline?: string;
  score?: number;
};

const commitCols = `c.sha, c.subject, c.authored_at, d.name AS author,
                    c.files_changed, c.insertions, c.deletions, c.is_merge`;

export function recentCommits(repoId: number, limit = 30) {
  return query<CommitRow>(
    `SELECT ${commitCols} FROM commits c JOIN developers d ON d.id = c.author_id
      WHERE c.repository_id = $1 ORDER BY c.authored_at DESC LIMIT $2`,
    [repoId, limit],
  );
}

export function searchCommits(repoId: number, text: string, limit = 30) {
  return query<CommitRow>(
    `SELECT ${commitCols},
            ts_headline('english', c.subject || ' ' || c.body, q,
                        'StartSel=<<, StopSel=>>, MaxFragments=1, MaxWords=20') AS headline,
            ts_rank(to_tsvector('english', c.subject || ' ' || c.body), q)::float AS score
       FROM commits c JOIN developers d ON d.id = c.author_id,
            websearch_to_tsquery('english', $2) q
      WHERE c.repository_id = $1
        AND to_tsvector('english', c.subject || ' ' || c.body) @@ q
      ORDER BY score DESC, c.authored_at DESC LIMIT $3`,
    [repoId, text, limit],
  );
}

/** Commits whose messages are closest (cosine distance) to free text. */
export function similarCommits(repoId: number, text: string, limit = 15) {
  const v = embed(text);
  if (!v) return Promise.resolve([] as CommitRow[]);
  return query<CommitRow>(
    `SELECT ${commitCols}, (1 - (e.embedding <=> $2::vector))::float AS score
       FROM commit_embeddings e
       JOIN commits c    ON c.id = e.commit_id
       JOIN developers d ON d.id = c.author_id
      WHERE c.repository_id = $1
      ORDER BY e.embedding <=> $2::vector LIMIT $3`,
    [repoId, toPgVector(v), limit],
  );
}

// ---------------------------------------------------------------------------
// Graph queries (Neo4j)
// ---------------------------------------------------------------------------
export type Reviewer = { developer: string; email: string; score: number; via: string[] };

/**
 * Suggests reviewers for a change to a file: people who touched the file or
 * the files most strongly coupled to it, weighted by commits and coupling.
 */
export function suggestReviewers(fileId: number) {
  return cypher<Reviewer>(
    `MATCH (f:File {id: $fileId})
     OPTIONAL MATCH (f)-[c:COUPLED_WITH]-(g:File)
     WITH f, collect({file: g, w: c.jaccard}) AS neighbours
     UNWIND [{file: f, w: 1.0}] + [n IN neighbours WHERE n.file IS NOT NULL] AS target
     WITH target.file AS file, target.w AS w
     MATCH (d:Developer)-[t:TOUCHED]->(file)
     WITH d, sum(t.commits * w) AS score, collect(DISTINCT file.path)[0..5] AS via
     RETURN d.name AS developer, d.email AS email, round(score * 100) / 100.0 AS score, via
     ORDER BY score DESC LIMIT 8`,
    { fileId },
  );
}

export type Collaboration = { a: string; b: string; shared_files: number };

/** Pairs of developers who have worked on the same files. */
export const collaboration = (repoId: number) =>
  cached(key(repoId, "collaboration"), TTL, () =>
    cypher<Collaboration>(
      `MATCH (a:Developer {repoId: $repoId})-[:TOUCHED]->(f:File)<-[:TOUCHED]-(b:Developer)
       WHERE a.id < b.id
       RETURN a.name AS a, b.name AS b, count(DISTINCT f) AS shared_files
       ORDER BY shared_files DESC LIMIT 30`,
      { repoId },
    ),
  );

/** Knowledge silos: files at HEAD where a single developer owns at least 90% of the lines. */
export const knowledgeSilos = (repoId: number) =>
  cached(key(repoId, "silos"), TTL, () =>
    cypher<{ path: string; owner: string; share: number }>(
      `MATCH (f:File {repoId: $repoId, alive: true})<-[o:OWNS]-(d:Developer)
       WITH f, sum(o.lines) AS total, collect({d: d, lines: o.lines}) AS owners
       UNWIND owners AS ow
       WITH f, total, ow WHERE total >= 5 AND toFloat(ow.lines) / total >= 0.9
       RETURN f.path AS path, ow.d.name AS owner, round(100.0 * ow.lines / total) / 100.0 AS share
       ORDER BY total DESC LIMIT 25`,
      { repoId },
    ),
  );
