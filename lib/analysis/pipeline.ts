import fs from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import type { Env } from "../env";
import { git } from "../git/run";
import { LOG_FORMAT, parseBlame, parseHunks, parseLog, parseLsTree, type ParsedCommit } from "../git/parse";
import { checkRemoteUrl, resolveLocalRepo, checkBranch } from "../repo-source";
import { computeCoupling } from "./coupling";
import { embed, toPgVector } from "./embedding";

export type RepoRow = {
  id: number;
  name: string;
  source_type: "remote" | "local";
  source: string;
  branch: string | null;
};

export type Progress = (stage: string, percent: number, message?: string) => Promise<void>;

export type AnalysisStats = {
  headSha: string;
  commits: number;
  truncated: boolean;
  developers: number;
  files: number;
  fileChanges: number;
  hunks: number;
  couplingEdges: number;
  blamedFiles: number;
  embeddings: number;
  durationMs: number;
};

export class CancelledError extends Error {}

const CHUNK = 2000;

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Returns the directory git should run in, cloning or fetching first for remote repositories. */
async function prepareWorkdir(repo: RepoRow, cfg: Env): Promise<string> {
  if (repo.branch && !checkBranch(repo.branch)) throw new Error("Invalid branch name.");

  if (repo.source_type === "local") {
    const r = resolveLocalRepo(repo.source, cfg.LOCAL_REPO_ROOT);
    if (!r.ok) throw new Error(r.error);
    return path.resolve(cfg.LOCAL_REPO_ROOT, r.normalized);
  }

  const r = checkRemoteUrl(repo.source, cfg.ALLOWED_GIT_HOSTS);
  if (!r.ok) throw new Error(r.error);
  const dir = path.resolve(cfg.WORKSPACE_DIR, `repo-${repo.id}.git`);
  const timeoutMs = cfg.GIT_CLONE_TIMEOUT_MS;

  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    const args = ["clone", "--bare", "--single-branch", "--no-tags"];
    if (repo.branch) args.push("--branch", repo.branch);
    await git([...args, "--", r.normalized, dir], { timeoutMs });
  } else {
    const head = repo.branch
      ? `refs/heads/${repo.branch}`
      : (await git(["symbolic-ref", "HEAD"], { cwd: dir })).trim();
    await git(["fetch", "--prune", "--no-tags", "origin", `+${head}:${head}`], { cwd: dir, timeoutMs });
  }
  return dir;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Mines one repository and replaces all of its derived data in PostgreSQL in a
 * single transaction, so readers see either the previous analysis or the new
 * one, never a mixture.
 */
