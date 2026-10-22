import { HttpError, intParam, json, route } from "@/lib/api";
import * as q from "@/lib/queries";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/repositories/:id/report?kind=...
 *   summary | monthly | developers | hotspots | coupling[&minJaccard=0.3]
 *   commits[&q=text]   full-text search (recent commits without q)
 *   similar&q=text     pgvector similarity on commit messages
 *   collaboration | silos   (Neo4j)
 */
export const GET = route<Ctx>(async (req, { params }) => {
  const id = intParam((await params).id);
  if (!(await q.getRepository(id))) throw new HttpError(404, "Repository not found.");
  const sp = new URL(req.url).searchParams;
  const text = (sp.get("q") ?? "").slice(0, 500);

  switch (sp.get("kind")) {
    case "summary": return json(await q.repoSummary(id));
    case "monthly": return json(await q.monthlyActivity(id));
    case "developers": return json(await q.developers(id));
    case "hotspots": return json(await q.hotspots(id));
    case "coupling": {
      const min = Number(sp.get("minJaccard") ?? 0);
      if (!(min >= 0 && min <= 1)) throw new HttpError(400, "minJaccard must be between 0 and 1.");
      return json(await q.coupling(id, min));
    }
    case "commits": return json(text ? await q.searchCommits(id, text) : await q.recentCommits(id));
    case "similar":
      if (!text) throw new HttpError(400, "q is required.");
      return json(await q.similarCommits(id, text));
    case "collaboration": return json(await q.collaboration(id));
    case "silos": return json(await q.knowledgeSilos(id));
    default: throw new HttpError(400, "Unknown report kind.");
  }
});
