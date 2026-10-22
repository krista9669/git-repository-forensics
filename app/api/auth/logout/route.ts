import { endSession } from "@/lib/auth";
import { json, route } from "@/lib/api";

export const POST = route(
  async () => {
    await endSession();
    return json({ ok: true });
  },
  { public: true },
);
