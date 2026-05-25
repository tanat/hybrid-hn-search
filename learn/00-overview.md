# Learning Map — Hybrid HN Search

Project 04 is about how search actually works in production. Not "embed → drop into Pinecone → search by cosine" — but a four-layer pipeline where each subsequent layer has to pay for its milliseconds with a concrete nDCG gain. And you see that gain in a table, not in a marketing blog post.

The corpus is 5000 HN comments from the last 12 months, pulled from Algolia. The task is to find top-10 for an arbitrary query. Input: four retrieval modes. Output: numbers proving the order of layers.

---

## Why this project specifically

Most RAG tutorials stop at "embed → vector DB → cosine". That works on a demo, but on a real corpus you quickly hit:

- **Queries with concrete terms.** `"pgvector HNSW m=16"` — dense retrieval will return "something about vector indexes", but won't find the document with the literal string `m=16`. That's sparse retrieval's job. BM25 (via Postgres tsvector) catches this in ~8ms without a single API call.
- **Paraphrased queries.** `"why senior engineers leave bigtech"` — this topic has no fixed vocabulary, every comment phrases it its own way. Dense wins here: cosine over embeddings catches the semantics.
- **Different ranking signals say different things.** BM25 says "this document has many query words". Cosine says "this is semantically close". They don't contradict, they complement. Combined — usually better than either alone.
- **Ranking ≠ scoring.** BM25 produces unbounded `ts_rank_cd` (depends on document length). Cosine is `[-1, 1]`. Adding them directly is a path to manual normalization, normalization becomes a hyperparameter, the hyperparameter gets overfitted to the eval set, and a month later the numbers stop reflecting reality. RRF (Cormack 2009, k=60) is the only fusion step you can leave untouched when you switch the embedding model.
- **Cross-encoder reranker** is a separate model that sees query and document simultaneously, rather than comparing two independent vectors. An order of magnitude more expensive (even on the small `ms-marco-MiniLM-L-6-v2`), but on top-20 it gives +9 nDCG@10 points for ~120ms on a laptop via ONNX.

This project is about how to put all these pieces together, and most importantly — how to prove they work on your corpus. The proof is an eval table, not intuition.

---

## Final artifact

```
              nDCG@10  Recall@5  MRR    p50 latency
BM25           0.61     0.55     0.69      8 ms
Dense          0.68     0.61     0.74     35 ms
RRF-fused      0.74     0.68     0.78     44 ms
Fused+rerank   0.83     0.79     0.85    178 ms
```

Your specific numbers will be your own — corpus and the query list affect everything. But the order of layers reproduces in most cases: hybrid > dense, dense > BM25, rerank > everything. If yours don't — that's the most interesting information. It means either the corpus is specific (e.g., pure code), or your eval set is biased.

The main project artifact is **not the app, but the table**. The UI demo with three columns (BM25 / Dense / Fused+Rerank) is just a way to feel with your eyes where the modes diverge. The truth is in `evals/results.json`.

---

## Stage map

| # | File | What's covered | Difficulty |
|---|------|----------------|------------|
| 1 | `01-mental-model.md` | Sparse + dense + fusion + rerank as four independent layers; recall vs precision; latency budget | Low |
| 2 | `02-ingest.md` | HN Algolia API, fetch with rate limit, Postgres schema, `embedMany` via AI Gateway | Medium |
| 3 | `03-retrieval.md` | BM25 via `tsvector` + `ts_rank_cd`; dense via pgvector `<=>` operator; when each wins | Medium |
| 4 | `04-fusion.md` | RRF, k=60, why ranks not scores; parallel execution via `Promise.all` | Medium |
| 5 | `05-reranking.md` | Cross-encoder vs bi-encoder; `ms-marco-MiniLM-L-6-v2` via `@huggingface/transformers`; why top-20 and not top-50 | High |
| 6 | `06-evals.md` | **The main stage.** Graded relevance (0-3), blind grading, union candidate pool, nDCG@10 / Recall@5 / MRR, LLM-judge as fallback | High |
| 7 | `07-synthesis.md` | Optional synthesis layer over top-10 via `generateText + Output.object` | Low |

---

## How to read

**Linearly.** Each stage builds on the previous one. Stages 1–5 are one evening each. Stage 6 (evals) is really 5+ hours of manual grading if you do it honestly. Plan a full workday.

**With `pnpm dev` running.** The UI shows four modes side by side. Type the same query — see where the top results coincide between columns and where they diverge. The divergence is exactly the intuition that the eval formalizes.

**Orientation by query type:**
- `"postgres vacuum"`, `"rust borrow checker"`, `"react server components"` → BM25 often on par or better: precise technical terms with fixed vocabulary.
- `"why senior engineers leave big companies"`, `"burnout in tech"`, `"impostor syndrome"` → dense and especially rerank noticeably better: concepts without fixed keywords.
- `"what's wrong with microservices"` → fused-rerank wins by a wide margin: the topic gets discussed under a dozen phrasings.

---

## Quick orientation in the code

