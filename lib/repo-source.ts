import fs from "node:fs";
import path from "node:path";

export type SourceCheck =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

/**
 * Validates a remote repository URL. Only plain https URLs on an allow-listed
 * host are accepted: no credentials, no custom ports, no IP literals, no
 * query string. This, together with the git transport hardening in
 * lib/git/run.ts, stops the clone feature being used to reach internal hosts.
 */
export function checkRemoteUrl(input: string, allowedHosts: string[]): SourceCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Only https:// URLs are allowed." };
  if (url.username || url.password) {
    return { ok: false, error: "URLs must not contain credentials." };
  }
  if (url.port) return { ok: false, error: "Custom ports are not allowed." };
  if (url.search || url.hash) {
    return { ok: false, error: "URLs must not contain a query string or fragment." };
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    return { ok: false, error: `Host "${host}" is not on the allowed list (${allowedHosts.join(", ")}).` };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((s) => s === "." || s === ".." || !/^[\w.-]+$/.test(s))) {
    return { ok: false, error: "Expected a repository path like https://host/owner/name." };
  }
  return { ok: true, normalized: `https://${host}/${segments.join("/")}` };
}

/**
 * Resolves a local repository given relative to `root`. The real path (after
 * following symlinks) must stay inside `root`, so "../" or a symlink cannot
 * expose other parts of the disk.
 */
export function resolveLocalRepo(relative: string, root: string): SourceCheck {
  const rel = relative.trim().replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) {
    return { ok: false, error: "Give a folder name relative to the local repository root." };
  }
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
    real = fs.realpathSync(path.resolve(realRoot, rel));
  } catch {
    return { ok: false, error: "That folder does not exist under the local repository root." };
  }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { ok: false, error: "That folder is outside the local repository root." };
  }
  if (!fs.existsSync(path.join(real, ".git")) && !fs.existsSync(path.join(real, "HEAD"))) {
    return { ok: false, error: "That folder is not a git repository." };
  }
  return { ok: true, normalized: inside.split(path.sep).join("/") };
}

/** Branch names are passed to git as arguments, so restrict them tightly. */
export function checkBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
    !branch.includes("..") &&
    !branch.endsWith(".lock") &&
    !branch.endsWith("/")
  );
}
