import { createHash } from 'node:crypto';

// Deterministic short id for a query string. Used as the URL path parameter
// in /eval/[queryHash]; the page resolves it back by re-hashing each query.
export function queryHash(q: string): string {
  return createHash('sha1').update(q).digest('hex').slice(0, 10);
}
