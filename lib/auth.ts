import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { query, queryOne, type Queryable } from "./db";

export const SESSION_COOKIE = "grf_session";
const BCRYPT_COST = 12;

export type User = {
  id: number;
  email: string;
  display_name: string;
  role: "admin" | "analyst";
};

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_COST);

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// Compared against when the e-mail is unknown, so a login attempt takes the
// same time whether or not the account exists.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);

export async function verifyCredentials(email: string, password: string): Promise<User | null> {
  const row = await queryOne<User & { password_hash: string; is_active: boolean }>(
    `SELECT id::int, email, display_name, role, password_hash, is_active
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok || !row.is_active) return null;
  return { id: row.id, email: row.email, display_name: row.display_name, role: row.role };
}

/** Creates a session row and sets the cookie. Only a hash of the token is stored. */
export async function startSession(userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  const hours = env().SESSION_TTL_HOURS;
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), userId, hours],
  );
  // opportunistic clean-up of expired sessions
  await query("DELETE FROM sessions WHERE expires_at < now()");
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: hours * 3600,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return queryOne<User>(
    `SELECT u.id::int, u.email, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [sha256(token)],
  );
}

/** For server components: redirects to /login when signed out. */
export async function requireUser(role?: "admin"): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect("/repositories");
  return user;
}

export async function audit(
  userId: number | null,
  action: string,
  target?: { type: string; id: number },
  details: Record<string, unknown> = {},
  db?: Queryable,
): Promise<void> {
  await query(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)",
    [userId, action, target?.type ?? null, target?.id ?? null, JSON.stringify(details)],
    db,
  );
}
