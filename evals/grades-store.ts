// Helpers for the grading CLI's persistence + resume logic. Pulled out
// of the CLI itself so unit tests can exercise pause/resume without
// touching readline.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Grade = {
  query: string;
  comment_id: number;
  grade: 0 | 1 | 2 | 3;
  rationale?: string;
  graded_at: string;
  // 'human' (interactive CLI) or 'llm:<provider>' (auto-grader). Absent →
  // legacy entry, treat as 'human' for backwards compat. This is what
  // separates trustworthy gold from baseline noise in eval runs.
  grader?: string;
};

export type GradesStore = {
  // Map<query, Map<comment_id, Grade>>
  byKey: Map<string, Grade>;
};

export type CandidatePool = Record<string, number[]>;

export function loadGrades(path: string): GradesStore {
  if (!existsSync(path)) return { byKey: new Map() };
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return { byKey: new Map() };
  const arr = JSON.parse(raw) as Grade[];
  const byKey = new Map<string, Grade>();
  for (const g of arr) byKey.set(makeKey(g.query, g.comment_id), g);
  return { byKey };
}

export function saveGrades(path: string, store: GradesStore) {
  mkdirSync(dirname(path), { recursive: true });
  const arr = Array.from(store.byKey.values()).sort((a, b) => {
    if (a.query !== b.query) return a.query.localeCompare(b.query);
    return a.comment_id - b.comment_id;
  });
  writeFileSync(path, JSON.stringify(arr, null, 2));
}

export function makeKey(query: string, commentId: number): string {
  return `${query}\x00${commentId}`;
}

export type WorkItem = { query: string; comment_id: number };

/**
 * Walk queries in order; within each query walk candidate IDs in the order
 * they appear in the pool; skip any (query, id) already graded. Returns the
 * full ungraded list — use take(n) to slice.
 */
export function listUngraded(pool: CandidatePool, store: GradesStore): WorkItem[] {
  const out: WorkItem[] = [];
  for (const query of Object.keys(pool)) {
    for (const cid of pool[query]) {
      if (!store.byKey.has(makeKey(query, cid))) {
        out.push({ query, comment_id: cid });
      }
    }
  }
  return out;
}

export function recordGrade(store: GradesStore, g: Grade) {
  store.byKey.set(makeKey(g.query, g.comment_id), g);
}

export function totalCandidates(pool: CandidatePool): number {
  return Object.values(pool).reduce((acc, ids) => acc + ids.length, 0);
}
