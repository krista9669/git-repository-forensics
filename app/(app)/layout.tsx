import Link from "next/link";
import { LogoutButton } from "@/components/Actions";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/repositories" className="font-semibold text-slate-900 hover:no-underline">
            Git Repository Forensics
          </Link>
          <Link href="/repositories" className="text-sm text-slate-600">Repositories</Link>
          {user.role === "admin" && <Link href="/admin" className="text-sm text-slate-600">Admin</Link>}
          <span className="ml-auto text-sm text-slate-500">
            {user.display_name} · {user.role}
          </span>
          <LogoutButton />
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </>
  );
}
