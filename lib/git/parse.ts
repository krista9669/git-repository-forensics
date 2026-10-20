// Pure parsers for git's machine-readable output. No I/O, so they are unit-tested
// directly against captured output (tests/unit/git-parse.test.ts).

/** Header fields delimited by ASCII unit separators, terminated by a group separator. */
export const LOG_FORMAT = "%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%s%x1f%b%x1d";

export type ChangeKind = "A" | "M" | "D" | "R" | "C" | "T";

export type FileChange = {
  path: string;
  oldPath: string | null;
  change: ChangeKind;
  /** null when git reports the file as binary */
  insertions: number | null;
  deletions: number | null;
};

export type ParsedCommit = {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  body: string;
  files: FileChange[];
};

/**
 * Decodes a path that git wrapped in double quotes with C-style escapes
 * (it does this for paths containing control characters, quotes or backslashes).
 */
export function unquotePath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const simple: Record<string, number> = {
    n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92,
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = s[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseRawLine(line: string): Omit<FileChange, "insertions" | "deletions"> | null {
  // :100644 100644 <old-sha> <new-sha> M\tpath
  // :100644 100644 <old-sha> <new-sha> R087\told\tnew
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const meta = line.slice(0, tab).split(" ");
  const status = meta[meta.length - 1] ?? "";
  const paths = line.slice(tab + 1).split("\t").map(unquotePath);
  const kind = status[0];
  if (kind === "R" || kind === "C") {
    if (paths.length < 2) return null;
    return { change: kind, oldPath: paths[0], path: paths[1] };
  }
  if (kind === "A" || kind === "M" || kind === "D" || kind === "T") {
    return { change: kind, oldPath: null, path: paths[0] };
  }
  return null; // U (unmerged) / X (unknown) never occur in history
}

/**
 * Parses `git log --format=LOG_FORMAT --raw --numstat -M`.
 * git prints the raw lines and then the numstat lines for each commit in the
 * same order, so counts are matched to raw entries by position.
 */
export function parseLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of output.split("\x1e")) {
    if (!record.trim()) continue;
    const end = record.indexOf("\x1d");
    if (end < 0) continue;
    const fields = record.slice(0, end).split("\x1f");
    if (fields.length < 8) continue;
    const [sha, parents, authorName, authorEmail, authoredAt, committedAt, subject] = fields;
    const body = fields.slice(7).join("\x1f");

    // unparseable raw entries stay as null so positions still line up with numstat
    const raw: (Omit<FileChange, "insertions" | "deletions"> | null)[] = [];
    const counts: [number | null, number | null][] = [];
    for (const line of record.slice(end + 1).split("\n")) {
      if (line.startsWith(":")) {
        raw.push(parseRawLine(line));
      } else {
        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (m) counts.push([m[1] === "-" ? null : +m[1], m[2] === "-" ? null : +m[2]]);
      }
    }

    commits.push({
      sha,
      parents: parents ? parents.split(" ") : [],
      authorName: authorName.trim() || "(unknown)",
      authorEmail: authorEmail.trim().toLowerCase() || "(unknown)",
      authoredAt,
      committedAt,
      subject,
      body: body.trim(),
      files: raw.flatMap((r, i) =>
        r ? [{ ...r, insertions: counts[i]?.[0] ?? null, deletions: counts[i]?.[1] ?? null }] : [],
      ),
    });
  }
  return commits;
}

export type Hunk = {
  sha: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

function diffPath(p: string, prefix: "a/" | "b/"): string | null {
  const u = unquotePath(p.trim());
  if (u === "/dev/null") return null;
  return u.startsWith(prefix) ? u.slice(prefix.length) : u;
}

/**
 * Parses `git log -p -U0 --format=%x1e%H`. Hunk bodies are skipped by count,
 * not by sniffing the first character, so a removed line that itself starts
 * with "-- " cannot be mistaken for a file header.
 */
export function parseHunks(output: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const record of output.split("\x1e")) {
    const lines = record.split("\n");
    const sha = lines[0]?.trim();
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    let oldPath: string | null = null;
    let path: string | null = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("diff --git ")) {
        oldPath = path = null;
      } else if (line.startsWith("--- ")) {
        oldPath = diffPath(line.slice(4), "a/");
      } else if (line.startsWith("+++ ")) {
        path = diffPath(line.slice(4), "b/") ?? oldPath;
      } else if (line.startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m || !path) continue;
        const h: Hunk = {
          sha,
          path,
          oldStart: +m[1],
          oldLines: m[2] === undefined ? 1 : +m[2],
          newStart: +m[3],
          newLines: m[4] === undefined ? 1 : +m[4],
        };
        hunks.push(h);
        // skip the hunk body (plus any "\ No newline at end of file" markers)
        let remaining = h.oldLines + h.newLines;
        while (remaining > 0 && i + 1 < lines.length) {
          i++;
          if (!lines[i].startsWith("\\")) remaining--;
        }
        while (i + 1 < lines.length && lines[i + 1].startsWith("\\")) i++;
      }
    }
  }
  return hunks;
}

/** Counts lines per author e-mail in `git blame --line-porcelain` output. */
export function parseBlame(output: string): Map<string, number> {
  const owners = new Map<string, number>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("author-mail ")) continue;
    const email = line.slice(12).trim().replace(/^<|>$/g, "").toLowerCase();
    if (!email || email === "not.committed.yet") continue;
    owners.set(email, (owners.get(email) ?? 0) + 1);
  }
  return owners;
}

/** Parses NUL-separated `git ls-tree -r -z --name-only` output. */
export function parseLsTree(output: string): string[] {
  return output.split("\0").filter(Boolean);
}
