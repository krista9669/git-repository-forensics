// Background worker: claims queued analysis jobs from PostgreSQL and runs them.
//
// Jobs are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so any number of
// workers can poll the same table without two of them taking the same job.
// Run with `npm run worker`.
import "../scripts/load-env";
import os from "node:os";
import { env } from "../lib/env";
import { pool } from "../lib/db";
import { neo4jDriver } from "../lib/neo4j";
import { invalidateRepo, setProgress, redis } from "../lib/redis";
import { analyzeRepository, CancelledError, type RepoRow } from "../lib/analysis/pipeline";
import { projectRepository } from "../lib/graph/projection";

const workerId = `${os.hostname()}:${process.pid}`;
const host = `${os.hostname()}:`;
let stopping = false;

async function claimJob(): Promise<{ id: number; repository_id: number } | null> {
  const res = await pool().query(
    `UPDATE analysis_jobs
        SET status = 'running', started_at = now(), worker_id = $1
      WHERE id = (SELECT id FROM analysis_jobs
                   WHERE status = 'queued'
                   ORDER BY created_at
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
      RETURNING id::int, repository_id::int`,
    [workerId],
  );
  return res.rows[0] ?? null;
}

async function finish(jobId: number, status: "succeeded" | "failed", fields: { error?: string; stats?: unknown }) {
  // Only move a job that is still running; a cancelled job keeps its status.
  await pool().query(
    `UPDATE analysis_jobs SET status = $2, finished_at = now(), error = $3, stats = $4
      WHERE id = $1 AND status = 'running'`,
    [jobId, status, fields.error?.slice(0, 2000) ?? null, fields.stats ? JSON.stringify(fields.stats) : null],
  );
}

async function runJob(job: { id: number; repository_id: number }) {
  const cfg = env();
  const repo = (await pool().query<RepoRow>(
    "SELECT id::int, name, source_type, source, branch FROM repositories WHERE id = $1",
    [job.repository_id],
  )).rows[0];
  if (!repo) return finish(job.id, "failed", { error: "Repository no longer exists." });

  console.log(`[worker] job ${job.id}: analysing "${repo.name}"`);
  const progress = (stage: string, percent: number, message?: string) =>
    setProgress(job.id, { stage, percent, message });
  const isCancelled = async () => {
    const r = await pool().query("SELECT status FROM analysis_jobs WHERE id = $1", [job.id]);
    return r.rows[0]?.status === "cancelled";
  };

  try {
    const stats: Record<string, unknown> = await analyzeRepository(pool(), repo, cfg, progress, isCancelled);
    await progress("graph", 90, "Projecting into Neo4j");
    try {
      await projectRepository(pool(), neo4jDriver(), repo.id);
    } catch (e) {
      // The relational analysis is complete and usable; only graph views are affected.
      stats.graphError = (e as Error).message;
      console.warn(`[worker] job ${job.id}: Neo4j projection failed: ${stats.graphError}`);
    }
    await invalidateRepo(repo.id);
    await finish(job.id, "succeeded", { stats });
    await progress("done", 100);
    console.log(`[worker] job ${job.id}: done`, stats);
  } catch (e) {
    if (e instanceof CancelledError) {
      console.log(`[worker] job ${job.id}: cancelled`);
      await progress("cancelled", 100);
      return;
    }
    const msg = (e as Error).message || String(e);
    console.error(`[worker] job ${job.id}: failed: ${msg}`);
    await progress("failed", 100, msg);
    await finish(job.id, "failed", { error: msg });
  }
}

async function main() {
  const cfg = env();
  console.log(`[worker] ${workerId} started; polling every ${cfg.WORKER_POLL_INTERVAL_MS} ms`);

  // Jobs left "running" by an earlier worker process on this machine died with it.
  const stale = await pool().query(
    `UPDATE analysis_jobs SET status = 'failed', finished_at = now(),
            error = 'The worker stopped before the analysis finished.'
      WHERE status = 'running' AND worker_id LIKE $1 || '%' AND worker_id <> $2`,
    [host, workerId],
  );
  if (stale.rowCount) console.log(`[worker] marked ${stale.rowCount} interrupted job(s) as failed`);

  while (!stopping) {
    let job = null;
    try {
      job = await claimJob();
      if (job) await runJob(job);
    } catch (e) {
      console.error("[worker] poll error:", (e as Error).message);
    }
    if (!job) await new Promise((r) => setTimeout(r, cfg.WORKER_POLL_INTERVAL_MS));
  }
  await pool().end();
  await neo4jDriver().close();
  redis().disconnect();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received; finishing current job then exiting`);
    stopping = true;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
