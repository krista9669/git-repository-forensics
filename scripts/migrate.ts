// Usage: npm run db:migrate            (DATABASE_URL)
//        npm run db:migrate -- --test  (TEST_DATABASE_URL)
import "./load-env";
import { Pool } from "pg";
import { migrate } from "../lib/migrate";

const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL / TEST_DATABASE_URL is not set (copy .env.example to .env.local).");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
migrate(pool, console.log)
  .then((applied) => console.log(applied.length ? "Migrations complete." : "Database is up to date."))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
