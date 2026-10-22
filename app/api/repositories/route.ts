import { z } from "zod";
import { audit } from "@/lib/auth";
import { HttpError, json, parseBody, route } from "@/lib/api";
import { transaction } from "@/lib/db";
import { env } from "@/lib/env";
import { listRepositories } from "@/lib/queries";
import { checkBranch, checkRemoteUrl, resolveLocalRepo } from "@/lib/repo-source";

export const GET = route(async () => json({ repositories: await listRepositories() }));

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  sourceType: z.enum(["remote", "local"]),
  source: z.string().trim().min(1).max(500),
  branch: z.string().trim().max(200).optional().transform((b) => b || null),
  analyzeNow: z.boolean().default(true),
});

/** Registers a repository and (by default) queues its first analysis. */
export const POST = route(async (req, { user }) => {
  const body = await parseBody(req, Body);
  const cfg = env();
  const check =
    body.sourceType === "remote"
      ? checkRemoteUrl(body.source, cfg.ALLOWED_GIT_HOSTS)
      : resolveLocalRepo(body.source, cfg.LOCAL_REPO_ROOT);
  if (!check.ok) throw new HttpError(400, check.error);
  if (body.branch && !checkBranch(body.branch)) throw new HttpError(400, "Invalid branch name.");

  const repo = await transaction(async (db) => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO repositories (name, source_type, source, branch, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::int`,
      [body.name, body.sourceType, check.normalized, body.branch, user.id],
    );
    const id = r.rows[0].id;
    if (body.analyzeNow) {
      await db.query("INSERT INTO analysis_jobs (repository_id, requested_by) VALUES ($1, $2)", [id, user.id]);
    }
    await audit(user.id, "repository_created", { type: "repository", id }, { source: check.normalized }, db);
    return { id };
  });
  return json(repo, 201);
});
