import { z } from "zod";
import { audit } from "@/lib/auth";
import { HttpError, intParam, json, parseBody, route } from "@/lib/api";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

const Body = z
  .object({ role: z.enum(["admin", "analyst"]).optional(), isActive: z.boolean().optional() })
  .refine((b) => b.role !== undefined || b.isActive !== undefined, "nothing to change");

/**
 * Changes a user's role or active flag. The protect_last_admin trigger
 * refuses changes that would leave no active administrator (reported as 409).
 */
export const PATCH = route<Ctx>(
  async (req, { params, user }) => {
    const id = intParam((await params).id);
    const body = await parseBody(req, Body);
    const updated = await queryOne<{ id: number }>(
      `UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active)
        WHERE id = $1 RETURNING id::int`,
      [id, body.role ?? null, body.isActive ?? null],
    );
    if (!updated) throw new HttpError(404, "User not found.");
    // A deactivated user is signed out everywhere.
    if (body.isActive === false) await query("DELETE FROM sessions WHERE user_id = $1", [id]);
    await audit(user.id, "user_updated", { type: "user", id }, body);
    return json({ ok: true });
  },
  { role: "admin" },
);
