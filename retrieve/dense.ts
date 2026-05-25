import { embed } from 'ai';
import { db } from '../db/client';
import type { RetrievalResult } from './types';

const MODEL_ID = 'openai/text-embedding-3-small';

export type DenseTimings = { embedMs: number; retrieveMs: number };

export async function denseRetrieve(
  query: string,
  k = 50,
): Promise<{ results: RetrievalResult[]; timings: DenseTimings }> {
  const t0 = performance.now();
  const { embedding } = await embed({
    model: MODEL_ID,
    value: query,
  });
  const t1 = performance.now();

  const vectorLiteral = `[${embedding.join(',')}]`;

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
           1 - (e.embedding <=> ${vectorLiteral}::vector) AS score
    FROM embeddings e
    JOIN comments c ON c.id = e.comment_id
    ORDER BY e.embedding <=> ${vectorLiteral}::vector
    LIMIT ${k}
  `;
  const t2 = performance.now();

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

  return {
    results,
    timings: { embedMs: t1 - t0, retrieveMs: t2 - t1 },
  };
}
