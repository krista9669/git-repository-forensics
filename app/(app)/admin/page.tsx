import { UserControls } from "@/components/Actions";
import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";

export default async function AdminPage() {
  const me = await requireUser("admin");
  const [users, log] = await Promise.all([
    query<{ id: number; email: string; display_name: string; role: "admin" | "analyst"; is_active: boolean; created_at: string; repos: number }>(
      `SELECT u.id::int, u.email, u.display_name, u.role, u.is_active, u.created_at,
              (SELECT count(*)::int FROM repositories r WHERE r.created_by = u.id) AS repos
         FROM users u ORDER BY u.created_at`,
    ),
    query<{ id: number; at: string; who: string | null; action: string; target_type: string | null; target_id: number | null; details: Record<string, unknown> }>(
      `SELECT a.id::int, a.at, u.display_name AS who, a.action, a.target_type, a.target_id::int, a.details
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.at DESC LIMIT 100`,
    ),
  ]);

  return (
    <div className="space-y-6">
      <h1>Administration</h1>
      <section className="card overflow-x-auto">
        <h2 className="mb-1">Users</h2>
        <p className="mb-3 text-xs text-slate-500">
          A database trigger keeps at least one active administrator; changes that would remove the last one are refused.
        </p>
        <table className="table">
          <thead><tr><th>Name</th><th>E-mail</th><th>Joined</th><th className="num">Repos</th><th>Status</th><th>Role / access</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.display_name}</td>
                <td>{u.email}</td>
                <td>{fmtDateTime(u.created_at)}</td>
                <td className="num">{u.repos}</td>
                <td>{u.is_active ? "active" : <span className="text-red-700">inactive</span>}</td>
                <td><UserControls id={u.id} role={u.role} isActive={u.is_active} isSelf={u.id === me.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="mb-3">Audit log (latest 100)</h2>
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>
            {log.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{fmtDateTime(a.at)}</td>
                <td>{a.who ?? "—"}</td>
                <td>{a.action}</td>
                <td>{a.target_type ? `${a.target_type} #${a.target_id}` : "—"}</td>
                <td className="font-mono text-xs">{Object.keys(a.details).length ? JSON.stringify(a.details) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
