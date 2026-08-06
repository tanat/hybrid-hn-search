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

/** Items a judge called relevant (grade >= 2) for this query. */
export function relevantIds(goldGrades: Map<number, number>): Set<number> {
  return new Set<number>([...goldGrades.entries()].filter(([, g]) => g >= 2).map(([id]) => id));
}

/**
 * Recall@k: of the items judged relevant, what fraction is in the top k?
 *
 * Returns null when the query has no relevant item at all. It used to return 0,
 * and the harness averaged that 0 in with the rest — so a query nobody could
 * score on dragged every mode down equally and made the corpus look harder than
 * it is. A query with no right answer measures nothing and belongs out of the
 * denominator, not in it at zero.
 *
 * Note the ceiling: recall@5 cannot exceed 5/|relevant|. See recallCeiling in
 * stats.ts — an unqualified 0.23 is not obviously a bad score.
 */
export function recallAtK(
  retrieved: number[],
  goldGrades: Map<number, number>,
  k: number,
): number | null {
  const relevant = relevantIds(goldGrades);
  if (relevant.size === 0) return null;
  const inTopK = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return inTopK / relevant.size;
}

/**
 * Reciprocal rank of the first relevant item; the harness averages across
 * queries to get MRR.
 *
 * Null when the query has no relevant item, for the same reason as recall.
 * Zero is still returned — correctly — when relevant items exist and the mode
 * found none of them in the retrieved list: that is a real miss.
 */
export function mrr(retrieved: number[], goldGrades: Map<number, number>): number | null {
  if (relevantIds(goldGrades).size === 0) return null;
  for (let i = 0; i < retrieved.length; i++) {
    if ((goldGrades.get(retrieved[i]) ?? 0) >= 2) return 1 / (i + 1);
  }
  return 0;
}
