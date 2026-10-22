import { audit } from "@/lib/auth";
import { HttpError, intParam, json, route } from "@/lib/api";
import { queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** Marks a queued or running job cancelled; a running worker notices at its next checkpoint. */
export const POST = route<Ctx>(async (_req, { params, user }) => {
  const id = intParam((await params).id);
  const job = await queryOne<{ repository_id: number }>(
    `UPDATE analysis_jobs SET status = 'cancelled', finished_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING repository_id::int`,
    [id],
  );
  if (!job) throw new HttpError(409, "Only queued or running jobs can be cancelled.");
  await audit(user.id, "analysis_cancelled", { type: "analysis_job", id });
  return json({ ok: true });
});
