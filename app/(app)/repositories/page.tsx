import Link from "next/link";
import { AddRepositoryForm } from "@/components/Actions";
import { StatusBadge } from "@/components/JobPanel";
import { env } from "@/lib/env";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { listRepositories } from "@/lib/queries";

export default async function RepositoriesPage() {
  const repos = await listRepositories();
  const cfg = env();
  return (
    <div className="space-y-6">
      <h1>Repositories</h1>
      <section className="card">
        <h2 className="mb-3">Add a repository</h2>
        <AddRepositoryForm allowedHosts={cfg.ALLOWED_GIT_HOSTS} localRoot={cfg.LOCAL_REPO_ROOT} />
      </section>
      <section className="card overflow-x-auto">
        {repos.length === 0 ? (
          <p className="text-sm text-slate-500">No repositories yet. Add one above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th className="num">Commits</th>
                <th>Last analysed</th>
                <th>Latest job</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/repositories/${r.id}`}>{r.name}</Link></td>
                  <td className="font-mono text-xs">
                    {r.source_type === "local" ? `local: ${r.source}` : r.source}
                    {r.branch && <span className="text-slate-500"> @ {r.branch}</span>}
                  </td>
                  <td className="num">{fmtInt(r.commits)}</td>
                  <td>{fmtDateTime(r.last_analyzed_at)}</td>
                  <td><StatusBadge status={r.job_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
