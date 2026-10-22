import { HttpError, intParam, json, route } from "@/lib/api";
import { queryOne } from "@/lib/db";
import { getProgress } from "@/lib/redis";

type Ctx = { params: Promise<{ id: string }> };

/** Job status from PostgreSQL plus live progress from Redis; polled by the UI. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const id = intParam((await params).id);
  const job = await queryOne(
    `SELECT id::int, repository_id::int, status, created_at, started_at, finished_at, error, stats
       FROM analysis_jobs WHERE id = $1`,
    [id],
  );
  if (!job) throw new HttpError(404, "Job not found.");
  return json({ job, progress: await getProgress(id) });
});
