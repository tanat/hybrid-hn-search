// Reciprocal Rank Fusion. k=60 is the canonical default from Cormack et al.
// (2009) and is robust enough that we don't tune it on this corpus.
const RRF_K = 60;

export type RankItem = { id: number; rank: number };

export type FusedItem = { id: number; rrfScore: number };

export function rrfFuse(lists: RankItem[][], topK = 50): FusedItem[] {
  const scores = new Map<number, number>();

  for (const list of lists) {
    for (const item of list) {
      const contribution = 1 / (RRF_K + item.rank);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    }
  }

  return Array.from(scores.entries())
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
