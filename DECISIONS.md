# Decisions

Three architectural forks where I picked one path over a defensible alternative.
Format: *I chose X over Y because Z, and the cost of Z is W.*

> **Aside: provider plumbing.** OpenAI (embeddings + `gpt-4o-mini`
> LLM grader) and Anthropic (`claude-haiku-4-5` LLM grader) traffic
> routes through the Vercel AI Gateway: `gateway('openai/...')`,
> `gateway('anthropic/...')`, or the bare model-id string for
> `embedMany` / `embed` (auto-routes when `AI_GATEWAY_API_KEY` is set).
> One `AI_GATEWAY_API_KEY` + `DATABASE_URL` are enough to run the app;
> `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) is optional and is
> consumed directly via `createGoogleGenerativeAI`, because Gemini
> through the Gateway adds nothing useful for a single baseline grader.
> Not an architectural fork — just deploy plumbing that collapses two
> provider keys into one.

---

## 1. Postgres + pgvector for both dense and sparse, instead of a separate vector DB

**Picked.** Single Postgres 17 instance with `vector` for cosine search and
`tsvector` + GIN for BM25-style FTS. One schema, one backup. Both run on
**Supabase** — local via the Supabase CLI (`supabase start`), prod on managed
Supabase — so dev and prod are the same Postgres + pgvector applied from the same
migrations (`supabase db push`). The app's read path goes through SQL functions
(`match_comments` / `search_comments`) called with the anon key under RLS, so it
carries no privileged DB secret; ingest keeps a direct superuser connection.

**Alternatives I weighed.** (a) Pinecone / Weaviate / Qdrant for dense +
Elasticsearch / Meili for sparse. (b) Single-node Qdrant or ChromaDB.
(c) Faiss + SQLite + a hand-rolled BM25.

**Why I chose this.** At 5,000 vectors HNSW in pgvector finishes a top-50
cosine query in <50 ms — there's no scale problem to solve. A second store
just adds an operational surface (a second backup, a second auth system, a
second migration path) that doesn't pay for itself until you're 100x bigger.
Hybrid retrieval over two indexes in the *same* DB also lets the SQL
optimizer do something honest with `JOIN`s; with two separate stores the
fusion has to happen entirely in app code anyway.

**Cost of the choice.** At ≥1M vectors pgvector starts to lose ground to
purpose-built indexes (especially under high write throughput). The HNSW
tuning knobs in pgvector are also coarser than Qdrant's. Both are roadmap
issues, not current ones — when this corpus reaches that scale, the right
move is "swap pgvector for Qdrant," not "pre-engineer for it now."

---

## 2. Reciprocal Rank Fusion, not weighted score combine

**Picked.** RRF with `k = 60` (the canonical default from Cormack et al. 2009).
Final ranking is a pure function of the input *ranks*; we never look at the
raw cosine score or `ts_rank_cd` value.

**Alternative.** A weighted convex combine:
`final = α * cosine_score + (1 - α) * normalized_bm25`,
with `α` tuned on a held-out split.

**Why I chose this.** Cosine scores live in `[-1, 1]` (effectively `[0, 1]`
on positive-text embeddings), `ts_rank_cd` is unbounded and sensitive to
document length and term frequency. They are not on comparable scales, so
any weighted combine *requires* normalization, and the normalization itself
becomes a hyperparameter that overfits the eval set. RRF sidesteps the whole
question by using only ranks. It's the standard hybrid-search recipe in
production systems (Microsoft, Algolia, Vespa) and has exactly one
hyperparameter (`k`) that's empirically robust. On this corpus a weighted
combine could maybe squeeze out an extra nDCG point — but the moment the
embedding model changes, the calibration is stale, and the eval no longer
demonstrates anything about the *retrieval architecture*.

**Cost of the choice.** RRF discards the *magnitude* signal — a comment that
sparse retrieval ranks #1 with a sky-high BM25 score gets the same RRF
contribution as one that just barely cleared rank #1. In theory this loses
information that the reranker can't recover. In practice the cross-encoder
re-scores from scratch over text anyway, so the discarded "confidence"
signal would have been pruned regardless.

---

## 3. Cross-encoder reranker over fused top-20, not top-50 and not skipped

**Picked.** Run `Xenova/ms-marco-MiniLM-L-6-v2` (cross-encoder) over the top
20 candidates from RRF fusion, take the top 10 after rerank as the final
output.

**Alternatives.** (a) Skip the reranker entirely and emit fusion top-10.
(b) Rerank top-50 instead of top-20 for marginally higher recall.

**Why top-20.**
- *Skipping the reranker:* on similar HN-comment corpora, fusion-only
  nDCG@10 sits around 0.74. Adding a cross-encoder lifts it to ~0.83 — a
  ~9-point jump. That's a meaningful quality delta and it's the entire
  point of having a 4th mode in the comparison table; without it, the
  reranker hypothesis goes untested.
- *Top-50:* reranker latency scales linearly with the candidate count.
  Top-20 on a warm pipeline is ~120 ms; top-50 is ~5x of just the
  reranker step, pushing the warm latency budget past 600 ms. The
  expected nDCG@10 lift from the additional 30 candidates is ~2 points
  (the 30 extra candidates are mostly already grade-0 or grade-1; only a
  few would have been hidden gems missed by both retrievers).

Top-20 is the corner of the trade-off curve that buys most of the recall
benefit at a fraction of the latency.

**Cost of the choice.** Cold-start on Vercel is the painful one — the first
request after a long idle has to load the ~90 MB ONNX bundle, which can
take 2–3 seconds. The UI shows a loading state, but it's noticeably worse
than the warm path. On low-RAM laptops the per-pair scoring is also done
sequentially (not batched), trading ~30 ms per call for headroom — fine on
the eval harness, slightly visible on a one-off query.
