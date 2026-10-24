import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityChart } from "@/components/ActivityChart";
import { DeleteRepositoryButton } from "@/components/Actions";
import { JobPanel, StatusBadge } from "@/components/JobPanel";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtDateTime, fmtInt, fmtPct, shortSha } from "@/lib/format";
import * as q from "@/lib/queries";

const TABS = [
  ["overview", "Overview"],
  ["developers", "Developers"],
  ["hotspots", "Hotspots"],
  ["coupling", "Change coupling"],
  ["team", "Team analytics"],
  ["commits", "Commits"],
  ["graph", "Knowledge graph"],
  ["jobs", "Jobs"],
] as const;
type Tab = (typeof TABS)[number][0];

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export default async function RepositoryPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const repo = await q.getRepository(id);
  if (!repo) notFound();
  const sp = await searchParams;
  const tab: Tab = TABS.some(([t]) => t === sp.tab) ? (sp.tab as Tab) : "overview";
  const jobs = await q.listJobs(id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>{repo.name}</h1>
          <p className="font-mono text-xs text-slate-500">
            {repo.source_type === "local" ? `local: ${repo.source}` : repo.source}
            {repo.branch && ` @ ${repo.branch}`}
            {repo.head_sha && ` · HEAD ${shortSha(repo.head_sha)}`}
            {` · analysed ${fmtDateTime(repo.last_analyzed_at)}`}
          </p>
        </div>
        {(user.role === "admin" || repo.created_by === user.id) && (
          <DeleteRepositoryButton id={repo.id} name={repo.name} />
        )}
      </div>

      <JobPanel repoId={id} latest={jobs[0] ? { id: jobs[0].id, status: jobs[0].status, error: jobs[0].error } : null} />

      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={`/repositories/${id}?tab=${t}`}
            className={`-mb-px rounded-t-md px-3 py-2 text-sm hover:no-underline ${
              t === tab ? "border border-b-white border-slate-200 bg-white font-medium text-slate-900" : "text-slate-600"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <Overview id={id} />}
      {tab === "developers" && <Developers id={id} />}
      {tab === "hotspots" && <Hotspots id={id} />}
      {tab === "coupling" && <Coupling id={id} min={sp.min} />}
      {tab === "team" && <Team id={id} minAuthors={sp.authors} />}
      {tab === "commits" && <Commits id={id} text={sp.q} mode={sp.mode} />}
      {tab === "graph" && <Graph id={id} />}
      {tab === "jobs" && <Jobs jobs={jobs} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

async function Overview({ id }: { id: number }) {
  const [s, months, top] = await Promise.all([q.repoSummary(id), q.monthlyActivity(id), q.hotspots(id, 5)]);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Commits" value={fmtInt(s.commits)} hint={`${fmtInt(s.merges)} merges`} />
        <Stat label="Developers" value={fmtInt(s.developers)} />
        <Stat label="Files at HEAD" value={fmtInt(s.files_at_head)} />
        <Stat
          label="Bus factor"
          value={fmtInt(s.bus_factor)}
          hint="Fewest people owning over half of today's lines"
        />
      </div>
      <section className="card">
        <h2 className="mb-1">Monthly activity</h2>
        <p className="mb-3 text-xs text-slate-500">
          {fmtDate(s.first_commit)} → {fmtDate(s.last_commit)} · from the <code>monthly_activity</code> materialised view
        </p>
        <ActivityChart data={months} />
      </section>
      <section className="card">
        <h2 className="mb-3">Top hotspots</h2>
        <HotspotTable id={id} rows={top} />
      </section>
    </div>
  );
}

async function Developers({ id }: { id: number }) {
  const rows = await q.developers(id);
  return (
    <section className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Developer</th>
            <th className="num">Commits</th>
            <th className="num">Lines +/−</th>
            <th className="num">Active days</th>
            <th>First → last commit</th>
            <th className="num">Owns at HEAD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.developer_id}>
              <td>
                {d.name}
                <div className="text-xs text-slate-500">{d.email}</div>
              </td>
              <td className="num">{fmtInt(d.commits)}{d.merges > 0 && <span className="text-xs text-slate-400"> ({d.merges} merges)</span>}</td>
              <td className="num">
                <span className="text-emerald-700">+{fmtInt(d.insertions)}</span>{" "}
                <span className="text-red-700">−{fmtInt(d.deletions)}</span>
              </td>
              <td className="num">{fmtInt(d.active_days)}</td>
              <td>{fmtDate(d.first_commit_at)} → {fmtDate(d.last_commit_at)}</td>
              <td className="num">{fmtInt(d.owned_lines)} lines · {fmtPct(d.ownership_share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HotspotTable({ id, rows }: { id: number; rows: q.HotspotRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No data yet.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>File</th>
          <th className="num">Revisions</th>
          <th className="num">Authors</th>
          <th className="num">Churn (lines)</th>
          <th className="num">Coupled files</th>
          <th>Last changed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.file_id}>
            <td className="font-mono text-xs"><Link href={`/repositories/${id}/files/${h.file_id}`}>{h.path}</Link></td>
            <td className="num">{fmtInt(h.revisions)}</td>
            <td className="num">{fmtInt(h.authors)}</td>
            <td className="num">{fmtInt(h.churn)}</td>
            <td className="num">{fmtInt(h.coupled_files)}</td>
            <td>{fmtDate(h.last_changed_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function Hotspots({ id }: { id: number }) {
  return (
    <section className="card overflow-x-auto">
      <p className="mb-3 text-sm text-slate-500">
        Files that still exist at HEAD, ranked by how often they changed. Frequently changed files touched by many
        people are where defects and merge conflicts concentrate.
      </p>
      <HotspotTable id={id} rows={await q.hotspots(id, 50)} />
    </section>
  );
}

async function Coupling({ id, min }: { id: number; min?: string }) {
  const minJaccard = Math.min(Math.max(Number(min ?? 0) || 0, 0), 1);
  const rows = await q.coupling(id, minJaccard);
  return (
    <section className="card overflow-x-auto">
      <form className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <input type="hidden" name="tab" value="coupling" />
        <div>
          <label className="label" htmlFor="min">Minimum Jaccard</label>
          <input className="input w-28" id="min" name="min" type="number" step="0.05" min="0" max="1" defaultValue={minJaccard} />
        </div>
        <button className="btn-secondary">Filter</button>
        <p className="text-slate-500">
          Pairs of files that change in the same commits (bulk commits and merges excluded).
          Confidence A→B is how often B changes when A does.
        </p>
      </form>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No coupled pairs at this threshold.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>File A</th>
              <th>File B</th>
              <th className="num">Co-changes</th>
              <th className="num">Conf. A→B</th>
              <th className="num">Conf. B→A</th>
              <th className="num">Jaccard</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={`${e.file_a_id}-${e.file_b_id}`}>
                <td className="font-mono text-xs"><Link href={`/repositories/${id}/files/${e.file_a_id}`}>{e.file_a}</Link></td>
                <td className="font-mono text-xs"><Link href={`/repositories/${id}/files/${e.file_b_id}`}>{e.file_b}</Link></td>
                <td className="num">{e.cochanges}</td>
                <td className="num">{fmtPct(e.confidence_ab)}</td>
                <td className="num">{fmtPct(e.confidence_ba)}</td>
                <td className="num">{e.jaccard.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function Team({ id, minAuthors }: { id: number; minAuthors?: string }) {
  const min = Math.min(Math.max(Math.trunc(Number(minAuthors ?? 2)) || 2, 1), 1000);
  const [core, shared] = await Promise.all([q.coreContributors(id), q.sharedFiles(id, min)]);
  return (
    <div className="space-y-5">
      <section className="card overflow-x-auto">
        <h2 className="mb-1">Core contributors</h2>
        <p className="mb-3 text-xs text-slate-500">
          Developers with at least the average number of commits per developer
          {core[0] && ` (${core[0].avg_commits.toFixed(1)})`}. Bots are excluded.
        </p>
        {core.length === 0 ? (
          <p className="text-sm text-slate-500">No data yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Developer</th><th className="num">Commits</th><th className="num">Share of commits</th></tr>
            </thead>
            <tbody>
              {core.map((d) => (
                <tr key={d.developer_id}>
                  <td>{d.name}<div className="text-xs text-slate-500">{d.email}</div></td>
                  <td className="num">{fmtInt(d.commits)}</td>
                  <td className="num">{fmtPct(d.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card overflow-x-auto">
        <form className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="tab" value="team" />
          <div>
            <label className="label" htmlFor="authors">Minimum authors</label>
            <input className="input w-28" id="authors" name="authors" type="number" step="1" min="1" defaultValue={min} />
          </div>
          <button className="btn-secondary">Filter</button>
          <p className="text-slate-500">
            Shared files: files at HEAD changed by at least this many different developers. Changes to them
            need the most coordination.
          </p>
        </form>
        {shared.length === 0 ? (
          <p className="text-sm text-slate-500">No files with that many authors.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>File</th><th className="num">Authors</th><th className="num">Revisions</th><th className="num">Churn (lines)</th></tr>
            </thead>
            <tbody>
              {shared.map((f) => (
                <tr key={f.file_id}>
                  <td className="font-mono text-xs"><Link href={`/repositories/${id}/files/${f.file_id}`}>{f.path}</Link></td>
                  <td className="num">{fmtInt(f.authors)}</td>
                  <td className="num">{fmtInt(f.revisions)}</td>
                  <td className="num">{fmtInt(f.churn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Highlight({ text }: { text: string }) {
  // ts_headline marks matches with << >>; render them without using raw HTML.
  return (
    <>
      {text.split(/(<<.*?>>)/g).map((part, i) =>
        part.startsWith("<<") ? <mark key={i}>{part.slice(2, -2)}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

async function Commits({ id, text, mode }: { id: number; text?: string; mode?: string }) {
  const t = (text ?? "").trim().slice(0, 500);
  const similar = mode === "similar";
  const rows = !t ? await q.recentCommits(id) : similar ? await q.similarCommits(id, t) : await q.searchCommits(id, t);
  return (
    <section className="card overflow-x-auto">
      <form className="mb-3 flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value="commits" />
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="q">Search commit messages</label>
          <input className="input" id="q" name="q" defaultValue={t} placeholder="e.g. fix login redirect" />
        </div>
        <div>
          <label className="label" htmlFor="mode">Method</label>
          <select className="input" id="mode" name="mode" defaultValue={similar ? "similar" : "fts"}>
            <option value="fts">Full-text (tsvector)</option>
            <option value="similar">Similar wording (pgvector)</option>
          </select>
        </div>
        <button className="btn">Search</button>
      </form>
      <p className="mb-2 text-xs text-slate-500">
        {!t ? "Most recent commits." : similar ? "Nearest messages by cosine similarity." : "Ranked by ts_rank."}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No matching commits.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Commit</th>
              <th>Message</th>
              <th>Author</th>
              <th>Date</th>
              <th className="num">Files</th>
              <th className="num">+/−</th>
              {t && <th className="num">Score</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.sha}>
                <td className="font-mono text-xs">{shortSha(c.sha)}</td>
                <td>
                  {c.subject}
                  {c.is_merge && <span className="badge ml-1 bg-slate-100 text-slate-600">merge</span>}
                  {c.headline && !similar && (
                    <div className="text-xs text-slate-500"><Highlight text={c.headline} /></div>
                  )}
                </td>
                <td>{c.author}</td>
                <td>{fmtDate(c.authored_at)}</td>
                <td className="num">{c.files_changed}</td>
                <td className="num">
                  <span className="text-emerald-700">+{fmtInt(c.insertions)}</span>{" "}
                  <span className="text-red-700">−{fmtInt(c.deletions)}</span>
                </td>
                {t && <td className="num">{c.score?.toFixed(3)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function Graph({ id }: { id: number }) {
  let collab: q.Collaboration[] = [];
  let silos: { path: string; owner: string; share: number }[] = [];
  let failure: string | null = null;
  try {
    [collab, silos] = await Promise.all([q.collaboration(id), q.knowledgeSilos(id)]);
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure) {
    return <p className="error">The Neo4j graph is unavailable: {failure}</p>;
  }
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <section className="card">
        <h2 className="mb-1">Collaboration</h2>
        <p className="mb-3 text-xs text-slate-500">Developer pairs who worked on the same files (Neo4j).</p>
        {collab.length === 0 ? (
          <p className="text-sm text-slate-500">No shared files.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Developer</th><th>Developer</th><th className="num">Shared files</th></tr></thead>
            <tbody>
              {collab.map((c) => (
                <tr key={`${c.a}|${c.b}`}><td>{c.a}</td><td>{c.b}</td><td className="num">{c.shared_files}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2 className="mb-1">Knowledge silos</h2>
        <p className="mb-3 text-xs text-slate-500">Files where one person owns at least 90% of today's lines.</p>
        {silos.length === 0 ? (
          <p className="text-sm text-slate-500">None found.</p>
        ) : (
          <table className="table">
            <thead><tr><th>File</th><th>Owner</th><th className="num">Share</th></tr></thead>
            <tbody>
              {silos.map((s) => (
                <tr key={s.path}><td className="font-mono text-xs">{s.path}</td><td>{s.owner}</td><td className="num">{fmtPct(s.share)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Jobs({ jobs }: { jobs: q.JobRow[] }) {
  return (
    <section className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr><th>#</th><th>Status</th><th>Requested by</th><th>Queued</th><th>Finished</th><th>Result</th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.id}</td>
              <td><StatusBadge status={j.status} /></td>
              <td>{j.requested_by_name ?? "—"}</td>
              <td>{fmtDateTime(j.created_at)}</td>
              <td>{fmtDateTime(j.finished_at)}</td>
              <td className="text-xs">
                {j.error ?? (j.stats ? (
                  <>
                    {fmtInt(j.stats.commits as number)} commits, {fmtInt(j.stats.couplingEdges as number)} coupling edges,{" "}
                    {((j.stats.durationMs as number) / 1000).toFixed(1)} s
                    {Boolean(j.stats.truncated) && " (history truncated)"}
                    {typeof j.stats.graphError === "string" && <span className="text-amber-700"> · graph: {j.stats.graphError}</span>}
                  </>
                ) : "—")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
