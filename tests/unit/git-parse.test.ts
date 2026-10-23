import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "@/lib/git/run";
import { LOG_FORMAT, parseBlame, parseHunks, parseLog, parseLsTree, unquotePath } from "@/lib/git/parse";
import { AUTHORS, FIXTURE_COMMITS, createFixtureRepo } from "@/scripts/fixture-repo";

describe("unquotePath", () => {
  it("leaves ordinary paths alone", () => {
    expect(unquotePath("src/a b.ts")).toBe("src/a b.ts");
  });
  it("decodes C-style escapes and octal UTF-8 bytes", () => {
    expect(unquotePath('"tab\\there"')).toBe("tab\there");
    expect(unquotePath('"quote\\"d"')).toBe('quote"d');
    expect(unquotePath('"caf\\303\\251.txt"')).toBe("café.txt");
  });
});

describe("parseLog (synthetic)", () => {
  const sha = "a".repeat(40);
  const out =
    `\x1e${sha}\x1f${"b".repeat(40)}\x1fAlice\x1fALICE@Example.com\x1f2024-01-01T10:00:00+00:00` +
    `\x1f2024-01-01T10:00:00+00:00\x1fSubject\x1fLine one\nLine two\n\x1d\n\n` +
    `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\tsrc/a.ts\n` +
    `:000000 100644 ${"0".repeat(40)} ${"3".repeat(40)} A\timg.png\n` +
    `:100644 100644 ${"4".repeat(40)} ${"5".repeat(40)} R091\told name.ts\tnew name.ts\n` +
    `3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t2\told name.ts => new name.ts\n`;

  it("reads header fields, multi-line bodies and lower-cases e-mail", () => {
    const [c] = parseLog(out);
    expect(c.sha).toBe(sha);
    expect(c.parents).toEqual(["b".repeat(40)]);
    expect(c.authorEmail).toBe("alice@example.com");
    expect(c.body).toBe("Line one\nLine two");
  });

  it("pairs raw entries with numstat counts and handles binary files and renames", () => {
    const [c] = parseLog(out);
    expect(c.files).toEqual([
      { change: "M", oldPath: null, path: "src/a.ts", insertions: 3, deletions: 1 },
      { change: "A", oldPath: null, path: "img.png", insertions: null, deletions: null },
      { change: "R", oldPath: "old name.ts", path: "new name.ts", insertions: 2, deletions: 2 },
    ]);
  });
});

describe("parseHunks (synthetic)", () => {
  it("does not mistake a removed '-- ' line for a file header", () => {
    const sha = "c".repeat(40);
    const out =
      `\x1e${sha}\n\ndiff --git a/x.sql b/x.sql\nindex 1..2 100644\n--- a/x.sql\n+++ b/x.sql\n` +
      `@@ -3,2 +3 @@\n--- old comment\n-select 1;\n+select 2;\n` +
      `@@ -10 +9,0 @@\n-gone\n`;
    expect(parseHunks(out)).toEqual([
      { sha, path: "x.sql", oldStart: 3, oldLines: 2, newStart: 3, newLines: 1 },
      { sha, path: "x.sql", oldStart: 10, oldLines: 1, newStart: 9, newLines: 0 },
    ]);
  });

  it("attributes hunks of a deleted file to its old path", () => {
    const sha = "d".repeat(40);
    const out = `\x1e${sha}\n\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
    expect(parseHunks(out)[0].path).toBe("gone.ts");
  });
});

describe("parseBlame", () => {
  it("counts lines per author and ignores uncommitted lines", () => {
    const out = [
      "author-mail <A@x.com>", "\tline", "author-mail <a@x.com>", "\tline",
      "author-mail <b@x.com>", "\tline", "author-mail <not.committed.yet>", "\tline",
    ].join("\n");
    expect([...parseBlame(out)]).toEqual([["a@x.com", 2], ["b@x.com", 1]]);
  });
});

// The same parsers against real git output from the deterministic fixture repository.
describe("parsers against a real repository", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grf-fixture-"));
    createFixtureRepo(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const log = () =>
    git(["log", `--format=${LOG_FORMAT}`, "--raw", "--numstat", "-M", "--no-abbrev", "HEAD", "--"], { cwd: dir })
      .then(parseLog);

  it("reads every commit, newest first, including the merge", async () => {
    const commits = await log();
    expect(commits).toHaveLength(FIXTURE_COMMITS);
    expect(commits[0].subject).toBe("Remove unused stub");
    expect(commits.filter((c) => c.parents.length > 1).map((c) => c.subject)).toEqual(["Merge feature branch"]);
    expect(new Set(commits.map((c) => c.authorEmail))).toEqual(
      new Set(Object.values(AUTHORS).map((a) => a.email)),
    );
  });

  it("detects the rename, the binary file and the deletion", async () => {
    const files = (await log()).flatMap((c) => c.files);
    expect(files).toContainEqual(
      expect.objectContaining({ change: "R", oldPath: "src/db.ts", path: "src/database.ts" }),
    );
    expect(files).toContainEqual(
      expect.objectContaining({ change: "A", path: "logo.png", insertions: null }),
    );
    expect(files).toContainEqual(expect.objectContaining({ change: "D", path: "generated/file0.ts" }));
  });

  it("parses hunks, blame and the HEAD tree", async () => {
    const hunks = parseHunks(
      await git(["log", "-p", "-U0", "--format=%x1e%H", "-M", "--no-color", "HEAD", "--"], { cwd: dir }),
    );
    expect(hunks.some((h) => h.path === "src/api.ts")).toBe(true);

    const blame = parseBlame(await git(["blame", "--line-porcelain", "HEAD", "--", "src/api.ts"], { cwd: dir }));
    expect([...blame.values()].reduce((a, b) => a + b, 0)).toBe(5); // api.ts has 5 lines at HEAD

    const tree = parseLsTree(await git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], { cwd: dir }));
    expect(tree).toContain("src/database.ts");
    expect(tree).not.toContain("src/db.ts");
    expect(tree).not.toContain("generated/file0.ts");
  });
});
