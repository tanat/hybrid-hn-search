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

export type RetrievalMode = 'bm25' | 'dense' | 'fused' | 'fused-rerank';
