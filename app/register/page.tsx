import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (!env().ALLOW_SELF_REGISTRATION) notFound();
  if (await currentUser()) redirect("/repositories");
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1">Create an analyst account</h1>
      <p className="mb-6 text-sm text-slate-500">Analysts can add and analyse repositories.</p>
      <div className="card">
        <AuthForm mode="register" />
      </div>
      <p className="mt-4 text-center text-sm">
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
