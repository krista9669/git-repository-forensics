import fs from "node:fs";
import path from "node:path";
import { audit } from "@/lib/auth";
import { HttpError, intParam, json, route } from "@/lib/api";
import { query } from "@/lib/db";
import { env } from "@/lib/env";
import { neo4jDriver } from "@/lib/neo4j";
import { deleteRepositoryGraph } from "@/lib/graph/projection";
import { getRepository, listJobs, repoSummary } from "@/lib/queries";
import { invalidateRepo } from "@/lib/redis";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const id = intParam((await params).id);
  const repo = await getRepository(id);
  if (!repo) throw new HttpError(404, "Repository not found.");
  return json({ repository: repo, summary: await repoSummary(id), jobs: await listJobs(id) });
});

/** Deletes a repository and everything mined from it. Owner or admin only. */
export const DELETE = route<Ctx>(async (_req, { params, user }) => {
  const id = intParam((await params).id);
  const repo = await getRepository(id);
  if (!repo) throw new HttpError(404, "Repository not found.");
  if (user.role !== "admin" && repo.created_by !== user.id) {
    throw new HttpError(403, "Only the person who added this repository, or an administrator, can delete it.");
  }
  const running = await query("SELECT 1 FROM analysis_jobs WHERE repository_id = $1 AND status = 'running'", [id]);
  if (running.length) throw new HttpError(409, "Wait for the running analysis to finish (or cancel it) first.");

  await query("DELETE FROM repositories WHERE id = $1", [id]);
  await audit(user.id, "repository_deleted", { type: "repository", id }, { name: repo.name });
  await invalidateRepo(id);
  await deleteRepositoryGraph(neo4jDriver(), id).catch((e) => console.warn("[neo4j]", e.message));
  if (repo.source_type === "remote") {
    fs.rmSync(path.resolve(env().WORKSPACE_DIR, `repo-${id}.git`), { recursive: true, force: true });
  }
  return json({ ok: true });
});
