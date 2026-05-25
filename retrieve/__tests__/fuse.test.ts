import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../fuse';

describe('rrfFuse', () => {
  it('returns empty for empty input', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('preserves order on identical lists', () => {
    const list = [
      { id: 1, rank: 1 },
      { id: 2, rank: 2 },
      { id: 3, rank: 3 },
    ];
    const fused = rrfFuse([list, list]);
    expect(fused.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it('places item that ranks #1 in both lists at the top', () => {
    const a = [
      { id: 7, rank: 1 },
      { id: 8, rank: 2 },
    ];
    const b = [
      { id: 7, rank: 1 },
      { id: 9, rank: 2 },
    ];
    const fused = rrfFuse([a, b]);
    expect(fused[0].id).toBe(7);
    // Score for #7 should be 2 / (60+1).
    expect(fused[0].rrfScore).toBeCloseTo(2 / 61, 10);
  });

  it('handles disjoint lists by including all items with mid scores', () => {
    const a = [
      { id: 1, rank: 1 },
      { id: 2, rank: 2 },
    ];
    const b = [
      { id: 3, rank: 1 },
      { id: 4, rank: 2 },
    ];
    const fused = rrfFuse([a, b]);
    expect(fused.map((x) => x.id).sort()).toEqual([1, 2, 3, 4]);
    // Items at rank 1 (in their respective list) get higher score than rank 2.
    const id1 = fused.find((x) => x.id === 1)!;
    const id2 = fused.find((x) => x.id === 2)!;
    expect(id1.rrfScore).toBeGreaterThan(id2.rrfScore);
  });

  it('respects k slicing', () => {
    const a = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, rank: i + 1 }));
    const fused = rrfFuse([a], 5);
    expect(fused).toHaveLength(5);
    expect(fused.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('aggregates contributions from three lists', () => {
    const a = [{ id: 1, rank: 1 }];
    const b = [{ id: 1, rank: 5 }];
    const c = [{ id: 1, rank: 10 }];
    const fused = rrfFuse([a, b, c]);
    expect(fused).toHaveLength(1);
    expect(fused[0].rrfScore).toBeCloseTo(1 / 61 + 1 / 65 + 1 / 70, 10);
  });
});
