import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBranch, checkRemoteUrl, resolveLocalRepo } from "@/lib/repo-source";

const hosts = ["github.com", "gitlab.com"];

describe("checkRemoteUrl", () => {
  it("accepts and normalises allowed https URLs", () => {
    expect(checkRemoteUrl("https://GitHub.com/owner/repo.git/", hosts)).toEqual({
      ok: true,
      normalized: "https://github.com/owner/repo.git",
    });
  });

  it.each([
    ["http://github.com/o/r", "https"],
    ["git@github.com:o/r.git", "valid URL"],
    ["file:///etc/passwd", "https"],
    ["https://user:pw@github.com/o/r", "credentials"],
    ["https://github.com:8443/o/r", "ports"],
    ["https://127.0.0.1/o/r", "not on the allowed list"],
    ["https://github.com.evil.example/o/r", "not on the allowed list"],
    ["https://localhost/o/r", "not on the allowed list"],
    ["https://github.com/o/r?x=1", "query"],
    ["https://github.com/only-owner", "owner/name"],
    ["https://github.com/o/../../r", "owner/name"],
  ])("rejects %s", (url, msg) => {
    const r = checkRemoteUrl(url, hosts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
});

describe("resolveLocalRepo", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grf-src-"));
    root = path.join(base, "repos");
    outside = path.join(base, "secret");
    fs.mkdirSync(path.join(root, "good", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "plain"), { recursive: true });
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      /* symlinks may be unavailable; that test then checks "does not exist" */
    }
  });
  afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

  it("accepts a git repository inside the root", () => {
    expect(resolveLocalRepo("good", root)).toEqual({ ok: true, normalized: "good" });
  });

  it.each(["../secret", "good/../../secret", "/etc", "C:\\Windows", "", "missing"])("rejects %j", (p) => {
    expect(resolveLocalRepo(p, root).ok).toBe(false);
  });

  it("rejects folders that are not repositories", () => {
    expect(resolveLocalRepo("plain", root)).toMatchObject({ ok: false, error: expect.stringContaining("not a git") });
  });

  it("rejects a symlink that points outside the root", () => {
    expect(resolveLocalRepo("link", root).ok).toBe(false);
  });
});

describe("checkBranch", () => {
  it.each(["main", "release/1.2", "feature_x-y"])("accepts %s", (b) => expect(checkBranch(b)).toBe(true));
  it.each(["--upload-pack=x", "-x", "a..b", "x.lock", "a b", "x/", ""])("rejects %j", (b) =>
    expect(checkBranch(b)).toBe(false),
  );
});
