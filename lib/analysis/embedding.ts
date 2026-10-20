// Commit-message vectors for pgvector similarity search.
//
// Uses the "hashing trick": every word and adjacent word pair is hashed into
// one of DIMENSIONS buckets with a pseudo-random sign, then the vector is
// L2-normalised so cosine distance compares messages by shared vocabulary.
// It is deterministic, needs no model download or external API, and works
// offline — good enough to find "commits like this one" by wording.

export const DIMENSIONS = 256;

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have in into is it its of on or " +
    "that the this to was were will with").split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function add(vec: number[], feature: string, weight: number): void {
  const h = fnv1a(feature);
  const sign = (h & 0x80000000) === 0 ? 1 : -1;
  vec[h % DIMENSIONS] += sign * weight;
}

/** Returns a unit vector, or null when the text has no usable words. */
export function embed(text: string): number[] | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const vec = new Array<number>(DIMENSIONS).fill(0);
  for (let i = 0; i < tokens.length; i++) {
    add(vec, tokens[i], 1);
    if (i + 1 < tokens.length) add(vec, `${tokens[i]} ${tokens[i + 1]}`, 0.5);
  }
  const norm = Math.hypot(...vec);
  if (norm === 0) return null;
  return vec.map((v) => v / norm);
}

/** pgvector text literal, e.g. "[0.1,0.2]". */
export function toPgVector(vec: number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? +v.toFixed(6) : 0)).join(",")}]`;
}
