// Builds a small, fully deterministic git repository whose analysis results
// are known in advance. Used by the integration tests and for demos.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type Author = { name: string; email: string };

export const AUTHORS = {
  alice: { name: "Alice Analyst", email: "alice@example.com" },
  bob: { name: "Bob Builder", email: "bob@example.com" },
  carol: { name: "Carol Coder", email: "carol@example.com" },
} satisfies Record<string, Author>;

export const FIXTURE_COMMITS = 12;

export function createFixtureRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let day = 0;
  const gitIn = (args: string[], author?: Author) => {
    const date = `2024-01-${String(1 + day).padStart(2, "0")}T10:00:00+00:00`;
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(dir, ".no-global-config"),
        GIT_AUTHOR_NAME: author?.name ?? "Fixture",
        GIT_AUTHOR_EMAIL: author?.email ?? "fixture@example.com",
        GIT_COMMITTER_NAME: author?.name ?? "Fixture",
        GIT_COMMITTER_EMAIL: author?.email ?? "fixture@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (author: Author, message: string) => {
    gitIn(["add", "-A"], author);
    gitIn(["commit", "-q", "--no-gpg-sign", "-m", message], author);
    day++;
  };

  gitIn(["init", "-q", "-b", "main"]);
  gitIn(["config", "commit.gpgsign", "false"]);

  // 1
  write("src/api.ts", "export function get() {\n  return 1;\n}\n");
  write("src/api.test.ts", "test('get', () => {});\n");
  write("README.md", "# Demo\n");
  commit(AUTHORS.alice, "Add API module with tests");
  // 2 — api.ts and api.test.ts change together again
  write("src/api.ts", "export function get() {\n  return 2;\n}\n");
  write("src/api.test.ts", "test('get', () => { expect(get()).toBe(2); });\n");
  commit(AUTHORS.alice, "Fix API return value and update test");
  // 3
  write("src/db.ts", "export const db = {};\n");
  commit(AUTHORS.bob, "Add database layer");
  // 4 — third co-change of api pair
  write("src/api.ts", "export function get() {\n  return 3;\n}\nexport function put() {}\n");
  write("src/api.test.ts", "test('get', () => {});\ntest('put', () => {});\n");
  commit(AUTHORS.bob, "Add put endpoint to API with test");
  // 5 — db + api together (only once)
  write("src/db.ts", "export const db = { connected: true };\n");
  write("src/api.ts", "import { db } from './db';\nexport function get() {\n  return 3;\n}\nexport function put() {}\n");
  commit(AUTHORS.carol, "Connect API to database");
  // 6 — rename
  gitIn(["mv", "src/db.ts", "src/database.ts"]);
  write("src/api.ts", "import { db } from './database';\nexport function get() {\n  return 3;\n}\nexport function put() {}\n");
  commit(AUTHORS.carol, "Rename db module to database");
  // 7 — binary file
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
  commit(AUTHORS.alice, "Add logo");
  // 8 — bulk commit touching 35 files: excluded from coupling
  for (let i = 0; i < 35; i++) write(`generated/file${i}.ts`, `export const n = ${i};\n`);
  commit(AUTHORS.bob, "Generate client stubs");
  // 9, 10 — a feature branch merged back with a merge commit
  gitIn(["checkout", "-q", "-b", "feature"], AUTHORS.carol);
  write("src/feature.ts", "export const feature = true;\n");
  commit(AUTHORS.carol, "Add feature flag");
  gitIn(["checkout", "-q", "main"], AUTHORS.alice);
  write("README.md", "# Demo\n\nNow with docs.\n");
  commit(AUTHORS.alice, "Document the project in README");
  gitIn(["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "Merge feature branch", "feature"], AUTHORS.alice);
  day++;
  // 12 — delete a generated file
  fs.rmSync(path.join(dir, "generated/file0.ts"));
  commit(AUTHORS.bob, "Remove unused stub");

  fs.rmSync(path.join(dir, ".no-global-config"), { force: true });
}
