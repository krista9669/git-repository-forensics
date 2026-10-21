// Creates the initial administrator from ADMIN_EMAIL / ADMIN_PASSWORD.
// With --demo it also creates the fixture repository, registers it and
// queues an analysis (run `npm run worker` to process it).
import "./load-env";
import path from "node:path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { createFixtureRepo } from "./fixture-repo";

async function main() {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env.local.");
  if (ADMIN_PASSWORD.length < 10 || ADMIN_PASSWORD.startsWith("CHANGE_ME")) {
    throw new Error("Choose a real ADMIN_PASSWORD of at least 10 characters.");
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const res = await pool.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES (lower($1), 'Administrator', $2, 'admin')
       ON CONFLICT DO NOTHING RETURNING id`,
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 12)],
    );
    console.log(res.rowCount ? `Created administrator ${ADMIN_EMAIL}.` : `User ${ADMIN_EMAIL} already exists; left unchanged.`);

    if (process.argv.includes("--demo")) {
      const root = process.env.LOCAL_REPO_ROOT ?? "./fixtures/repos";
      createFixtureRepo(path.resolve(root, "demo"));
      const admin = (await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [ADMIN_EMAIL])).rows[0];
      const repo = await pool.query(
        `INSERT INTO repositories (name, source_type, source, created_by)
         VALUES ('demo', 'local', 'demo', $1)
         ON CONFLICT (source_type, source) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [admin.id],
      );
      await pool.query(
        `INSERT INTO analysis_jobs (repository_id, requested_by) VALUES ($1, $2)
         ON CONFLICT (repository_id) WHERE status IN ('queued', 'running') DO NOTHING`,
        [repo.rows[0].id, admin.id],
      );
      console.log("Registered the demo repository and queued its analysis.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
