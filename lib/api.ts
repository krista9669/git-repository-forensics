import { NextResponse } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { currentUser, type User } from "./auth";
import { rateLimit } from "./redis";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

/**
 * Rejects cross-site state-changing requests. Together with SameSite=Lax
 * session cookies this protects the JSON API against CSRF.
 */
function checkOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    throw new HttpError(403, "Cross-origin request rejected.");
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  return schema.parse(body);
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

type Handler<C> = (req: Request, ctx: C & { user: User }) => Promise<Response>;
type Options = { role?: "admin"; public?: boolean };

/** Wraps a route handler with auth, origin checking and uniform error responses. */
export function route<C extends { params: Promise<Record<string, string>> }>(
  handler: Handler<C>,
  opts: Options = {},
) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      checkOrigin(req);
      const user = await currentUser();
      if (!opts.public) {
        if (!user) throw new HttpError(401, "Please sign in.");
        if (opts.role && user.role !== opts.role) throw new HttpError(403, "Administrator access required.");
        if (!(await rateLimit(`user:${user.id}`, 300, 60))) throw new HttpError(429, "Too many requests.");
      }
      return await handler(req, { ...ctx, user: user as User });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof ZodError) {
        return json({ error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") }, 400);
      }
      const pgCode = (e as { code?: string }).code;
      if (pgCode === "23505") return json({ error: "That already exists." }, 409);
      if (pgCode === "23514") return json({ error: (e as Error).message }, 409);
      console.error(e);
      return json({ error: "Internal server error." }, 500);
    }
  };
}

export function intParam(v: string | undefined, name = "id"): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return n;
}
