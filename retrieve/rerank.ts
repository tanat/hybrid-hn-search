import { pipeline, env as transformersEnv } from '@huggingface/transformers';

// Don't try to fetch from local — always pull from HF Hub on first run, cached
// thereafter under ~/.cache/huggingface (or wherever transformers.js writes).
transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;

type RerankerModel = (
  input: { text: string; text_pair: string },
) => Promise<Array<{ label: string; score: number }>>;

let rerankerPromise: Promise<RerankerModel> | null = null;

async function getReranker(): Promise<RerankerModel> {
  if (!rerankerPromise) {
    rerankerPromise = pipeline(
      'text-classification',
      'Xenova/ms-marco-MiniLM-L-6-v2',
    ) as unknown as Promise<RerankerModel>;
  }
  return rerankerPromise;
}

export type RerankableDoc = { id: number; text: string };

export type RerankedDoc<T extends RerankableDoc> = T & { rerankerScore: number };

export async function rerank<T extends RerankableDoc>(
  query: string,
  docs: T[],
): Promise<RerankedDoc<T>[]> {
  if (docs.length === 0) return [];
  const model = await getReranker();
  const scored: RerankedDoc<T>[] = [];
  // Run scoring sequentially to avoid OOM on a large batch and to keep the
  // ONNX runtime happy on low-RAM laptops.
  for (const d of docs) {
    const out = await model({ text: query, text_pair: d.text });
    const score = Array.isArray(out) ? out[0]?.score ?? 0 : 0;
    scored.push({ ...d, rerankerScore: score });
  }
  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);
  return scored;
}
