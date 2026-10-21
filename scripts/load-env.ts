// Loads .env.local for command-line scripts and the worker (Next.js loads it
// for the web app on its own). Variables already set in the shell win.
import fs from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (e) {
      console.warn(`Could not read ${file}: ${(e as Error).message}`);
    }
  }
}