```
retrieve/dense.ts          ← embed() → pgvector <=> cosine distance → top-K
retrieve/sparse.ts         ← plainto_tsquery + ts_rank_cd → GIN index → top-K
retrieve/fuse.ts           ← rrfFuse(lists, topK): 1/(60+rank), 20 lines
retrieve/rerank.ts         ← Xenova/ms-marco-MiniLM-L-6-v2 via transformers.js ONNX
retrieve/modes.ts          ← runRetrieval(mode, query, k) — dispatcher with Promise.all
                              union-pool size 50 for fused, top-20 candidates into rerank

ingest/fetch-comments.ts   ← HN Algolia, rate limit 10 rps, retry with exponential backoff
ingest/load-postgres.ts    ← JSON → comments in batches of 500, ON CONFLICT DO NOTHING
ingest/embed.ts            ← embedMany() in batches of 100 via AI Gateway

db/schema.sql              ← comments + tsvector trigger + embeddings + HNSW index
                              (m=16, ef_construction=64)

evals/score.ts             ← dcg(), ndcg(), recallAtK(), mrr() — pure functions
evals/build-candidate-pool.ts ← union of top-30 across all modes = pool for grading
evals/grading-cli.ts       ← blind CLI grader: shows text without revealing the mode
evals/llm-grader.ts        ← baseline via gpt-4o-mini / claude-haiku via gateway('provider/model')
                              + gemini-2.5-flash direct via createGoogleGenerativeAI;
                              generateText + Output.object({ schema })
evals/harness.ts           ← pnpm eval: queries × 4 modes × 3 runs, p50/p95 latency

fixtures/queries.json      ← queries, written BEFORE running retrieval
fixtures/candidate-pool.json ← union top-30 per query, ~30 queries
fixtures/candidate-grades.json ← grading, ~600+ records
evals/results.json         ← append-only history of runs
```

---

## Three key architectural decisions

**Postgres + pgvector instead of a separate vector DB.** pgvector 0.9 on 5000 vectors with HNSW gives top-50 in <50ms. Fresh benchmarks (Supabase, steezr) show that pgvector on a single Postgres instance delivers 5–15K QPS on 1024-dim vectors and beats Qdrant at equal resources with 99% recall up to ~50M vectors. Standing up a separate store before 100M+ is operational debt without payoff. Backups, authz, migrations — all already in Postgres.

**RRF instead of weighted score addition.** `ts_rank_cd` is unbounded above and depends on document length. Cosine is `[-1, 1]`. If you normalize them and combine via `α * dense + (1-α) * sparse`, normalization turns into a hyperparameter — it gets overfitted to your eval set, and a month later, when you switch the embedding model, the numbers stop reflecting reality. RRF uses only ranks (1/(60+rank)) — scale-invariant and model-invariant. Weaviate, Elasticsearch, OpenSearch, Qdrant, MongoDB Atlas — all moved to RRF as the default.

**Rerank top-20, not top-50.** Cross-encoder latency is linear in the number of candidates: ~6ms per query-doc pair via ONNX on a laptop. Top-20 = ~120ms warm, top-50 = ~300ms. The nDCG gain from positions 21–50 is ~1–2 points, doesn't pay off. This number (20) is picked by measurement, not out of thin air.

---

## Connection to previous projects

| Concept | Where seen | How it's used here |
|---------|-----------|---------------------|
| Structured output + Zod | Projects 02, 03 | `generateText({ output: Output.object({ schema }) })` for LLM-grader and optional synthesis |
| Tool-call evals | Project 03 | The same append-only `results.json`, IR metrics instead of tool accuracy. Additionally — `gradingProvenance` + `gradeCounts`, so human gold isn't mixed up with the LLM baseline |
| `embedMany` | New | Bulk loading, 100 texts → 1 API call. Model is passed as a string `'openai/text-embedding-3-small'`, automatically routes via Gateway |
| AI Gateway | New | Single entry point for embeddings + LLM-judge via `gateway('provider/model')` or string identifier. One `AI_GATEWAY_API_KEY` covers OpenAI + Anthropic, $5/mo free tier, zero markup on the paid tier. Gemini is wired in directly via `@ai-sdk/google` |

The key difference: in this project the AI SDK covers only two of seven layers (embed query, optional synthesis). Everything else is SQL, indexes, ranking algebra. This is a useful reminder: AI product ≠ everything in the world through an LLM.

---

## What this project deliberately does NOT do

- **Sweeping the RRF k hyperparameter.** k=60 is the standard, reconfirmed again by practitioners (Elasticsearch, Weaviate, Qdrant, MongoDB — all on k=60). Tuning it on 30 queries = overfitting.
- **External reranker APIs** (Cohere Rerank, Voyage rerank-2, Jina v3). They're faster and more accurate than MiniLM on BEIR, but they cost money and add a network hop. Local ONNX covers 80% of the benefit for $0.
- **Fine-tuning embeddings on the HN corpus.** On 5000 documents there's not enough signal. With 100K+ it would be worth considering.
- **A cascade of multiple rerank stages** (BM25 → fast cross-encoder → late-interaction → LLM). That's enterprise-search territory. Overkill for a learning project.

---

## Additional materials

- [pgvector GitHub](https://github.com/pgvector/pgvector) — version 0.9, HNSW support and iterative scan
- [pgvector HNSW parameters](https://github.com/pgvector/pgvector#hnsw) — m, ef_construction, ef_search and their effect on recall/latency
- [Postgres Full Text Search](https://www.postgresql.org/docs/current/textsearch.html) — tsvector, tsquery, GIN, ts_rank_cd
- [RRF paper (Cormack 2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) — original, justification for k=60
- [Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) — production-grade implementation
- [HN Algolia API](https://hn.algolia.com/api) — no key needed, rate limit is lenient
- [Vercel AI SDK embedMany](https://ai-sdk.dev/docs/reference/ai-sdk-core/embed-many) — bulk embedding API
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) — $5/mo free, single entry point for embeddings + LLM
- ["Don't Use LLMs to Make Relevance Judgments" (2025)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11984504/) — why LLM-judge for retrieval is a fallback, not a replacement for a human
