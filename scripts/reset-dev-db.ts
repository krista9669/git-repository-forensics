// Drops and recreates the development (or, with --test, the test) database and
// applies all migrations. Destroys all data in that database.
//
// Usage: npm run db:reset            (database in DATABASE_URL)
//        npm run db:reset -- --test  (database in TEST_DATABASE_URL)
import "./load-env";
import { Client, Pool } from "pg";
import { migrate } from "../lib/migrate";

async function main() {
  const isTest = process.argv.includes("--test");
  const url = isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${isTest ? "TEST_DATABASE_URL" : "DATABASE_URL"} is not set.`);

  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new Error(`Refusing unusual database name "${dbName}".`);

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    // dbName is validated above; identifiers cannot be bound as parameters.
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Recreated database ${dbName}.`);
  } finally {
    await client.end();
  }

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(pool, console.log);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
