# 01. Mental model: four layers of hybrid search

## WHY

Until 2022–2023, the standard RAG advice was: "embed, drop into a vector DB, search by cosine". In 2024 the industry started moving back to BM25 — it suddenly turned out that dense retrieval often loses to plain full-text search on short technical queries. By 2026 all the major engines (Elasticsearch, OpenSearch, Vespa, Weaviate, Qdrant, MongoDB Atlas, pgvector + Postgres FTS) support hybrid search out of the box. This is no longer exotic, it's the default.

Hybrid search works because **the relevance signals from sparse and dense models are of different natures and often don't overlap**:

- **Sparse (BM25)** considers a document relevant if it contains the exact tokens from the query and those tokens are rare in the corpus. This is a lexical-match signal. It works by tf-idf with a document-length correction.
- **Dense (cosine over embeddings)** considers a document relevant if its embedding is close to the query embedding in a single space. This is a semantic-similarity signal, learned by the model on pairs of "query — relevant document".

They **fail in different ways**. BM25 doesn't understand synonyms or paraphrase. Dense misses rare terms (names, versions, error codes) because the embedding "smears" them across the semantic cloud. By combining them, you compensate for the weaknesses of each.

Next — the **reranker**. A bi-encoder (everything we did above) encodes query and document independently, then compares the vectors. A cross-encoder feeds `[query, document]` into one model and predicts the score directly. More accurate, but 1–2 orders of magnitude slower. That's why it only runs on a short list (top-20) sorted by the cheap retrievers.

That's four layers in total. Each subsequent layer:
1. Does something qualitatively new that the previous one doesn't.
2. Costs milliseconds.
3. Must justify those milliseconds with metric gains on your eval set.

If the last point doesn't hold — the layer isn't needed. That's the whole point of an evening spent on evals.

---

## HOW

### Four modes side by side

```
┌──────────────────────┬──────────────────────┬──────────────────────┬──────────────────────┐
│  BM25                │  Dense               │  RRF Fused           │  Fused + Rerank      │
│  sparse only         │  dense only          │  sparse + dense      │  + cross-encoder     │
├──────────────────────┼──────────────────────┼──────────────────────┼──────────────────────┤
│  tsvector + GIN      │  pgvector + HNSW     │  two queries +       │  fused + ONNX        │
│  ts_rank_cd          │  embed() + <=>       │  rrfFuse()           │  pipeline()          │
│                      │                      │                      │                      │
│  ~8 ms               │  ~35 ms              │  ~44 ms              │  ~178 ms             │
│  (one SQL query)     │  (embed + SQL)       │  (parallel + fuse)   │  (+ 20 × cross-enc)  │
└──────────────────────┴──────────────────────┴──────────────────────┴──────────────────────┘
```

The exact number of modes (4) matters: fewer — you won't see the gain of each layer; more — the eval table becomes unreadable. This is the standard set for academic and industry hybrid-search benchmarks.

### Layer 1. Sparse retrieval (BM25 via `tsvector`)

```ts
// retrieve/sparse.ts (simplified)
const rows = await db`
  SELECT c.id, c.text,
         ts_rank_cd(c.text_search, plainto_tsquery('english', ${query})) AS score
  FROM comments c
  WHERE c.text_search @@ plainto_tsquery('english', ${query})  // <-- GIN index lookup
  ORDER BY score DESC
  LIMIT ${k}
`;
```

`plainto_tsquery` is a safe parser for arbitrary user input: it never throws on weird punctuation, unlike `to_tsquery`. `ts_rank_cd` is cover density, better than `ts_rank` for short queries. The GIN index over `text_search` makes the lookup O(log n).

**When BM25 wins:** precise terms, names, versions, error codes, rare tokens. If the query contains `"pgvector HNSW"` or `"useEffect cleanup"` — BM25 finds documents where those literal strings appear, better than any embedding.

**When BM25 fails:** queries with no shared tokens with the relevant documents. `"why senior engineers leave bigtech"` — the relevant comments may be talking about "burnout", "stock vest", "no growth", without using the words "senior" and "leave".

### Layer 2. Dense retrieval (pgvector cosine)

```ts
// retrieve/dense.ts (simplified)
const { embedding } = await embed({ model: 'openai/text-embedding-3-small', value: query });
const rows = await db`
  SELECT c.id, c.text, 1 - (e.embedding <=> ${vectorLiteral}::vector) AS score
  FROM embeddings e
  JOIN comments c ON c.id = e.comment_id
  ORDER BY e.embedding <=> ${vectorLiteral}::vector  // <-- HNSW index
  LIMIT ${k}
`;
```

`<=>` is the cosine distance operator in pgvector. Caveat: the operator must appear in `ORDER BY` in identical form for the planner to use the HNSW index (this is a typical trap — wrap a function around it and you get a seq scan on 5000 rows that seems to work, then breaks at 500K).

**When dense wins:** paraphrase, different phrasings of the same idea, conceptual queries. `"how to motivate a team"` finds "team morale", "engagement", "burnout prevention" — words from the query may not appear in those comments at all.

