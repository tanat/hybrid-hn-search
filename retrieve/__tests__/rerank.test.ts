import { describe, it, expect } from 'vitest';
import { rerank } from '../rerank';

// Note: this test downloads ~90MB of ONNX weights on the first run,
// which can take 30+ seconds. Skipped on CI by default; set
// RUN_RERANK_TEST=1 to opt-in.
const enabled = process.env.RUN_RERANK_TEST === '1';

describe.runIf(enabled)('rerank', () => {
  it(
    'ranks the topical doc highest for "javascript closures"',
    async () => {
      const docs = [
        { id: 1, text: 'A closure is the combination of a function bundled with references to its surrounding state in JavaScript.' },
        { id: 2, text: 'Arrays in JavaScript provide push, pop, map, filter and other higher-order helpers.' },
        { id: 3, text: 'PostgreSQL queries can be optimized with proper indexes and EXPLAIN ANALYZE.' },
      ];
      const out = await rerank('javascript closures', docs);
      expect(out[0].id).toBe(1);
    },
    180_000,
  );
});
