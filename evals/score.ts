// IR metrics. All take retrieved IDs (in rank order) and a Map<id, grade>.

export function dcg(grades: number[], k: number): number {
  return grades.slice(0, k).reduce((sum, g, i) => {
    return sum + (Math.pow(2, g) - 1) / Math.log2(i + 2);
  }, 0);
}

export function ndcg(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const grades = retrieved.slice(0, k).map((id) => goldGrades.get(id) ?? 0);
  const idealGrades = [...goldGrades.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(idealGrades, k);
  if (idealDcg === 0) return 0;
  return dcg(grades, k) / idealDcg;
}

/**
 * Recall@k is "of the items judged highly relevant (grade ≥ 2), what fraction
 * appears in the top-k retrieved?". If there are no highly-relevant items
 * judged for this query, return 0 (no signal — consistent with not contributing).
 */
export function recallAtK(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const relevant = new Set<number>(
    [...goldGrades.entries()].filter(([, g]) => g >= 2).map(([id]) => id),
  );
  if (relevant.size === 0) return 0;
  const inTopK = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return inTopK / relevant.size;
}

/**
 * Mean Reciprocal Rank — but here we compute per-query reciprocal rank;
 * the harness averages across queries.
 */
export function mrr(retrieved: number[], goldGrades: Map<number, number>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if ((goldGrades.get(retrieved[i]) ?? 0) >= 2) return 1 / (i + 1);
  }
  return 0;
}
