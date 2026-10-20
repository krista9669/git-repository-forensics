import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

// npm scripts and vitest always run from the project root.
const DIR = path.resolve(process.cwd(), "db", "migrations");

/**
 * Applies every db/migrations/*.sql file not yet recorded in schema_migrations,
 * in file-name order, each in its own transaction. Returns the names applied.
 */
export async function migrate(pool: Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name        TEXT PRIMARY KEY,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`applied ${file}`);
      applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
