"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./client";

type Job = { id: number; status: string; error: string | null };
type Progress = { stage: string; percent: number; message?: string } | null;

const ACTIVE = new Set(["queued", "running"]);

/** Shows the latest job, polls its progress while it is active, and offers analyse / cancel. */
export function JobPanel({ repoId, latest }: { repoId: number; latest: Job | null }) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(latest);
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState<string | null>(null);
  const wasActive = useRef(latest ? ACTIVE.has(latest.status) : false);

  useEffect(() => setJob(latest), [latest]);

  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<{ job: Job; progress: Progress }>(`/api/jobs/${job.id}`);
        if (stop) return;
        setProgress(r.progress);
        if (r.job.status !== job.status) setJob(r.job);
        if (!ACTIVE.has(r.job.status) && wasActive.current) {
          wasActive.current = false;
          router.refresh(); // reload the server-rendered results
        }
      } catch {
        /* transient; try again on the next tick */
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [job, router]);

  async function analyze() {
    setError(null);
    try {
      const { id } = await api<{ id: number }>(`/api/repositories/${repoId}/analyze`, { body: {} });
      wasActive.current = true;
      setProgress(null);
      setJob({ id, status: "queued", error: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      await api(`/api/jobs/${job.id}/cancel`, { body: {} });
      setJob({ ...job, status: "cancelled" });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const active = job && ACTIVE.has(job.status);
  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm">
          {!job && <span className="text-slate-500">Not analysed yet.</span>}
          {job && (
            <>
              Latest analysis: <StatusBadge status={job.status} />
              {job.status === "queued" && (
                <span className="ml-2 text-slate-500">waiting for a worker (<code>npm run worker</code>)</span>
              )}
            </>
          )}
        </div>
        {active ? (
          <button className="btn-secondary" onClick={cancel}>Cancel</button>
        ) : (
          <button className="btn" onClick={analyze}>{job ? "Re-analyse" : "Analyse"}</button>
        )}
      </div>
      {active && progress && (
        <div>
          <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">{progress.message ?? progress.stage}</p>
        </div>
      )}
      {job?.status === "failed" && job.error && <p className="error">{job.error}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string | null }) {
  const color: Record<string, string> = {
    queued: "bg-amber-100 text-amber-800",
    running: "bg-sky-100 text-sky-800",
    succeeded: "bg-emerald-100 text-emerald-800",
    failed: "bg-red-100 text-red-800",
    cancelled: "bg-slate-200 text-slate-700",
  };
  if (!status) return <span className="text-slate-400">—</span>;
  return <span className={`badge ${color[status] ?? ""}`}>{status}</span>;
}
