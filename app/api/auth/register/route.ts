import { z } from "zod";
import { audit, hashPassword, startSession } from "@/lib/auth";
import { HttpError, clientIp, json, parseBody, route } from "@/lib/api";
import { queryOne } from "@/lib/db";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/redis";

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(10, "must be at least 10 characters").max(200),
});

export const POST = route(
  async (req) => {
    if (!env().ALLOW_SELF_REGISTRATION) throw new HttpError(403, "Self-registration is disabled.");
    if (!(await rateLimit(`register:${clientIp(req)}`, 5, 3600))) {
      throw new HttpError(429, "Too many registrations from this address.");
    }
    const { email, displayName, password } = await parseBody(req, Body);
    const user = await queryOne<{ id: number }>(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'analyst')
       ON CONFLICT DO NOTHING
       RETURNING id::int`,
      [email, displayName, await hashPassword(password)],
    );
    if (!user) throw new HttpError(409, "An account with that e-mail already exists.");
    await audit(user.id, "register");
    await startSession(user.id);
    return json({ ok: true }, 201);
  },
  { public: true },
);
