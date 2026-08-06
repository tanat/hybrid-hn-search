/**
 * Is the difference between two retrieval modes real, or is it thirty queries?
 *
 * The README of this project leads with a counter-consensus finding — that RRF
 * fusion *hurts* nDCG on this corpus — read off a gap between two means with
 * nothing attached to say how firm it is. Thirty queries is a small sample and
 * IR metrics are neither normal nor independent of the query, so the honest
 * instrument is a paired bootstrap: resample the queries, recompute the mean
 * difference, and report the interval it lands in.
 *
 * Paired matters. Both modes are scored on the same queries, and queries differ
 * from each other far more than modes differ from each other. Comparing
 * unpaired means throws away that structure and widens the interval for no
 * reason.
 */

export interface PairedComparison {
  meanDifference: number;
  /** 95% bootstrap interval on the mean difference (a − b). */
  low: number;
  high: number;
  /** Fraction of resamples where a beat b; a two-sided p-value follows from it. */
  pPositive: number;
  pValue: number;
  significant: boolean;
  n: number;
}

/** Deterministic PRNG, so a reported interval is reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Paired bootstrap over per-query scores.
 *
 * `a` and `b` must be aligned: index i is the same query in both.
 */
export function pairedBootstrap(
  a: number[],
  b: number[],
  { resamples = 10_000, seed = 20260806 } = {},
): PairedComparison {
  if (a.length !== b.length) throw new Error('paired bootstrap needs aligned per-query scores');
  const n = a.length;
  const diffs = a.map((x, i) => x - b[i]);
  const observed = mean(diffs);

  if (n === 0) {
    return { meanDifference: 0, low: 0, high: 0, pPositive: 0.5, pValue: 1, significant: false, n };
  }

  const rand = mulberry32(seed);
  const means: number[] = [];
  let positive = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)];
    const m = sum / n;
    means.push(m);
    if (m > 0) positive += 1;
  }
  means.sort((x, y) => x - y);

  const low = means[Math.floor(0.025 * resamples)];
  const high = means[Math.floor(0.975 * resamples)];
  const pPositive = positive / resamples;
  // Two-sided: how often the resampled difference lands on the wrong side of zero.
  const pValue = 2 * Math.min(pPositive, 1 - pPositive);

  return {
    meanDifference: observed,
    low,
    high,
    pPositive,
    pValue: Math.min(1, pValue),
    // The interval not spanning zero is the claim; the p-value is the same fact.
    significant: (low > 0 && high > 0) || (low < 0 && high < 0),
    n,
  };
}

/**
 * The best recall@k any system could achieve on a query.
 *
 * recall@5 cannot exceed 5/|relevant|. A query with twenty relevant comments
 * caps every mode at 0.25, so an unqualified "recall@5 = 0.23" reads as a bad
 * score when it may be most of what was available. Reporting the ceiling turns
 * the number back into something interpretable.
 */
export function recallCeiling(relevantCount: number, k: number): number | null {
  if (relevantCount === 0) return null;
  return Math.min(1, k / relevantCount);
}
