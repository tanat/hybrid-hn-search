import { db } from '../db/client';
import type { RetrievalResult } from './types';

export type SparseTimings = { retrieveMs: number };

export async function sparseRetrieve(
  query: string,
  k = 50,
): Promise<{ results: RetrievalResult[]; timings: SparseTimings }> {
  const t0 = performance.now();
  // plainto_tsquery is the safe choice for free-text user input;
  // it never throws on weird punctuation. (to_tsquery does.)
  // plainto_tsquery uses AND — all terms must be present, which returns near-zero
  // results on a small corpus. Convert to OR by extracting individual lexemes so
  // ts_rank_cd can score by term frequency (BM25-like behaviour).
  const rows = await db<
    Array<{
      id: number;
      story_id: number;
      story_title: string;
      story_url: string | null;
      author: string;
      text: string;
      points: number;
      created_at: Date;
      score: number;
    }>
  >`
    SELECT c.id, c.story_id, c.story_title, c.story_url, c.author, c.text,
           c.points, c.created_at,
           ts_rank_cd(c.text_search, query) AS score
    FROM comments c,
         to_tsquery('english',
           array_to_string(
             ARRAY(SELECT lexeme FROM unnest(to_tsvector('english', ${query}))),
             ' | '
           )
         ) query
    WHERE c.text_search @@ query
    ORDER BY score DESC
    LIMIT ${k}
  `;
  const t1 = performance.now();

  const results: RetrievalResult[] = rows.map((r, i) => ({
    id: Number(r.id),
    story_id: Number(r.story_id),
    story_title: r.story_title,
    story_url: r.story_url,
    author: r.author,
    text: r.text,
    points: r.points,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    score: Number(r.score),
    rank: i + 1,
  }));

  return { results, timings: { retrieveMs: t1 - t0 } };
}
