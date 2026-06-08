import { supabase } from '../db/supabase';
import type { RetrievalResult } from './types';

export type SparseTimings = { retrieveMs: number };

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

export async function sparseRetrieve(
  query: string,
  k = 50,
): Promise<{ results: RetrievalResult[]; timings: SparseTimings }> {
  const t0 = performance.now();
  // Full-text / BM25-like scoring runs in the search_comments() RPC. The OR
  // semantics (lexeme extraction) and ts_rank_cd live in SQL — see
  // supabase/migrations/*_search_functions.sql.
  const { data, error } = await supabase.rpc('search_comments', {
    query_text: query,
    match_count: k,
  });
  const t1 = performance.now();
  if (error) {
    throw new Error(`search_comments RPC failed: ${error.message}`);
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

  return { results, timings: { retrieveMs: t1 - t0 } };
}
