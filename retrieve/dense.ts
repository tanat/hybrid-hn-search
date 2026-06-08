import { embed } from 'ai';
import { supabase } from '../db/supabase';
import type { RetrievalResult } from './types';

const MODEL_ID = 'openai/text-embedding-3-small';

export type DenseTimings = { embedMs: number; retrieveMs: number };

type MatchRow = {
  id: number;
  story_id: number;
  story_title: string;
  story_url: string | null;
  author: string;
  text: string;
  points: number;
  created_at: string;
  score: number;
};

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

  // pgvector cosine search runs in the match_comments() RPC; supabase-js sends
  // the embedding as a JSON array and PostgREST casts it to vector(1536).
  const { data, error } = await supabase.rpc('match_comments', {
    query_embedding: embedding,
    match_count: k,
  });
  const t2 = performance.now();
  if (error) {
    throw new Error(`match_comments RPC failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchRow[];
  const results: RetrievalResult[] = rows.map((r, i) => ({
    id: Number(r.id),
    story_id: Number(r.story_id),
    story_title: r.story_title,
    story_url: r.story_url,
    author: r.author,
    text: r.text,
    points: r.points,
    created_at: new Date(r.created_at).toISOString(),
    score: Number(r.score),
    rank: i + 1,
  }));

  return {
    results,
    timings: { embedMs: t1 - t0, retrieveMs: t2 - t1 },
  };
}
