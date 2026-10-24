// End-to-end test of the analysis pipeline and schema against a real
// PostgreSQL + pgvector database (TEST_DATABASE_URL). Recreate that database
// with `npm run db:reset -- --test` first. Skipped when it is unreachable.
import "../../scripts/load-env";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeRepository } from "@/lib/analysis/pipeline";
import { embed, toPgVector } from "@/lib/analysis/embedding";
import { migrate } from "@/lib/migrate";
import { CORE_CONTRIBUTORS_SQL, SHARED_FILES_SQL } from "@/lib/queries";
import type { Env } from "@/lib/env";
import { AUTHORS, FIXTURE_COMMITS, createFixtureRepo } from "@/scripts/fixture-repo";

const url = process.env.TEST_DATABASE_URL;
const reachable = await (async () => {
  if (!url) return false;
  const p = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
})();

describe.skipIf(!reachable)("analysis pipeline (PostgreSQL)", () => {
  let pool: Pool;
  let root: string;
  let repoId: number;
  let cfg: Env;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as T;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
    // clean slate (the protect_last_admin trigger must be bypassed for the reset)
    await pool.query("ALTER TABLE users DISABLE TRIGGER users_protect_last_admin");
    await pool.query("TRUNCATE users, repositories, audit_log RESTART IDENTITY CASCADE");
    await pool.query("ALTER TABLE users ENABLE TRIGGER users_protect_last_admin");

    root = fs.mkdtempSync(path.join(os.tmpdir(), "grf-int-"));
    createFixtureRepo(path.join(root, "demo"));
    cfg = {
      DATABASE_URL: url!, NEO4J_URI: "", NEO4J_USER: "", NEO4J_PASSWORD: "", REDIS_URL: "",
      ALLOW_SELF_REGISTRATION: true, SESSION_TTL_HOURS: 12, ALLOWED_GIT_HOSTS: ["github.com"],
      LOCAL_REPO_ROOT: root, WORKSPACE_DIR: path.join(root, ".ws"),
      COUPLING_MAX_FILES_PER_COMMIT: 30, COUPLING_MIN_COCHANGE: 2, ANALYSIS_MAX_COMMITS: 50000,
      GIT_CLONE_TIMEOUT_MS: 60000, BLAME_MAX_FILES: 150, HUNK_MAX_COMMITS: 3000, WORKER_POLL_INTERVAL_MS: 1000,
    };
    repoId = (await one<{ id: number }>(
      "INSERT INTO repositories (name, source_type, source) VALUES ('demo', 'local', 'demo') RETURNING id::int",
    )).id;
  });

  afterAll(async () => {
    await pool?.end();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const run = () =>
    analyzeRepository(pool, { id: repoId, name: "demo", source_type: "local", source: "demo", branch: null },
      cfg, async () => {}, async () => false);

  it("stores commits, developers, files and changes", async () => {
    const stats = await run();
    expect(stats.commits).toBe(FIXTURE_COMMITS);
    expect(stats.developers).toBe(3);

    const c = await one<{ n: number; merges: number }>(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE is_merge)::int AS merges FROM commits WHERE repository_id = $1",
      [repoId]);
    expect(c).toEqual({ n: FIXTURE_COMMITS, merges: 1 });

    const devs = (await pool.query(
      "SELECT email FROM developers WHERE repository_id = $1 ORDER BY email", [repoId])).rows.map((r) => r.email);
    expect(devs).toEqual(Object.values(AUTHORS).map((a) => a.email).sort());

    const rename = await one(
      `SELECT fc.change, fc.old_path FROM file_changes fc JOIN files f ON f.id = fc.file_id
        WHERE f.repository_id = $1 AND f.path = 'src/database.ts' AND fc.change = 'R'`, [repoId]);
    expect(rename).toEqual({ change: "R", old_path: "src/db.ts" });

    const binary = await one(
      `SELECT fc.insertions FROM file_changes fc JOIN files f ON f.id = fc.file_id
        WHERE f.repository_id = $1 AND f.path = 'logo.png'`, [repoId]);
    expect(binary).toEqual({ insertions: null });

    const head = await one<{ alive: boolean }>(
      "SELECT exists_at_head AS alive FROM files WHERE repository_id = $1 AND path = 'generated/file0.ts'", [repoId]);
    expect(head.alive).toBe(false);
  });

  it("computes change coupling with the expected metrics, excluding the bulk commit", async () => {
    const e = await one<{ cochanges: number; jaccard: number; confidence_ab: number }>(
      `SELECT e.cochanges, e.jaccard, e.confidence_ab
         FROM coupling_edges e JOIN files a ON a.id = e.file_a_id JOIN files b ON b.id = e.file_b_id
        WHERE e.repository_id = $1
          AND ((a.path, b.path) = ('src/api.ts', 'src/api.test.ts') OR (a.path, b.path) = ('src/api.test.ts', 'src/api.ts'))`,
      [repoId]);
    // api.ts changed in commits 1, 2, 4, 5, 6 and api.test.ts in 1, 2, 4.
    expect(e.cochanges).toBe(3);
    expect(e.jaccard).toBeCloseTo(3 / 5);

    const generated = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM coupling_edges e JOIN files f ON f.id = e.file_a_id
        WHERE e.repository_id = $1 AND f.path LIKE 'generated/%'`, [repoId]);
    expect(generated.n).toBe(0);
  });

  it("computes ownership, the bus factor and the reporting views", async () => {
    const owners = (await pool.query(
      `SELECT d.email, o.lines FROM file_ownership o
         JOIN files f ON f.id = o.file_id JOIN developers d ON d.id = o.developer_id
        WHERE f.repository_id = $1 AND f.path = 'src/api.ts' ORDER BY d.email`, [repoId])).rows;
    expect(owners.reduce((s, r) => s + r.lines, 0)).toBe(5);

    const bf = await one<{ bus_factor: number }>("SELECT bus_factor($1) AS bus_factor", [repoId]);
    expect(bf.bus_factor).toBeGreaterThanOrEqual(1);
    expect(bf.bus_factor).toBeLessThanOrEqual(3);

    const hot = await one<{ path: string }>(
      "SELECT path FROM file_hotspots WHERE repository_id = $1 ORDER BY revisions DESC, path LIMIT 1", [repoId]);
    expect(hot.path).toBe("src/api.ts");

    const month = await one<{ commits: number }>(
      "SELECT commits::int FROM monthly_activity WHERE repository_id = $1", [repoId]);
    expect(month.commits).toBe(FIXTURE_COMMITS);
  });

  it("supports full-text and vector search over commit messages", async () => {
    const fts = (await pool.query(
      `SELECT subject FROM commits WHERE repository_id = $1
         AND to_tsvector('english', subject || ' ' || body) @@ websearch_to_tsquery('english', 'renaming database')`,
      [repoId])).rows;
    expect(fts.map((r) => r.subject)).toEqual(["Rename db module to database"]);

    const near = await one<{ subject: string }>(
      `SELECT c.subject FROM commit_embeddings e JOIN commits c ON c.id = e.commit_id
        WHERE c.repository_id = $1 ORDER BY e.embedding <=> $2::vector LIMIT 1`,
      [repoId, toPgVector(embed("put endpoint API test")!)]);
    expect(near.subject).toBe("Add put endpoint to API with test");
  });

  it("finds core contributors and shared files with GROUP BY … HAVING, ignoring bots", async () => {
    // Alice 5 commits, Bob 4, Carol 3: the average is 4.
    const core = (await pool.query(CORE_CONTRIBUTORS_SQL, [repoId])).rows;
    expect(core.map((r) => [r.name, r.commits])).toEqual([[AUTHORS.alice.name, 5], [AUTHORS.bob.name, 4]]);
    expect(core[0].avg_commits).toBeCloseTo(4);
    expect(core[0].share).toBeCloseTo(5 / FIXTURE_COMMITS);

    const shared = (await pool.query(SHARED_FILES_SQL, [repoId, 3])).rows;
    expect(shared[0]).toMatchObject({ path: "src/api.ts", authors: 3 });
    expect(shared.every((r) => r.authors >= 3)).toBe(true);

    // A bot with many commits is flagged by the generated column and changes neither report.
    const bot = await one<{ id: number; is_bot: boolean }>(
      `INSERT INTO developers (repository_id, email, name)
       VALUES ($1, '49699333+dependabot[bot]@users.noreply.github.com', 'dependabot[bot]')
       RETURNING id::int, is_bot`, [repoId]);
    expect(bot.is_bot).toBe(true);
    await pool.query(
      `INSERT INTO commits (repository_id, sha, author_id, authored_at, committed_at, parent_count, subject)
       SELECT $1, lpad(to_hex(n), 40, 'f'), $2, now(), now(), 1, 'Bump dependency'
         FROM generate_series(1, 20) AS n`, [repoId, bot.id]);
    const coreAfter = (await pool.query(CORE_CONTRIBUTORS_SQL, [repoId])).rows;
    expect(coreAfter.map((r) => r.name)).toEqual([AUTHORS.alice.name, AUTHORS.bob.name]);
    const human = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM developers WHERE repository_id = $1 AND NOT is_bot", [repoId]);
    expect(human.n).toBe(3);
  });

  it("applies schema change 002: ALTER constraints, replaced index and the stored procedure", async () => {
    await expect(pool.query("INSERT INTO audit_log (action) VALUES ('Bad Action!')"))
      .rejects.toMatchObject({ code: "23514" });

    const idx = (await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'commits' AND indexname LIKE 'commits_author%'")).rows;
    expect(idx.map((r) => r.indexname)).toEqual(["commits_author_time_idx"]);

    const u = await one<{ id: number }>(
      "INSERT INTO users (email, display_name, password_hash) VALUES ('s@example.com', 'S', 'x') RETURNING id::int");
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES
         ('expired', $1, now() - interval '2 days', now() - interval '1 day'),
         ('live',    $1, now(),                     now() + interval '1 day')`, [u.id]);
    const purge = await one<{ removed: number }>("CALL purge_expired_sessions()");
    expect(purge.removed).toBe(1);
    const left = (await pool.query("SELECT token_hash FROM sessions WHERE user_id = $1", [u.id])).rows;
    expect(left.map((r) => r.token_hash)).toEqual(["live"]);
  });

  it("replaces, rather than duplicates, data on re-analysis", async () => {
    await run();
    const c = await one<{ n: number }>("SELECT count(*)::int AS n FROM commits WHERE repository_id = $1", [repoId]);
    expect(c.n).toBe(FIXTURE_COMMITS);
  });

  it("enforces the schema's business rules", async () => {
    // one active job per repository
    await pool.query("INSERT INTO analysis_jobs (repository_id) VALUES ($1)", [repoId]);
    await expect(pool.query("INSERT INTO analysis_jobs (repository_id) VALUES ($1)", [repoId]))
      .rejects.toMatchObject({ code: "23505" });

    // coupling pairs must be ordered
    const [f1, f2] = (await pool.query("SELECT id FROM files WHERE repository_id = $1 ORDER BY id LIMIT 2", [repoId]))
      .rows.map((r) => r.id);
    await expect(pool.query(
      `INSERT INTO coupling_edges (repository_id, file_a_id, file_b_id, cochanges, confidence_ab, confidence_ba, jaccard)
       VALUES ($1, $2, $3, 1, 1, 1, 1)`, [repoId, f2, f1])).rejects.toMatchObject({ code: "23514" });

    // the last active administrator cannot be demoted
    const admin = await one<{ id: number }>(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ('root@example.com', 'Root', 'x', 'admin') RETURNING id::int`);
    await expect(pool.query("UPDATE users SET role = 'analyst' WHERE id = $1", [admin.id]))
      .rejects.toThrow(/last active administrator/);
    await expect(pool.query("INSERT INTO users (email, display_name, password_hash) VALUES ('ROOT@example.com', 'Dup', 'x')"))
      .rejects.toMatchObject({ code: "23505" });

    // deleting a repository cascades to everything mined from it
    await pool.query("DELETE FROM repositories WHERE id = $1", [repoId]);
    const left = await one<{ n: number }>(
      `SELECT (SELECT count(*) FROM commits) + (SELECT count(*) FROM files) + (SELECT count(*) FROM developers)
            + (SELECT count(*) FROM coupling_edges) + (SELECT count(*) FROM commit_embeddings) AS n`);
    expect(Number(left.n)).toBe(0);
  });
});
