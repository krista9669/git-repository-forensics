"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./client";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, {
        body: {
          email: f.get("email"),
          password: f.get("password"),
          ...(mode === "register" ? { displayName: f.get("displayName") } : {}),
        },
      });
      router.replace("/repositories");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === "register" && (
        <div>
          <label className="label" htmlFor="displayName">Name</label>
          <input className="input" id="displayName" name="displayName" required maxLength={100} />
        </div>
      )}
      <div>
        <label className="label" htmlFor="email">E-mail</label>
        <input className="input" id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === "register" ? 10 : undefined}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
        />
        {mode === "register" && <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn w-full" disabled={busy}>
        {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
    </form>
  );
}
