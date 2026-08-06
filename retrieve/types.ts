export type RetrievalResult = {
  id: number;
  story_id: number;
  story_title: string;
  story_url: string | null;
  author: string;
  text: string;
  points: number;
  created_at: string;
  score: number;
  rank: number;
};

/**
 * `dense-rerank` exists because the README recommends it.
 *
 * The eval measured bm25, dense, fused and fused+rerank, concluded that BM25
 * fusion is a net negative on this corpus, and told the reader the right stack
 * is dense + rerank — a configuration that was never run. This adds it, so the
 * recommendation is a measurement instead of an inference.
 */
export type RetrievalMode = 'bm25' | 'dense' | 'fused' | 'fused-rerank' | 'dense-rerank';
