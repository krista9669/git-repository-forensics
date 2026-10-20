import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

// One pool per process. In `next dev` modules are re-evaluated on every edit,
// so the pool is parked on globalThis to avoid leaking connections.
const g = globalThis as unknown as { __grfPool?: Pool };

export function pool(): Pool {
  if (!g.__grfPool) {
    g.__grfPool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return g.__grfPool;
}

export type Queryable = Pick<PoolClient, "query">;

/** Parameterised query returning rows. Never interpolate values into `text`. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool(),
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool(),
): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back on any error. */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  p: Pool = pool(),
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
