export type CouplingEdge = {
  a: number;
  b: number;
  cochanges: number;
  /** P(b changes | a changes) */
  confidenceAB: number;
  /** P(a changes | b changes) */
  confidenceBA: number;
  /** |commits(a) ∩ commits(b)| / |commits(a) ∪ commits(b)| */
  jaccard: number;
};

export type CouplingOptions = {
  /** Commits touching more files than this are ignored (bulk reformatting, vendoring, ...). */
  maxFilesPerCommit: number;
  /** Pairs that changed together fewer times than this are dropped. */
  minCochanges: number;
};

/**
 * Computes logical (change) coupling between files from the sets of file ids
 * touched by each commit. Merge commits should be excluded by the caller.
 * Revision counts used for confidence/Jaccard come from the same filtered
 * commit set, so the ratios are always within [0, 1].
 */
export function computeCoupling(
  commitFileSets: Iterable<Iterable<number>>,
  opts: CouplingOptions,
): CouplingEdge[] {
  const revisions = new Map<number, number>();
  const pairs = new Map<string, number>();

  for (const set of commitFileSets) {
    const ids = [...new Set(set)].sort((x, y) => x - y);
    if (ids.length === 0 || ids.length > opts.maxFilesPerCommit) continue;
    for (const id of ids) revisions.set(id, (revisions.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}:${ids[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: CouplingEdge[] = [];
  for (const [key, co] of pairs) {
    if (co < opts.minCochanges) continue;
    const [a, b] = key.split(":").map(Number);
    const ra = revisions.get(a)!;
    const rb = revisions.get(b)!;
    edges.push({
      a,
      b,
      cochanges: co,
      confidenceAB: co / ra,
      confidenceBA: co / rb,
      jaccard: co / (ra + rb - co),
    });
  }
  return edges.sort((x, y) => y.jaccard - x.jaccard || y.cochanges - x.cochanges);
}
