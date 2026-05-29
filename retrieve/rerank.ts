import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  env as transformersEnv,
} from '@huggingface/transformers';

// Don't try to fetch from local — always pull from HF Hub on first run, cached
// thereafter under ~/.cache/huggingface (or wherever transformers.js writes).
transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

// ms-marco cross-encoders have num_labels=1: they output a single raw logit,
// not a probability. The text-classification pipeline wraps it in sigmoid()
// which saturates to 1.0 for any logit > ~5 — all docs look identical.
// We use the lower-level API to get the raw logit directly for ranking.
let loadPromise: Promise<{ tokenizer: unknown; model: unknown }> | null = null;

async function getReranker() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID),
    ]).then(([tokenizer, model]) => ({ tokenizer, model }));
  }
  return loadPromise;
}

export type RerankableDoc = { id: number; text: string };
export type RerankedDoc<T extends RerankableDoc> = T & { rerankerScore: number };

export async function rerank<T extends RerankableDoc>(
  query: string,
  docs: T[],
): Promise<RerankedDoc<T>[]> {
  if (docs.length === 0) return [];
  const { tokenizer, model } = await getReranker();
  const scored: RerankedDoc<T>[] = [];
  for (const d of docs) {
    const inputs = (tokenizer as (q: string, opts: object) => object)(query, {
      text_pair: d.text,
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const { logits } = await (model as (inputs: object) => Promise<{ logits: { data: Float32Array } }>)(inputs);
    scored.push({ ...d, rerankerScore: logits.data[0] });
  }
  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);
  return scored;
}
