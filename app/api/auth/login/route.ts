import { z } from "zod";
import { audit, startSession, verifyCredentials } from "@/lib/auth";
import { HttpError, clientIp, json, parseBody, route } from "@/lib/api";
import { rateLimit } from "@/lib/redis";

const Body = z.object({
  email: z.string().trim().max(254),
  password: z.string().max(200),
});

export const POST = route(
  async (req) => {
    const { email, password } = await parseBody(req, Body);
    // Throttle guessing per address and per account.
    const ip = clientIp(req);
    if (!(await rateLimit(`login-ip:${ip}`, 20, 300)) || !(await rateLimit(`login-acct:${email.toLowerCase()}`, 10, 300))) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }
    const user = await verifyCredentials(email, password);
    if (!user) {
      await audit(null, "login_failed", undefined, { email: email.toLowerCase() });
      throw new HttpError(401, "Incorrect e-mail or password.");
    }
    await startSession(user.id);
    await audit(user.id, "login");
    return json({ user });
  },
  { public: true },
);
