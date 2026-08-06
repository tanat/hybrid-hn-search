import { describe, expect, it } from 'vitest';
import { pairedBootstrap, recallCeiling } from '../stats';

describe('pairedBootstrap', () => {
  it('is deterministic, so a published interval can be reproduced', () => {
    const a = [0.5, 0.6, 0.7, 0.4, 0.8];
    const b = [0.3, 0.4, 0.5, 0.2, 0.6];
    expect(pairedBootstrap(a, b)).toEqual(pairedBootstrap(a, b));
  });

  it('calls a consistent gap significant', () => {
    // Every query prefers a, by roughly the same margin.
    const a = Array.from({ length: 30 }, (_, i) => 0.5 + i * 0.001);
    const b = a.map((x) => x - 0.2);
    const c = pairedBootstrap(a, b);
    expect(c.meanDifference).toBeCloseTo(0.2, 3);
    expect(c.low).toBeGreaterThan(0);
    expect(c.significant).toBe(true);
    expect(c.pValue).toBeLessThan(0.05);
  });

  it('refuses to call a noisy gap significant', () => {
    // The mean favours a, but query to query the sign flips constantly. This is
    // the case the README's headline claim needed checking against.
    const a = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4, 0.55, 0.45];
    const b = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.45, 0.55];
    const c = pairedBootstrap(a, b);
    expect(c.significant).toBe(false);
    expect(c.low).toBeLessThan(0);
    expect(c.high).toBeGreaterThan(0);
  });

  it('reports the direction of the difference', () => {
    const worse = pairedBootstrap([0.1, 0.1, 0.1], [0.5, 0.5, 0.5]);
    expect(worse.meanDifference).toBeLessThan(0);
    expect(worse.high).toBeLessThan(0);
    expect(worse.significant).toBe(true);
  });

  it('narrows as queries are added', () => {
    const base = [0.6, 0.4, 0.7, 0.3];
    const small = pairedBootstrap(base, base.map((x) => x - 0.1));
    const large = pairedBootstrap(
      Array.from({ length: 10 }, () => base).flat(),
      Array.from({ length: 10 }, () => base).flat().map((x) => x - 0.1),
    );
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('rejects unaligned inputs rather than silently comparing the wrong queries', () => {
    expect(() => pairedBootstrap([0.1, 0.2], [0.1])).toThrow();
  });

  it('survives an empty comparison', () => {
    expect(pairedBootstrap([], [])).toMatchObject({ meanDifference: 0, significant: false, n: 0 });
  });
});

describe('recallCeiling', () => {
  it('caps recall@5 at 5/relevant', () => {
    // Twenty relevant comments means no mode can score above 0.25, so an
    // unqualified "recall@5 = 0.23" is close to the maximum, not a poor result.
    expect(recallCeiling(20, 5)).toBeCloseTo(0.25);
    expect(recallCeiling(7, 5)).toBeCloseTo(5 / 7);
  });

  it('is 1 when everything relevant fits in k', () => {
    expect(recallCeiling(3, 5)).toBe(1);
  });

  it('has no ceiling for a query with nothing relevant', () => {
    expect(recallCeiling(0, 5)).toBeNull();
  });
});
