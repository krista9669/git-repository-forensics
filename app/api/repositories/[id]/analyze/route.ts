import { audit } from "@/lib/auth";
import { HttpError, intParam, json, route } from "@/lib/api";
import { queryOne } from "@/lib/db";
import { getRepository } from "@/lib/queries";

type Ctx = { params: Promise<{ id: string }> };

/** Queues a (re-)analysis. The partial unique index rejects a second active job. */
export const POST = route<Ctx>(async (_req, { params, user }) => {
  const id = intParam((await params).id);
  if (!(await getRepository(id))) throw new HttpError(404, "Repository not found.");
  const job = await queryOne<{ id: number }>(
    `INSERT INTO analysis_jobs (repository_id, requested_by) VALUES ($1, $2)
     ON CONFLICT (repository_id) WHERE status IN ('queued', 'running') DO NOTHING
     RETURNING id::int`,
    [id, user.id],
  );
  if (!job) throw new HttpError(409, "An analysis of this repository is already queued or running.");
  await audit(user.id, "analysis_requested", { type: "repository", id });
  return json(job, 201);
});
