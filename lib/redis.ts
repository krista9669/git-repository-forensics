import Redis from "ioredis";
import { env } from "./env";

const g = globalThis as unknown as { __grfRedis?: Redis };

export function redis(): Redis {
  if (!g.__grfRedis) {
    g.__grfRedis = new Redis(env().REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    // Redis is an accelerator, not a source of truth: log and carry on.
    g.__grfRedis.on("error", (e) => console.warn("[redis]", e.message));
  }
  return g.__grfRedis;
}

/**
 * Read-through cache. Any Redis failure falls back to computing the value,
 * so the app keeps working (slower) when Redis is down.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await redis().get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return compute();
  }
  const value = await compute();
  try {
    await redis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* ignore */
  }
  return value;
}

/** Deletes every cache key for a repository after it is re-analysed. */
export async function invalidateRepo(repoId: number): Promise<void> {
  try {
    const r = redis();
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", `cache:repo:${repoId}:*`, "COUNT", 200);
      if (keys.length) await r.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  } catch {
    /* ignore */
  }
}

/**
 * Fixed-window rate limiter. Returns true when the call is allowed.
 * Fails open if Redis is unavailable.
 */
export async function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const key = `rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const n = await redis().incr(key);
    if (n === 1) await redis().expire(key, windowSeconds);
    return n <= limit;
  } catch {
    return true;
  }
}

export type JobProgress = { stage: string; percent: number; message?: string };

export async function setProgress(jobId: number, p: JobProgress): Promise<void> {
  try {
    await redis().set(`job:${jobId}:progress`, JSON.stringify(p), "EX", 86_400);
  } catch {
    /* ignore */
  }
}

export async function getProgress(jobId: number): Promise<JobProgress | null> {
  try {
    const v = await redis().get(`job:${jobId}:progress`);
    return v ? (JSON.parse(v) as JobProgress) : null;
  } catch {
    return null;
  }
}
