"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="text-sm text-slate-600 hover:text-slate-900"
      onClick={async () => {
        await api("/api/auth/logout", { body: {} }).catch(() => {});
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

export function AddRepositoryForm({ allowedHosts, localRoot }: { allowedHosts: string[]; localRoot: string }) {
  const router = useRouter();
  const [type, setType] = useState<"remote" | "local">("remote");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: number }>("/api/repositories", {
        body: { name: f.get("name"), sourceType: type, source: f.get("source"), branch: f.get("branch") || undefined },
      });
      router.push(`/repositories/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[1fr_auto_2fr_1fr_auto] md:items-end">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input className="input" id="name" name="name" required maxLength={200} placeholder="my-project" />
      </div>
      <div>
        <label className="label" htmlFor="type">Source</label>
        <select id="type" className="input" value={type} onChange={(e) => setType(e.target.value as "remote" | "local")}>
          <option value="remote">Remote (https)</option>
          <option value="local">Local folder</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="source">{type === "remote" ? "Clone URL" : "Folder name"}</label>
        <input
          className="input font-mono"
          id="source"
          name="source"
          required
          placeholder={type === "remote" ? "https://github.com/owner/repo" : "demo"}
        />
      </div>
      <div>
        <label className="label" htmlFor="branch">Branch (optional)</label>
        <input className="input font-mono" id="branch" name="branch" placeholder="default" />
      </div>
      <button className="btn" disabled={busy}>{busy ? "Adding…" : "Add & analyse"}</button>
      <p className="text-xs text-slate-500 md:col-span-5">
        {type === "remote"
          ? `Allowed hosts: ${allowedHosts.join(", ")}.`
          : `Folders are resolved inside ${localRoot}; run "npm run fixture" to create a "demo" repository there.`}
      </p>
      {error && <p className="error md:col-span-5" role="alert">{error}</p>}
    </form>
  );
}

export function DeleteRepositoryButton({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn-danger"
        onClick={async () => {
          if (!confirm(`Delete "${name}" and all of its analysis data? This cannot be undone.`)) return;
          try {
            await api(`/api/repositories/${id}`, { method: "DELETE" });
            router.replace("/repositories");
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Delete
      </button>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </span>
  );
}

export function UserControls(props: { id: number; role: "admin" | "analyst"; isActive: boolean; isSelf: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const patch = async (body: object) => {
    setError(null);
    try {
      await api(`/api/admin/users/${props.id}`, { method: "PATCH", body });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="input w-auto py-1"
        value={props.role}
        aria-label="Role"
        onChange={(e) => patch({ role: e.target.value })}
      >
        <option value="analyst">analyst</option>
        <option value="admin">admin</option>
      </select>
      <button className="btn-secondary py-1" onClick={() => patch({ isActive: !props.isActive })}>
        {props.isActive ? "Deactivate" : "Activate"}
      </button>
      {props.isSelf && <span className="text-xs text-slate-400">(you)</span>}
      {error && <span className="w-full text-xs text-red-700">{error}</span>}
    </div>
  );
}
