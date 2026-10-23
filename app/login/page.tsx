import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/repositories");
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1">Git Repository Forensics</h1>
      <p className="mb-6 text-sm text-slate-500">Sign in to analyse repositories.</p>
      <div className="card">
        <AuthForm mode="login" />
      </div>
      {env().ALLOW_SELF_REGISTRATION && (
        <p className="mt-4 text-center text-sm">
          No account? <Link href="/register">Register</Link>
        </p>
      )}
    </main>
  );
}