export async function analyzeRepository(
  pool: Pool,
  repo: RepoRow,
  cfg: Env,
  progress: Progress,
  isCancelled: () => Promise<boolean>,
): Promise<AnalysisStats> {
  const started = Date.now();
  const checkpoint = async () => {
    if (await isCancelled()) throw new CancelledError("Analysis was cancelled.");
  };

  await progress("fetch", 5, repo.source_type === "remote" ? "Cloning / fetching" : "Opening local repository");
  const cwd = await prepareWorkdir(repo, cfg);
  const ref = repo.branch ? `refs/heads/${repo.branch}` : "HEAD";
  const headSha = (await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd })).trim();
  await checkpoint();

  await progress("log", 20, "Reading commit history");
  const logOut = await git(
    ["log", `--format=${LOG_FORMAT}`, "--raw", "--numstat", "-M", "--no-abbrev", "--no-color",
     `--max-count=${cfg.ANALYSIS_MAX_COMMITS + 1}`, headSha, "--"],
    { cwd },
  );
  let commits = parseLog(logOut);
  const truncated = commits.length > cfg.ANALYSIS_MAX_COMMITS;
  if (truncated) commits = commits.slice(0, cfg.ANALYSIS_MAX_COMMITS);
  const headFiles = new Set(parseLsTree(await git(["ls-tree", "-r", "-z", "--name-only", headSha], { cwd })));
  await checkpoint();

  await progress("hunks", 35, "Reading line-level hunks");
  const hunks = parseHunks(
    await git(
      ["log", "-p", "-U0", "--format=%x1e%H", "-M", "--no-color", "--no-ext-diff",
       `--max-count=${cfg.HUNK_MAX_COMMITS}`, headSha, "--"],
      { cwd },
    ),
  );
  await checkpoint();

  // Blame the most frequently changed text files that still exist at HEAD.
  await progress("blame", 50, "Computing code ownership");
  const revisions = new Map<string, number>();
  const binary = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      revisions.set(f.path, (revisions.get(f.path) ?? 0) + 1);
      if (f.insertions === null) binary.add(f.path);
    }
  }
  const blameTargets = [...headFiles]
    .filter((p) => !binary.has(p))
    .sort((a, b) => (revisions.get(b) ?? 0) - (revisions.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, cfg.BLAME_MAX_FILES);
  const blames = await mapLimit(blameTargets, 4, async (p) => {
    try {
      const out = await git(["blame", "--line-porcelain", "-w", headSha, "--", p], { cwd, timeoutMs: 60_000 });
      return [p, parseBlame(out)] as const;
    } catch {
      return [p, new Map<string, number>()] as const; // unreadable file: skip, do not fail the job
    }
  });
  await checkpoint();

  await progress("store", 70, "Writing to PostgreSQL");
  const client = await pool.connect();
  let stats: Omit<AnalysisStats, "durationMs">;
  try {
    await client.query("BEGIN");
    stats = await store(client, repo.id, cfg, headSha, commits, headFiles, hunks, blames, truncated);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_activity");

  return { ...stats, durationMs: Date.now() - started };
}

async function store(
  db: PoolClient,
  repoId: number,
  cfg: Env,
  headSha: string,
  commits: ParsedCommit[],
  headFiles: Set<string>,
  hunks: ReturnType<typeof parseHunks>,
  blames: (readonly [string, Map<string, number>])[],
  truncated: boolean,
): Promise<Omit<AnalysisStats, "durationMs">> {
  // Full rebuild: drop the previous analysis. Deleting developers cascades to
  // commits, and from there to file_changes, hunks and commit_embeddings.
  await db.query("DELETE FROM coupling_edges WHERE repository_id = $1", [repoId]);
  await db.query("DELETE FROM developers WHERE repository_id = $1", [repoId]);
  await db.query("DELETE FROM files WHERE repository_id = $1", [repoId]);

  // Developers, keyed by lower-cased e-mail; the most recent name wins
  // (git log lists newest commits first).
  const devNames = new Map<string, string>();
  for (const c of commits) if (!devNames.has(c.authorEmail)) devNames.set(c.authorEmail, c.authorName);
  for (const [, owners] of blames) for (const e of owners.keys()) if (!devNames.has(e)) devNames.set(e, e);
  const devIds = new Map<string, number>();
  for (const part of chunks([...devNames])) {
    const res = await db.query<{ id: string; email: string }>(
      `INSERT INTO developers (repository_id, email, name)
       SELECT $1, e, n FROM unnest($2::text[], $3::text[]) AS t(e, n)
       RETURNING id, email`,
      [repoId, part.map((d) => d[0]), part.map((d) => d[1])],
    );
    for (const r of res.rows) devIds.set(r.email, Number(r.id));
  }

  // Commits
  const commitIds = new Map<string, number>();
  for (const part of chunks(commits)) {
    const res = await db.query<{ id: string; sha: string }>(
      `INSERT INTO commits (repository_id, sha, author_id, authored_at, committed_at,
                            parent_count, subject, body, files_changed, insertions, deletions)
       SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::timestamptz[], $5::timestamptz[],
                                $6::smallint[], $7::text[], $8::text[], $9::int[], $10::int[], $11::int[])
       RETURNING id, sha`,
      [
        repoId,
        part.map((c) => c.sha),
        part.map((c) => devIds.get(c.authorEmail)),
        part.map((c) => c.authoredAt),
        part.map((c) => c.committedAt),
        part.map((c) => c.parents.length),
        part.map((c) => c.subject),
        part.map((c) => c.body),
        part.map((c) => c.files.length),
        part.map((c) => c.files.reduce((s, f) => s + (f.insertions ?? 0), 0)),
        part.map((c) => c.files.reduce((s, f) => s + (f.deletions ?? 0), 0)),
      ],
    );
    for (const r of res.rows) commitIds.set(r.sha, Number(r.id));
  }

  // Files: everything that appears in history or at HEAD.
  const paths = new Set<string>(headFiles);
  for (const c of commits) for (const f of c.files) paths.add(f.path);
  const fileIds = new Map<string, number>();
  for (const part of chunks([...paths])) {
    const res = await db.query<{ id: string; path: string }>(
      `INSERT INTO files (repository_id, path, exists_at_head)
       SELECT $1, p, h FROM unnest($2::text[], $3::bool[]) AS t(p, h)
       RETURNING id, path`,
      [repoId, part, part.map((p) => headFiles.has(p))],
    );
    for (const r of res.rows) fileIds.set(r.path, Number(r.id));
  }

  // File changes (deduplicated per commit/file).
  type FC = [number, number, string, string | null, number | null, number | null];
  const changeRows: FC[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    const cid = commitIds.get(c.sha)!;
    for (const f of c.files) {
      const fid = fileIds.get(f.path)!;
      const key = `${cid}:${fid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changeRows.push([cid, fid, f.change, f.oldPath, f.insertions, f.deletions]);
    }
  }
  for (const part of chunks(changeRows)) {
    await db.query(
      `INSERT INTO file_changes (commit_id, file_id, change, old_path, insertions, deletions)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::change_kind[], $4::text[], $5::int[], $6::int[])`,
      [0, 1, 2, 3, 4, 5].map((i) => part.map((r) => r[i])),
    );
  }

  // Hunks (only for commits and files we stored).
  const hunkRows = hunks.flatMap((h) => {
    const cid = commitIds.get(h.sha);
    const fid = fileIds.get(h.path);
    return cid && fid ? [[cid, fid, h.oldStart, h.oldLines, h.newStart, h.newLines]] : [];
  });
  for (const part of chunks(hunkRows)) {
    await db.query(
      `INSERT INTO hunks (commit_id, file_id, old_start, old_lines, new_start, new_lines)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::int[], $5::int[], $6::int[])`,
      [0, 1, 2, 3, 4, 5].map((i) => part.map((r) => r[i])),
    );
  }

  // Change coupling over non-merge commits.
  const edges = computeCoupling(
    commits.filter((c) => c.parents.length <= 1).map((c) => c.files.map((f) => fileIds.get(f.path)!)),
    { maxFilesPerCommit: cfg.COUPLING_MAX_FILES_PER_COMMIT, minCochanges: cfg.COUPLING_MIN_COCHANGE },
  );
  for (const part of chunks(edges)) {
    await db.query(
      `INSERT INTO coupling_edges (repository_id, file_a_id, file_b_id, cochanges,
                                   confidence_ab, confidence_ba, jaccard)
       SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::int[], $5::real[], $6::real[], $7::real[])`,
      [
        repoId,
        part.map((e) => e.a),
        part.map((e) => e.b),
        part.map((e) => e.cochanges),
        part.map((e) => e.confidenceAB),
        part.map((e) => e.confidenceBA),
        part.map((e) => e.jaccard),
      ],
    );
  }

  // Ownership
  const ownRows = blames.flatMap(([p, owners]) =>
    [...owners].map(([email, lines]) => [fileIds.get(p)!, devIds.get(email)!, lines] as const),
  );
  for (const part of chunks(ownRows)) {
    await db.query(
      `INSERT INTO file_ownership (file_id, developer_id, lines)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[])`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])],
    );
  }

  // Commit-message vectors
  const vecRows: [number, string][] = [];
  for (const c of commits) {
    const v = embed(`${c.subject}\n${c.body}`);
    if (v) vecRows.push([commitIds.get(c.sha)!, toPgVector(v)]);
  }
  for (const part of chunks(vecRows, 500)) {
    await db.query(
      `INSERT INTO commit_embeddings (commit_id, embedding)
       SELECT id, v::vector FROM unnest($1::bigint[], $2::text[]) AS t(id, v)`,
      [part.map((r) => r[0]), part.map((r) => r[1])],
    );
  }

  await db.query("UPDATE repositories SET head_sha = $2 WHERE id = $1", [repoId, headSha]);

  return {
    headSha,
    commits: commits.length,
    truncated,
    developers: devIds.size,
    files: fileIds.size,
    fileChanges: changeRows.length,
    hunks: hunkRows.length,
    couplingEdges: edges.length,
    blamedFiles: blames.filter(([, o]) => o.size > 0).length,
    embeddings: vecRows.length,
  };
}
