import { describe, expect, it } from "vitest";
import { computeCoupling } from "@/lib/analysis/coupling";
import { DIMENSIONS, embed, tokenize, toPgVector } from "@/lib/analysis/embedding";

const opts = { maxFilesPerCommit: 30, minCochanges: 2 };

describe("computeCoupling", () => {
  it("computes co-change count, both confidences and Jaccard", () => {
    // file 1 in 4 commits, file 2 in 3, together in 2
    const edges = computeCoupling([[1, 2], [1, 2], [1], [1, 3], [2]], opts);
    expect(edges).toHaveLength(1);
    const [e] = edges;
    expect(e).toMatchObject({ a: 1, b: 2, cochanges: 2 });
    expect(e.confidenceAB).toBeCloseTo(2 / 4);
    expect(e.confidenceBA).toBeCloseTo(2 / 3);
    expect(e.jaccard).toBeCloseTo(2 / (4 + 3 - 2));
  });

  it("stores each pair once with a < b, whatever order files arrive in", () => {
    const edges = computeCoupling([[5, 2], [2, 5]], opts);
    expect(edges.map((e) => [e.a, e.b])).toEqual([[2, 5]]);
  });

  it("ignores commits above the size cap entirely, including their revision counts", () => {
    const big = Array.from({ length: 31 }, (_, i) => i + 1);
    const edges = computeCoupling([[1, 2], [1, 2], big], opts);
    expect(edges[0].jaccard).toBe(1);
  });

  it("drops pairs below the minimum and duplicates within a commit", () => {
    expect(computeCoupling([[1, 1, 2]], opts)).toEqual([]);
    expect(computeCoupling([[1, 1, 2]], { ...opts, minCochanges: 1 })[0].cochanges).toBe(1);
  });

  it("keeps all ratios within [0, 1]", () => {
    const sets = Array.from({ length: 200 }, (_, i) => [i % 7, (i * 3) % 11, (i * 5) % 13]);
    for (const e of computeCoupling(sets, { ...opts, minCochanges: 1 })) {
      for (const v of [e.confidenceAB, e.confidenceBA, e.jaccard]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("embedding", () => {
  it("tokenises, dropping stop words and single characters", () => {
    expect(tokenize("Fix the NULL-pointer in a parser (v2)")).toEqual(["fix", "null", "pointer", "parser", "v2"]);
  });

  it("returns a deterministic unit vector", () => {
    const v = embed("Fix login redirect bug")!;
    expect(v).toHaveLength(DIMENSIONS);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(embed("Fix login redirect bug")).toEqual(v);
  });

  it("puts similar messages closer than unrelated ones", () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    const a = embed("Fix login redirect bug")!;
    const b = embed("Fix redirect bug after login")!;
    const c = embed("Update dependency versions in package lock")!;
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
  });

  it("returns null for messages with no words and formats pgvector literals", () => {
    expect(embed("!!! ...")).toBeNull();
    expect(toPgVector([0.5, -0.25])).toBe("[0.5,-0.25]");
  });
});
