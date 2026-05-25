# 05. Cross-encoder reranking: more expensive, but more accurate

## WHY

After RRF-fusion you have top-50 candidates ordered by `rrfScore`. That's already decent — ~0.74 nDCG@10. But we know that among these 50, ~10 are actually relevant, and they're **not necessarily in the first ten**.

Why? Because both sparse and dense are **bi-encoder** approaches:
- BM25: `score(query, doc) = f(tf(q_token, doc), idf(q_token), len(doc))`. No interactions between query tokens.
- Dense: `score = cosine(embed(query), embed(doc))`. Query and document are encoded **independently**, then compared.

A bi-encoder is fast, but **doesn't see query and document simultaneously**. It can't tell that the word `"vacuum"` in the query refers to different things in the documents `"vacuum your house"` vs `"postgres VACUUM"`. The embedding of "vacuum" is the average across all contexts.

A **cross-encoder** works differently. It feeds `[CLS] query [SEP] document [SEP]` into a single transformer model and predicts a relevance score through the `[CLS]` token:

```
[CLS] postgres vacuum freeze [SEP] We hit vacuum freeze storms on... [SEP]
                                    ↓
                          BERT-style transformer
                                    ↓
                          [CLS] → linear → sigmoid → relevance score
```

Each query token, via self-attention, "sees" each document token. The model learns fine-grained interactions: "vacuum" near "postgres" — that's about the DB; "vacuum" near "cleaner" — that's about cleaning.

The cost: **a separate forward pass for each (query, doc) pair**. If you have 50 pairs in top-50 and each takes 6ms on CPU via ONNX — that's 300ms. For the UI that's already over the line.

That's why the pipeline:
1. **Bi-encoder retrievers** (sparse + dense) give top-50 with high recall, cheaply.
2. **RRF** combines them into one list.
3. **Cross-encoder** reranks only the **top-20** of that list → expensive, but few pairs.
4. Take top-10 after reranking.

This is the classic retrieve → rerank architecture. The standard for production search systems in 2026.

---

## HOW: model choice

Today's palette of rerank models:

| Model | Parameters | CPU Latency | Quality (BEIR) | Where it runs |
|--------|-----------|-------------|------------------|--------------|
| `Xenova/ms-marco-MiniLM-L-6-v2` | 22M | ~6 ms/pair | baseline | onnxruntime-web/node, free |
| `Xenova/ms-marco-MiniLM-L-12-v2` | 33M | ~10 ms/pair | +2-3 pts | same, slightly slower |
| `BAAI/bge-reranker-v2-m3` | 568M | ~50 ms/pair CPU, ~5 ms GPU | +5-7 pts, multilingual | ONNX or transformers, free |
| Cohere `rerank-3.5` | API | ~30 ms (network) | +5 pts vs MiniLM | API, $2/1K queries |
| Voyage `rerank-2` | API | ~40 ms | comparable to Cohere | API |
| Jina `reranker-v3` | API/self-hosted | ~188 ms total (Hit@1 81%) | top tier | API |
| nemotron rerank | API | ~243 ms (Hit@1 83%) | top tier | API |

We take `Xenova/ms-marco-MiniLM-L-6-v2`. Why this one specifically:

1. **Free.** No API keys, no network latency.
2. **22M parameters.** Fits in the browser via WebGPU, fits in Node ONNX without CUDA.
3. **Good enough for educational purposes.** Demonstrates an 8–10 nDCG point gain from reranking.
4. **Stable baseline.** It's still the most-cited model in reranker writeups — for its price/quality ratio.

If this were production:
- Multilingual / non-English corpus → `BAAI/bge-reranker-v2-m3` (heavier, but multilingual).
- Latency under 100ms critical → Cohere rerank-3.5 (API, ~30ms, $$).
- Maximum accuracy → Jina v3 or nemotron, but they're not free.

---

## HOW: code via `@huggingface/transformers`

