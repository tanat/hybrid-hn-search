import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGrades,
  saveGrades,
  listUngraded,
  recordGrade,
  totalCandidates,
  type CandidatePool,
} from '../grades-store';

function mktmp() {
  const dir = mkdtempSync(join(tmpdir(), 'grades-store-'));
  return { dir, path: join(dir, 'grades.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('grades-store', () => {
  it('returns empty store when file does not exist', () => {
    const { path, cleanup } = mktmp();
    try {
      const s = loadGrades(path);
      expect(s.byKey.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('lists all candidates as ungraded for a fresh store', () => {
    const pool: CandidatePool = { foo: [1, 2, 3], bar: [10, 20] };
    const s = { byKey: new Map() };
    expect(listUngraded(pool, s)).toEqual([
      { query: 'foo', comment_id: 1 },
      { query: 'foo', comment_id: 2 },
      { query: 'foo', comment_id: 3 },
      { query: 'bar', comment_id: 10 },
      { query: 'bar', comment_id: 20 },
    ]);
    expect(totalCandidates(pool)).toBe(5);
  });

  it('skips already-graded items in listUngraded', () => {
    const pool: CandidatePool = { foo: [1, 2, 3] };
    const s = loadGrades('/nonexistent');
    recordGrade(s, { query: 'foo', comment_id: 2, grade: 3, graded_at: 'now' });
    expect(listUngraded(pool, s)).toEqual([
      { query: 'foo', comment_id: 1 },
      { query: 'foo', comment_id: 3 },
    ]);
  });

  it('save → load round-trip preserves grades', () => {
    const { path, cleanup } = mktmp();
    try {
      const s1 = { byKey: new Map() };
      recordGrade(s1, { query: 'q', comment_id: 5, grade: 2, rationale: 'meh', graded_at: 't0' });
      saveGrades(path, s1);
      expect(existsSync(path)).toBe(true);
      const s2 = loadGrades(path);
      expect(s2.byKey.size).toBe(1);
      const g = Array.from(s2.byKey.values())[0];
      expect(g.query).toBe('q');
      expect(g.comment_id).toBe(5);
      expect(g.grade).toBe(2);
      expect(g.rationale).toBe('meh');
    } finally {
      cleanup();
    }
  });

  it('resume picks up at first ungraded after partial completion', () => {
    const { path, cleanup } = mktmp();
    try {
      const pool: CandidatePool = { q1: [1, 2, 3], q2: [10, 11] };
      const s = { byKey: new Map() };
      recordGrade(s, { query: 'q1', comment_id: 1, grade: 3, graded_at: 't' });
      recordGrade(s, { query: 'q1', comment_id: 2, grade: 0, graded_at: 't' });
      saveGrades(path, s);

      // Re-load like a fresh CLI invocation.
      const s2 = loadGrades(path);
      const next = listUngraded(pool, s2);
      expect(next[0]).toEqual({ query: 'q1', comment_id: 3 });
      expect(next).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it('treats query+commentId as the dedup key (same id under different queries kept separate)', () => {
    const pool: CandidatePool = { qa: [42], qb: [42] };
    const s = { byKey: new Map() };
    recordGrade(s, { query: 'qa', comment_id: 42, grade: 3, graded_at: 't' });
    expect(listUngraded(pool, s)).toEqual([{ query: 'qb', comment_id: 42 }]);
  });
});
