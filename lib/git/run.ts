import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

// Hardening applied to every git invocation: only https may be used as a
// transport, redirects are not followed (so an allowed host cannot bounce
// the clone to an internal address), and git never prompts for credentials.
// Local repositories are read in place, never cloned, so file:// stays off.
const SAFE_CONFIG = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false",
  "-c", "core.quotepath=false",
  "-c", "credential.helper=",
];

export type GitOptions = {
  cwd?: string;
  timeoutMs?: number;
  /** Abort if stdout grows beyond this many bytes. */
  maxBytes?: number;
};

/**
 * Runs `git <args>` without a shell (arguments are never interpreted) and
 * resolves with stdout as UTF-8.
 */
export function git(args: string[], opts: GitOptions = {}): Promise<string> {
  const { cwd, timeoutMs = 300_000, maxBytes = 1024 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
      },
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let killedReason: string | null = null;

    const timer = setTimeout(() => {
      killedReason = `git ${args[0]} timed out after ${timeoutMs} ms`;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > maxBytes) {
        killedReason = `git ${args[0]} output exceeded ${maxBytes} bytes`;
        child.kill();
        return;
      }
      chunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 8192) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitError(`could not start git: ${e.message}`, null, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedReason) return reject(new GitError(killedReason, code, stderr));
      if (code !== 0) {
        const last = stderr.trim().split("\n").pop() ?? "";
        return reject(new GitError(`git ${args[0]} failed: ${last}`, code, stderr));
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
