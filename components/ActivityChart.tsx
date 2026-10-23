"use client";

import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Month = { month: string; commits: number; authors: number; insertions: number; deletions: number };

export function ActivityChart({ data }: { data: Month[] }) {
  if (data.length === 0) return <p className="text-sm text-slate-500">No commits yet.</p>;
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="c" allowDecimals={false} tick={{ fontSize: 11 }} />
          <YAxis yAxisId="a" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar yAxisId="c" dataKey="commits" name="Commits" fill="#6366f1" radius={[2, 2, 0, 0]} />
          <Line yAxisId="a" dataKey="authors" name="Active authors" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars of how often each 10-line region of a file was edited. */
export function HunkHeatmap({ data }: { data: { bucket_start: number; hunks: number }[] }) {
  if (data.length === 0) return <p className="text-sm text-slate-500">No line-level hunks recorded for this file.</p>;
  const rows = data.map((d) => ({ lines: `${d.bucket_start}–${d.bucket_start + 9}`, hunks: d.hunks }));
  return (
    <div className="w-full" style={{ height: Math.min(40 + rows.length * 18, 480) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="lines" width={70} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="hunks" name="Edits" fill="#ef4444" radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