**When dense fails:** rare terms. The embedding of `"pgvector HNSW m=16"` will be similar to the embedding of `"vector indexes in postgres"` — and the actual comment about specific HNSW parameters may end up somewhere at position 30.

### Layer 3. Fusion (RRF)

Two top-50 lists → one. Without score normalization:

```ts
// retrieve/fuse.ts
const RRF_K = 60;
export function rrfFuse(lists: RankItem[][], topK = 50): FusedItem[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const item of list) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (RRF_K + item.rank));
      //                                                  ↑ rank only, not score
    }
  }
  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
```

The magic is in the simplicity: the formula uses **only the position in the list**, not the score itself. A document at position 1 in any list contributes `1/61 ≈ 0.0164`. At position 50 — `1/110 ≈ 0.0091`. A document that lands in the top of both lists sums its contributions and outranks documents that only appear in one.

**When it breaks:** if you normalize BM25 and cosine for a weighted sum of the form `α * dense + (1-α) * sparse`, normalization turns into a hyperparameter. It gets overfitted to the eval set, and a month later, when you swap the embedding model or add documents, the numbers stop reflecting reality. With RRF this doesn't happen — ranks are scale-invariant.

### Layer 4. Cross-encoder reranker

```ts
// retrieve/rerank.ts (simplified)
const model = await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2');
for (const d of docs) {
  const out = await model({ text: query, text_pair: d.text });
  //                       ↑ query and document in a single forward-pass
  scored.push({ ...d, rerankerScore: out[0].score });
}
```

A bi-encoder (embed query, embed doc, cosine) gives **similarity** in a shared space. A cross-encoder gives a **relevance score** directly — it sees the query and document tokens at the same time and accounts for their interaction through self-attention. It's a qualitatively different model.

The cost is linear in the number of candidates: 20 pairs × ~6ms via ONNX on a laptop ≈ 120ms. On a GPU (WebGPU in the browser or CUDA via `onnxruntime-node`) — 10–15x faster on large models, but for the 22M-parameter MiniLM on a batch of 20 the difference is small: marshaling cost eats up the GPU speedup.

**Why top-20 specifically:** at top-50 this is already ~300ms, the gain is 1–2 points of nDCG. Picked by measurement, not theory.

---

## Latency budget

In the UI the expected latency is `<200ms` p50 for interactive search. Budget:

| Layer | p50 | p95 | Can it be moved out? |
|------|-----|-----|-------------------|
| embed query | 25ms | 60ms | no (one network call) |
| sparse SQL | 8ms | 18ms | no, already fast |
| dense SQL | 10ms | 25ms | no, HNSW already gives O(log n) |
| RRF fuse | <1ms | <1ms | no point |
| cross-encoder × 20 | 120ms | 180ms | yes: APIs like Cohere (~30ms), but $$ |
| **fused-rerank total** | **~165ms** | **~290ms** | |

If you don't fit in this budget — the first thing to cut is the number of candidates in rerank (20 → 10 → 5), not the layer itself. The cross-encoder gives such a large gain that dropping it is the last resort.

---

## Recall vs Precision and what fusion has to do with it

- **Recall@k** — what fraction of relevant documents did we return in the top-k. If there are 5 relevant ones in the corpus and we returned 3 — recall@10 = 0.6.
- **Precision@k** — what fraction of the top-k is actually relevant. We returned 10, 4 are relevant — precision@10 = 0.4.

Sparse and dense retrieval both target **recall**: give me the top-50 candidates so that everything I need is among them. RRF lifts recall even higher by combining them. The reranker targets **precision@k for small k** (typically k=10): from 20 candidates, it reshuffles so the first 5–10 are maximally relevant.

This is the structural reason the pipeline looks the way it does: cheap retrievers give high recall at large k, the expensive reranker gives high precision at small k. You can't reverse it: a cross-encoder over the entire corpus = tens of seconds per query.

---

## Where it breaks

- **Corpus too small** (< 1000 documents). At that volume the difference between modes gets lost in the noise, because any reasonable strategy will find the relevant ones in top-20 just by coincidence. Hybrid wins at 5K–500K. Beyond that — other problems (HNSW approximation, metadata filtering).
- **Queries too homogeneous.** If all 30 queries in your eval set are `"how to X"` about code, the difference between sparse and dense will be minimal. Deliberately mix them: technical terms, paraphrase, conceptual questions, proper names.
- **Reranker model unsuitable for the language/domain.** `ms-marco-MiniLM-L-6-v2` was trained on English MS MARCO. On Russian or code it produces noise — you need a different checkpoint (BGE reranker v2 m3 for multilingual, for example).
- **Embeddings don't get refreshed.** If you swap the model (from `text-embedding-3-small` to `text-embedding-3-large` or to `voyage-3`), all vectors need to be recomputed. RRF saves you from a fusion scale change, but not from the obligation to re-embed the corpus.

---

## Connection to the next stages

The next stage (02-ingest) is about how to assemble this corpus: HN Algolia → Postgres → embeddings via `embedMany`. Then each of the four layers (sparse, dense, fusion, rerank) is taken apart separately. The final stage (evals) brings all four into one table and does the thing this was all started for: shows the numbers.
