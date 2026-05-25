# 04. Fusion: RRF with k=60 (and why not weighted combine)

## WHY

You're holding two ranked lists:
- `denseR.results` — 50 documents sorted by cosine
- `sparseR.results` — 50 documents sorted by `ts_rank_cd`

These lists overlap, but not entirely. On a typical HN corpus the top-50 overlap is ~20–30 documents. The remaining 20–30 in each list are unique. The fusion layer's job: combine them into a single top-50 list so that:
1. Documents in the top of both lists end up on top.
2. Documents in only one list don't get lost (we want recall).
3. This works **without score normalization**.

The third point is the entire point of RRF (Reciprocal Rank Fusion, Cormack et al., 2009). The alternative approach is **weighted score combine**:

```
final_score = α * normalize(dense_score) + (1 - α) * normalize(sparse_score)
```

Sounds simple, and many people do it. Weaviate's `hybrid` mode supports both variants; by default it uses `α = 0.75` (75% dense, 25% sparse) with min-max normalization. Elasticsearch from 8.x defaults to RRF, leaving weighted combine for "fine-tuning".

Problems with weighted addition:

1. **Normalization is a hyperparameter.** Min-max depends on the score range in a particular query. Z-score assumes a Gaussian distribution (which doesn't hold for BM25). If you normalize BM25 and cosine for weighted addition, normalization turns into a hyperparameter — it gets overfitted to the eval set, and a month later the numbers stop reflecting reality.

2. **α is also a hyperparameter.** Picked on the eval set, overfitted, sensitive to embedding-model swaps. I've seen projects where after switching `text-embedding-ada-002` → `text-embedding-3-small` α had to be recomputed from 0.7 to 0.45. Meaning a whole year of work picking α was thrown out.

3. **It silently fails on queries outside the usual distribution.** If in one query BM25 produced normalized ~0.001..0.9, and another query produced 0.4..0.5 — normalization "stretched" the scale differently, and α stopped meaning what you thought.

RRF avoids all of this by **completely ignoring score values**. Only ranks are used.

---

## HOW: the algorithm

```ts
// retrieve/fuse.ts in full
const RRF_K = 60;

export type RankItem = { id: number; rank: number };
export type FusedItem = { id: number; rrfScore: number };

export function rrfFuse(lists: RankItem[][], topK = 50): FusedItem[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const item of list) {
      const contribution = 1 / (RRF_K + item.rank);  // <-- heart of the algorithm
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    }
  }
  return Array.from(scores.entries())
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
```

20 lines. No settings other than `RRF_K = 60`. No normalizations.

The slice parameter is called `topK`, not `k`, so it doesn't shadow the module constant `RRF_K`. A minor detail, but shadow bugs of this kind are unpleasant to catch on review.

### The formula: 1 / (k + rank)

| Rank in list | Contribution at k=60 |
|---------------|----------------|
| 1             | 1/61 ≈ 0.0164  |
| 2             | 1/62 ≈ 0.0161  |
| 5             | 1/65 ≈ 0.0154  |
| 10            | 1/70 ≈ 0.0143  |
| 20            | 1/80 ≈ 0.0125  |
| 50            | 1/110 ≈ 0.0091 |

The shape of the function is **smooth, monotonically decreasing**. That matters. If it were `1 / rank` (no k constant), the first position's contribution would be 1.0, the second's 0.5, and a document at the top of one list would outrank any document that only made it into the other. The constant `k` "smooths out" the difference between the tops, giving a document that lands in both lists at middling positions a chance to outrank a solo leader.

### Why k=60

Cormack et al. (2009) tried values from 1 to 1000 on the TREC dataset and found that the sweet spot is `k ≈ 60`. Since then this has been the empirical standard.

Practitioners (Elasticsearch, OpenSearch, Azure AI Search, MongoDB Atlas, Weaviate) **all** use `k=60` as the default. Benchmarks on BEIR, MIRACL, MS MARCO consistently show that `k ∈ [40, 80]` gives comparable results. Outside that range:

- `k < 20` — the top-1 of a list dominates too much. Good if you trust one retriever more, bad if you don't.
- `k > 100` — the difference between top-1 and top-50 gets smeared, fusion becomes almost an "objection vote": "if the document is in both lists, no matter where, it goes to the top".

**When it breaks:** in an educational project, there's a big temptation to start "tuning k" on the eval set. Don't. You have 30 queries in the eval set — that's statistically too few to tune a hyperparameter, any improvement will be noise. Leave it at 60.

### A step-by-step example

Suppose two top-5 lists on the query `"vacuum freeze postgres"`:

```
Sparse (BM25):                    Dense:
1. comment_A  score=0.247         1. comment_B  score=0.412
2. comment_B  score=0.183         2. comment_C  score=0.398
3. comment_D  score=0.156         3. comment_A  score=0.372
4. comment_E  score=0.142         4. comment_F  score=0.355
5. comment_F  score=0.099         5. comment_G  score=0.341
```

RRF contributions:

```
comment_A: 1/61 + 1/63 = 0.01639 + 0.01587 = 0.03226     ← in both, top
comment_B: 1/62 + 1/61 = 0.01613 + 0.01639 = 0.03252     ← in both, even better
comment_C:          1/62                   = 0.01613
comment_D: 1/63                            = 0.01587
comment_E: 1/64                            = 0.01563
comment_F: 1/65 + 1/64 = 0.01538 + 0.01563 = 0.03101     ← in both, mid
comment_G:          1/65                   = 0.01538
```

Final order: `B (0.0325), A (0.0323), F (0.0310), C (0.0161), D (0.0159), E (0.0156), G (0.0154)`.

Note: `B` overtook `A` because `B`'s ranks are 2 and 1, while `A`'s are 1 and 3. The sum 1/62 + 1/61 is slightly larger than 1/61 + 1/63. A micro difference, but in the right direction.

Document `F`, which was at position 5 in BM25 (score=0.099, low) but at position 4 in dense, ended up **third** in the fused list. This is a typical hybrid-wins case: a document holding reasonable positions across both retrievers beats specialists of one signal type.

---

## HOW: integration in the pipeline

```ts
// retrieve/modes.ts (excerpt)
const poolSize = mode === 'fused-rerank' ? Math.max(50, FUSED_K_BEFORE_RERANK * 2) : 50;
const [denseR, sparseR] = await Promise.all([
  denseRetrieve(query, poolSize),
  sparseRetrieve(query, poolSize),
]);

const t0 = performance.now();
const fused = rrfFuse(
  [
    denseR.results.map((r) => ({ id: r.id, rank: r.rank })),
    sparseR.results.map((r) => ({ id: r.id, rank: r.rank })),
  ],
  poolSize,
);
const fuseMs = performance.now() - t0;
```

A few important points:

**`poolSize` depends on the mode.** For `fused` we take 50. For `fused-rerank` — `max(50, 40)` = 50: we need enough candidates that the first 20 after fusion are good. If poolSize is too small (10), the reranker sees already-filtered junk.

**`Promise.all` for parallelism.** Sparse and dense are independent — run them in parallel. Running them sequentially would add a needless ~10ms.

**Reattach payloads after fusion.**

```ts
const byId = new Map<number, RetrievalResult>();
for (const r of denseR.results) byId.set(r.id, r);
for (const r of sparseR.results) if (!byId.has(r.id)) byId.set(r.id, r);

const fusedDocs = fused.map((f, i) => {
  const base = byId.get(f.id);
  if (!base) return null;
  return { ...base, score: f.rrfScore, rank: i + 1 };
}).filter(x => x !== null);
```

`rrfFuse` works with a minimal `{ id, rank }` structure — deliberately. The fusion algorithm shouldn't know anything about what an HN comment is. After fusion we reattach the full payload by id from any source (preferring dense, falling back to sparse — both contain full documents).

The beauty: `rrfFuse` can be copied into any project unchanged. It's a pure function of two lists.

### Performance of the fusion layer

The fusion function itself is O(N log N), where N = sum of list sizes (typically 100). On my MacBook Air M2:

```
fuseMs: 0.4–0.8 ms
```

Less than a millisecond. RRF itself is free. The hybrid mode's latency is almost entirely determined by the parallel sparse + dense run (~35ms).

---

## Alternatives and why we rejected them

### 1. Linear combination with min-max normalization

```ts
const dScores = normalize(denseR.results.map(r => r.score));   // → [0, 1]
const sScores = normalize(sparseR.results.map(r => r.score));  // → [0, 1]
const combined = mergeById(dScores, sScores).map(item => ({
  id: item.id,
  score: 0.6 * item.dense + 0.4 * item.sparse,
}));
```

Sounds more transparent than RRF. Problems:
- The `normalize` function has to decide what to do with documents present in one list but not the other (score = 0? skip?).
- The 0.6/0.4 weights are a hyperparameter that depends on the model, corpus, and query types.
- With BM25's long tail (`ts_rank_cd` is heavily skewed) min-max compresses 95% of documents into `[0, 0.1]`.

### 2. Z-score normalization

The same, but via `(x - mean) / std`. Solves the skewness, but:
- On queries with few BM25 matches (e.g., a query of specific terms), `std` is small → z-score blows up.
- Assumes a Gaussian distribution, which for retrieval scores **does not** hold.

### 3. Conditional fusion (decide which retriever per query)

```ts
if (looksLikeKeywordQuery(query)) return sparseRetrieve(query);
else return denseRetrieve(query);
```

I saw this in several projects in 2024. The idea: classify the query, pick the retriever. Problems:
- `looksLikeKeywordQuery` itself becomes an ML model with errors.
- We lose recall: hybrid still covers both cases better than the correct choice of one.

### 4. Learned-to-rank on top of both signals

Train a gradient boosting model (XGBoost / LightGBM) with features `bm25_score, cosine, bm25_rank, cosine_rank, doc_length, ...`. Production-grade for large search systems. Not for an educational project with 30 queries — you'd need 1000+ labeled pairs.

---

## RRF failure modes

RRF isn't a panacea. Known limitations:

**Doesn't help if both retrievers bring the same information.** If you have two dense retrievers trained on similar data, their fusion gives almost the same as one. Hybrid works because sparse and dense **fail in different ways**. Check the overlap: if top-10 BM25 and top-10 dense intersect on 9 of 10 — RRF will add almost nothing.

**Sensitive to extremely long spam documents in BM25.** If the corpus has a wall-of-text document with 10K words that accidentally contains all the query tokens — it'll be at the top of BM25, then at the top of RRF. Fixed by a length filter at the indexing layer (we do `text.length < 100 → skip` at ingest).

**Doesn't account for retriever confidence.** A document at rank 1 in BM25 with `ts_rank_cd = 0.001` (a bad match) gets the same 1/61 contribution as a document at rank 1 with `ts_rank_cd = 0.8`. This is by design: RRF doesn't know what a "good" score means. But sometimes it's a downside. Fixed by the reranker at the next step — it covers this weakness.

**Three or more retrievers need thought.** RRF is a sum of contributions, symmetric across all lists. If you add ELSER (sparse neural) as a third source, it can outweigh because its documents stand at "good" positions in its lists. Solution — either pick per-retriever weight coefficients (`w_i / (k + rank_i)`), or compute "consensus" differently. For two retrievers this isn't a problem.

---

## What you get

After the fusion layer you have a single list of 50 documents ranked by `rrfScore`. That's the `fused` mode. On most queries it's better than either input:

```
nDCG@10:  BM25 0.61  →  Dense 0.68  →  Fused 0.74
Recall@5: BM25 0.55  →  Dense 0.61  →  Fused 0.68
Latency:  ~8ms       →  ~35ms      →  ~44ms (roughly max(BM25, Dense) + ~1ms fuse)
```

Latency barely grew — thanks to `Promise.all`. Quality went up by 6 points of nDCG.

Next — the reranker. It works on the top-20 of this list and reshuffles the first 10 so they're maximally relevant. That'll give another +9 points of nDCG, but at +120ms.
