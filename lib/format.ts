// Formatting helpers shared by server and client components.
// Dates may arrive as Date (fresh from pg) or ISO strings (from the Redis cache).

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

export const fmtPct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export const shortSha = (sha: string) => sha.slice(0, 8);