```ts
// retrieve/rerank.ts (full version)
import { pipeline, env as transformersEnv } from '@huggingface/transformers';

transformersEnv.allowLocalModels = false;   // <-- don't look in local files
transformersEnv.allowRemoteModels = true;   // <-- download from HF Hub on first run

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

export async function rerank<T extends RerankableDoc>(
  query: string,
  docs: T[],
): Promise<RerankedDoc<T>[]> {
  if (docs.length === 0) return [];
  const model = await getReranker();
  const scored: RerankedDoc<T>[] = [];
  // Sequentially to avoid OOM and keep ONNX runtime happy on low-RAM machines.
  for (const d of docs) {
    const out = await model({ text: query, text_pair: d.text });
    const score = Array.isArray(out) ? out[0]?.score ?? 0 : 0;
    scored.push({ ...d, rerankerScore: score });
  }
  scored.sort((a, b) => b.rerankerScore - a.rrankerScore);
  return scored;
}
```

(in the original code there's no typo — `b.rerankerScore`. Shortened here.)

### Key points

**`pipeline('text-classification', ...)`** is the HuggingFace-style API from `@huggingface/transformers` (this is transformers.js, renamed starting from v3). Under the hood it loads ONNX weights and runs them via `onnxruntime-node` (in Node) or `onnxruntime-web` (in the browser).

**`{ text: query, text_pair: d.text }`** is the format for a cross-encoder. Under the hood it tokenizes as `[CLS] query [SEP] doc [SEP]`.

**Singleton via `rerankerPromise`** — the model loads once (~70MB of weights) on first access and gets cached. The second call uses the loaded one. This is important — if every search request loaded the model anew, latency would be seconds.

**Cold start.** The first request loads the model ~3–5 seconds (depends on disk and network, if it's not in the cache yet). In production: warm up on service startup. In `evals/harness.ts`:

```ts
console.log('Warming up reranker pipeline...');
await runRetrieval('fused-rerank', queries[0], K_FOR_METRICS);
```

— so the first honest measurement doesn't include the cold start.

**Sequentially, not in parallel.**

```ts
for (const d of docs) {
  const out = await model({ text: query, text_pair: d.text });
  // ...
}
```

Not `Promise.all`. Via ONNX Node, parallel calls pile onto one CPU core and sometimes OOM on large batches. Sequentially is slower in theory (can't parallelize), but more stable. On 20 pairs the difference isn't critical. If you had 200+ pairs — you'd need to do proper batched inference through ONNX session run with padding.

### Top-20, not top-50

In `retrieve/modes.ts`:

```ts
const FUSED_K_BEFORE_RERANK = 20;
// ...
const candidates = fusedDocs.slice(0, FUSED_K_BEFORE_RERANK);
const reranked = await rerank(query, candidates.map((c) => ({ id: c.id, text: c.text })));
```

Why 20? It's **picked by measurement**, not theoretically:

| Top-N into rerank | nDCG@10 | Rerank latency |
|----------------|---------|----------------|
| 10             | 0.80    | 60 ms          |
| 20             | 0.83    | 120 ms         |
| 30             | 0.835   | 180 ms         |
| 50             | 0.838   | 300 ms         |

`20 → 30 → 50` gives a marginal gain (+0.005, +0.003 nDCG), but doubles latency. Sweet spot — 20. On a different corpus the optimum might be 15 or 25, but the order of magnitude is stable.

**When it breaks:** if you pick `FUSED_K_BEFORE_RERANK = 5`, you get a "reranker on top of an overly tight prefilter": if the right document landed at position 7 after RRF, the reranker will never see it. On an educational corpus 20 is safe. In production with a heavy recall@k metric, you can move it into an env var.

### Vercel deploy: rerank disabled in prod

```ts
// retrieve/modes.ts
if (process.env.VERCEL && process.env.RERANK_IN_PROD !== '1') {
  return { mode, results: fusedDocs.slice(0, k), /* no rerank */ };
}
```

The `@huggingface/transformers + onnxruntime-node` bundle exceeds Vercel's 50MB function size limit. In prod we return `fused` without rerank, and run the eval table locally. This isn't "cutting corners" — it's correct decomposition: the eval table proves rerank is useful on your corpus; production hosting is a separate task (you need either a self-hosted Node server on a VPS, or the Cohere API).

---

## Performance details

### ONNX Runtime: WebGPU vs WASM vs Node

Transformers.js supports three backends:

| Backend | Where it runs | MiniLM-L6 latency on 20 pairs |
|--------|--------------|------------------------------|
| `onnxruntime-node` (WASM SIMD) | Node.js | ~120 ms |
| `onnxruntime-node` (CUDA) | Node.js + GPU | ~30 ms |
| `onnxruntime-web` (WebGPU) | Browser with WebGPU | ~80 ms |
| `onnxruntime-web` (WASM) | Any browser | ~150 ms |

A paradox: WebGPU in the browser is **not much faster** than Node-WASM for small models, because **GPU marshaling cost** dominates. WebGPU wins 10–15x only on large models (300M+ parameters) or large batches.

For MiniLM-L-6 (22M params) with a batch of 20 pairs, WASM in Node is fine. If you're deploying to an Edge/Browser environment, WebGPU gives a ~30–50% gain, not an order of magnitude.

### Memory

`Xenova/ms-marco-MiniLM-L-6-v2` weighs ~70 MB on disk, ~150 MB in memory after loading. In Node that's fine. In serverless (Vercel function size 50 MB) — NOT fine. That's why ML reranking in serverless is usually moved to a separate service or an external API.

---

## What the reranker buys you

Example. Query: `"why I left FAANG after 8 years"`.

```
After RRF-fusion (top-5):
  1. "I was at Google for 6 years. The tooling is incredible, but..."     (rank 1)
  2. "Stock vest schedule made me stay too long at a job I hated..."      (rank 2)
  3. "Big company SWE: 80% meetings, 20% code, 0% impact"                 (rank 3)
  4. "FAANG interview prep is a full-time job"                            (rank 4)
  5. "I miss the days when Google was Google"                             (rank 5)

After cross-encoder rerank (top-5):
  1. "I was at Google for 6 years. The tooling is incredible, but..."     (rerank 0.92)
  2. "After 12 YoE I went indie. Best decision I ever made..."            (rerank 0.89, was at position 9)
  3. "Stock vest schedule made me stay too long..."                       (rerank 0.85)
  4. "Big company SWE: 80% meetings..."                                   (rerank 0.74)
  5. "I left after 8 years of FAANG. Here's what changed me..."           (rerank 0.71, was at position 14)
```

The reranker pulled documents 9 and 14 up to positions 2 and 5, because it saw **direct answers to the query**, not just topical proximity. Document 4 ("FAANG interview prep") was at the top of RRF, but the reranker saw "this is about prep, not about leaving" — pushed it down.

This effect — **fine-grained relevance** — is exactly what's worth paying +120ms for.

---

## Reranker failure modes

**The model is poorly trained for the language/domain.** `ms-marco-MiniLM-L-6-v2` is trained on English MS MARCO (web questions and web pages). On Russian, on code, on medical text — it produces noise. Symptom: nDCG drops after rerank instead of growing. Fix: BGE-reranker-v2-m3 (multilingual) or fine-tune on your domain.

**Too long a document.** MiniLM-L-6 has a 512-token limit. A long comment gets truncated, the reranker sees only the beginning. Fixed by chunking + max score per chunk, but complicates the code.

**Reranker hallucinates relevance on keyword-rich documents.** Known since 2024: a cross-encoder may "overrate" a document that happens to contain many query tokens but is semantically irrelevant. On MiniLM-L-6 this effect is mild, on large models like BGE — more noticeable.

**Latency explodes on large doc text.** 6ms/pair is for short HN comments (~100–500 tokens). If your documents are 2000 tokens, it'll be 20–30ms/pair, top-20 = 500ms.

---

## What you get

After the reranker:

```
              nDCG@10  Recall@5  MRR    p50 latency
BM25           0.61     0.55    0.69       8 ms
Dense          0.68     0.61    0.74      35 ms
RRF-fused      0.74     0.68    0.78      44 ms
Fused+rerank   0.83     0.79    0.85     178 ms     ← +9 nDCG for +134 ms
```

This is your main artifact. The reranker paid for its milliseconds.

The next stage is **evals**. How did you get these numbers anyway? Who decided that a document is "relevant"? How do you avoid overfitting to the eval set?
