import Link from "next/link";
import { notFound } from "next/navigation";
import { HunkHeatmap } from "@/components/ActivityChart";
import { fmtDate, fmtInt, fmtPct, shortSha } from "@/lib/format";
import * as q from "@/lib/queries";

type Props = { params: Promise<{ id: string; fileId: string }> };

export default async function FilePage({ params }: Props) {
  const p = await params;
  const repoId = Number(p.id);
  const fileId = Number(p.fileId);
  if (![repoId, fileId].every((n) => Number.isSafeInteger(n) && n > 0)) notFound();
  const [repo, file] = await Promise.all([q.getRepository(repoId), q.getFile(repoId, fileId)]);
  if (!repo || !file) notFound();

  const [history, owners, coupled, heat] = await Promise.all([
    q.fileHistory(fileId),
    q.fileOwners(fileId),
    q.coupledFiles(fileId),
    q.hunkHeatmap(fileId),
  ]);
  let reviewers: q.Reviewer[] = [];
  let graphError: string | null = null;
  try {
    reviewers = await q.suggestReviewers(fileId);
  } catch (e) {
    graphError = (e as Error).message;
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm"><Link href={`/repositories/${repoId}?tab=hotspots`}>← {repo.name}</Link></p>
        <h1 className="break-all font-mono text-xl">{file.path}</h1>
        {!file.exists_at_head && <p className="text-sm text-amber-700">This file no longer exists at HEAD.</p>}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-3">Owners at HEAD (git blame)</h2>
          {owners.length === 0 ? (
            <p className="text-sm text-slate-500">Not blamed (binary, deleted, or outside the blame limit).</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {owners.map((o) => (
                <li key={o.developer_id}>
                  <div className="flex justify-between"><span>{o.name}</span><span className="tabular-nums">{fmtInt(o.lines)} lines · {fmtPct(o.share)}</span></div>
                  <div className="h-1.5 rounded bg-slate-100"><div className="h-full rounded bg-indigo-500" style={{ width: `${o.share * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="mb-1">Suggested reviewers</h2>
          <p className="mb-3 text-xs text-slate-500">
            From Neo4j: people who changed this file or files strongly coupled to it, weighted by commits × coupling.
          </p>
          {graphError ? (
            <p className="error">Graph unavailable: {graphError}</p>
          ) : reviewers.length === 0 ? (
            <p className="text-sm text-slate-500">No suggestions.</p>
          ) : (
            <table className="table">
              <thead><tr><th>Developer</th><th className="num">Score</th><th>Via</th></tr></thead>
              <tbody>
                {reviewers.map((r) => (
                  <tr key={r.email}>
                    <td>{r.developer}</td>
                    <td className="num">{r.score}</td>
                    <td className="font-mono text-xs">{r.via.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="mb-1">Coupled files</h2>
        <p className="mb-3 text-xs text-slate-500">Confidence: how often the other file changes when this one does.</p>
        {coupled.length === 0 ? (
          <p className="text-sm text-slate-500">No files are coupled to this one.</p>
        ) : (
          <table className="table">
            <thead><tr><th>File</th><th className="num">Co-changes</th><th className="num">Confidence</th><th className="num">Jaccard</th></tr></thead>
            <tbody>
              {coupled.map((c) => (
                <tr key={c.file_id}>
                  <td className="font-mono text-xs"><Link href={`/repositories/${repoId}/files/${c.file_id}`}>{c.path}</Link></td>
                  <td className="num">{c.cochanges}</td>
                  <td className="num">{fmtPct(c.confidence)}</td>
                  <td className="num">{c.jaccard.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="mb-1">Where in the file changes happen</h2>
        <p className="mb-3 text-xs text-slate-500">Recorded hunks per 10-line region (line numbers after each change).</p>
        <HunkHeatmap data={heat} />
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3">History</h2>
        <table className="table">
          <thead><tr><th>Commit</th><th>Message</th><th>Author</th><th>Date</th><th>Change</th><th className="num">+/−</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.sha}>
                <td className="font-mono text-xs">{shortSha(h.sha)}</td>
                <td>{h.subject}</td>
                <td>{h.author}</td>
                <td>{fmtDate(h.authored_at)}</td>
                <td>{h.change}{h.old_path && <span className="text-xs text-slate-500"> from {h.old_path}</span>}</td>
                <td className="num">
                  {h.insertions == null ? "binary" : <><span className="text-emerald-700">+{h.insertions}</span> <span className="text-red-700">−{h.deletions}</span></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
