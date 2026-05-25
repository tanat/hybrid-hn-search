import { describe, it, expect } from 'vitest';
import { dcg, ndcg, recallAtK, mrr } from '../score';

describe('score', () => {
  it('dcg of empty list is 0', () => {
    expect(dcg([], 10)).toBe(0);
  });

  it('ndcg of ideal ranking is 1', () => {
    const gold = new Map<number, number>([
      [1, 3],
      [2, 3],
      [3, 2],
      [4, 0],
      [5, 0],
    ]);
    expect(ndcg([1, 2, 3, 4, 5], gold, 5)).toBeCloseTo(1, 8);
  });

  it('ndcg of disjoint retrieval (zero relevant) is 0', () => {
    const gold = new Map<number, number>([
      [1, 3],
      [2, 2],
    ]);
    expect(ndcg([10, 11, 12], gold, 5)).toBe(0);
  });

  it('ndcg < 1 when ideal items are retrieved in reverse order', () => {
    const gold = new Map<number, number>([
      [1, 3],
      [2, 2],
      [3, 1],
    ]);
    const reversed = ndcg([3, 2, 1], gold, 3);
    expect(reversed).toBeLessThan(1);
    expect(reversed).toBeGreaterThan(0);
  });

  it('mrr returns 1/3 when first relevant is at rank 3', () => {
    const gold = new Map<number, number>([
      [10, 0],
      [11, 0],
      [12, 3],
      [13, 2],
    ]);
    expect(mrr([10, 11, 12, 13], gold)).toBeCloseTo(1 / 3, 10);
  });

  it('mrr returns 0 when no relevant in retrieved', () => {
    const gold = new Map<number, number>([[1, 3]]);
    expect(mrr([2, 3, 4], gold)).toBe(0);
  });

  it('recallAtK: 2 of 4 highly-relevant in top-5 → 0.5', () => {
    const gold = new Map<number, number>([
      [1, 3],
      [2, 3],
      [3, 2],
      [4, 2],
      [5, 0],
    ]);
    // Retrieved 2 of the 4 relevant (ids 1, 2; 3 and 4 not in top-5)
    expect(recallAtK([1, 2, 9, 8, 7], gold, 5)).toBeCloseTo(0.5, 10);
  });

  it('recallAtK: returns 0 when no items judged ≥ 2', () => {
    const gold = new Map<number, number>([
      [1, 0],
      [2, 1],
    ]);
    expect(recallAtK([1, 2], gold, 5)).toBe(0);
  });

  it('ndcg only counts top-k', () => {
    const gold = new Map<number, number>([
      [1, 3],
      [2, 0],
      [3, 0],
      [4, 3],
    ]);
    // top-2 retrieves [1, 2]: hits ideal at rank 1 only.
    const at2 = ndcg([1, 2, 4], gold, 2);
    expect(at2).toBeGreaterThan(0);
    expect(at2).toBeLessThan(1);
  });
});
