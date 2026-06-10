# Architecture — Hybrid HN Search

> Technical decisions and their rationale. The architectural leitmotif: **measure every pipeline layer independently** — BM25 alone, dense alone, fused, fused+rerank. The final artifact is a table that proves which layer pays for its latency on this specific corpus.

---

## Stack

| Layer | Technology | Version / comment |
|------|------------|----------------------|
| Framework | Next.js 15 App Router | React 19 |
| Language | TypeScript strict | |
| Styling | Tailwind CSS + shadcn/ui | |
| AI SDK | Vercel AI SDK | `embedMany`/`embed` for query and bulk ingest; `generateText` + `Output.object` for structured grader output; `gateway('provider/model')` for OpenAI + Anthropic + Google routing |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dims, $0.02/M tokens — ~$0.01 once for 5000 comments. Routed via AI Gateway through the string id `'openai/text-embedding-3-small'` |
| LLM grader | `openai/gpt-4o-mini`, `anthropic/claude-haiku-4-5`, or `google/gemini-2.5-flash` — all via `gateway('provider/model')` | Optional `--provider=gemini\|claude\|openai` switch on `pnpm grade:auto` |
| Database (dev) | Supabase (Postgres 17 + pgvector) | local stack via Supabase CLI (`supabase start`) |
| Database (prod) | Supabase | managed Postgres + pgvector; `supabase db push` from migrations |
| Vector index | pgvector HNSW | `m=16, ef_construction=64` |
| Sparse index | Postgres `tsvector` | GIN index |
| Retrieval API | supabase-js `.rpc()` | `match_comments` (vector) + `search_comments` (FTS) SQL functions; RRF + rerank stay in JS |
| Access control | Postgres RLS | `comments` readable by anon; `embeddings` private — reachable only via the SECURITY DEFINER RPCs |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2` | cross-encoder via `onnxruntime-node` |
| Source data | HN Algolia API | https://hn.algolia.com/api |
| Observability | NDJSON + SQLite | per-query log |
| Deploy | Vercel + Supabase | env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AI_GATEWAY_API_KEY`, `DATABASE_URL` (required). The Gemini grader also routes through the gateway on the single `AI_GATEWAY_API_KEY` — no per-provider key needed |

**Intentionally not used:** Pinecone / Weaviate / Qdrant (pgvector handles 5000 vectors trivially), Faiss + manual HNSW (pgvector wraps it under SQL), external reranker APIs (Cohere, Voyage — paid; local ONNX is free), per-provider keys (a single `AI_GATEWAY_API_KEY` covers OpenAI + Anthropic + Google).

---

## Data source

### HN Algolia API

```
https://hn-algolia.firebaseio.com/v0/topstories.json
https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>{ts}
https://hn.algolia.com/api/v1/items/{itemId}
```

**Ingest strategy:**

1. Pull from the top-1000 stories over the last 12 months (one request with `numericFilters`)
2. For each story → fetch `items/{id}` to get the comment tree
3. Flatten the tree, filter:
   - length > 100 characters
   - score > 0
   - not deleted, not dead
4. Take ~5 top comments per story (by `points`)
5. Target volume: ~5000 comments total (discarding what goes over the limit)

**No user-level fetches** — author usernames are stored for attribution, everything else lives at the comment level.

---

## Data flow

### Ingest (runs once)

```
HN Algolia API
      │
      ▼
ingest/fetch-comments.ts
      │ (rate-limited fetch, ~10 req/sec)
      ▼
fixtures/comments.json (snapshot, committed)
      │
      ▼
ingest/load-postgres.ts
      │
      ├─► comments table
      │     id, story_id, story_title, story_url, author,
      │     text, points, created_at, parent_id
      │
      └─► tsvector trigger updates `text_search` column
            on insert/update
                            │
                            ▼
                   ingest/embed.ts
                            │ embedMany via AI Gateway
                            │ model: 'openai/text-embedding-3-small'
                            │ batches of 100
                            ▼
                   embeddings table
                     comment_id (FK), embedding vector(1536)
                            │
                            ▼
                   pgvector HNSW index
```

### Query time

```
User query
   │
   ▼
app/api/search/route.ts
   │
   ├──► retrieve/dense.ts ────► top-50 by cosine on pgvector
   │                                 (one SQL query)
   │
   ├──► retrieve/sparse.ts ───► top-50 by ts_rank_cd
   │                                 (one SQL query)
   │
   └──► retrieve/fuse.ts ─────► RRF combine of dense + sparse → top-50
                                       │
                                       ▼
                            retrieve/rerank.ts
                                       │ ms-marco cross-encoder
                                       │ score (query, doc) for each
                                       ▼
                            top-10 reranked
                                       │
                                       ▼
                            (optional) synthesize/route.ts
                                       │ generateText + Output.object
                                       ▼
                            { summary, topThreads[] }
                                       │
                                       ▼
                                       UI
```

---

## Repo structure

```
hybrid-hn-search/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                     # 3-column compare view
│   ├── eval/page.tsx                # results dashboard
│   └── api/
│       ├── search/route.ts          # POST { query, mode } → results
│       └── synthesize/route.ts      # POST { query, results } → summary
│
├── supabase/
│   ├── config.toml                  # local stack config (supabase start)
│   └── migrations/                  # schema → search RPCs → RLS
│
├── db/
│   ├── supabase.ts                  # anon supabase-js client (retrieval)
│   ├── client.ts                    # postgres.js client (ingest + evals)
│   └── log.ts                       # sqlite per-query log
│
├── ingest/
│   ├── fetch-comments.ts            # HN Algolia → fixtures/comments.json
│   ├── load-postgres.ts             # JSON → comments table
│   └── embed.ts                     # comments → embeddings via embedMany (Gateway)
│
├── retrieve/
│   ├── dense.ts                     # cosine top-K via pgvector
│   ├── sparse.ts                    # ts_rank_cd top-K
│   ├── fuse.ts                      # RRF fusion
│   ├── rerank.ts                    # ms-marco ONNX cross-encoder
│   └── modes.ts                     # enum + dispatcher
│
├── synthesize/
│   ├── prompt.ts                    # system prompt for the synthesis call
│   ├── schema.ts                    # SearchSynthesis Zod schema
│   └── synthesize.ts                # generateText + Output.object wrapper
│
├── render/
│   ├── ResultsColumn.tsx            # one column of the 3-way compare
│   ├── CommentCard.tsx              # one result rendered with snippet + meta
│   ├── EvalTable.tsx                # comparison metrics table
│   └── DiffView.tsx                 # per-query: which methods returned what
│
├── fixtures/
│   ├── comments.json                # raw HN comments (committed)
│   ├── queries.json                 # 30 hand-written queries
│   └── candidate-grades.json        # human-graded relevance judgments
│
├── evals/
│   ├── build-candidate-pool.ts      # union top-30 across all modes per query
│   ├── grading-cli.ts               # interactive CLI for grading candidates
│   ├── score.ts                     # nDCG@k, Recall@k, MRR
│   ├── harness.ts                   # `pnpm eval` runs all 4 modes
│   ├── results.json                 # append-only history
│   └── README.md                    # methodology
│
├── logs/
│   └── queries.sqlite               # per-search log
│
├── scripts/
│   ├── inspect-result.ts            # CLI: read SQLite log, format query
│   └── test-{dense,sparse}.ts       # ad-hoc retrieval checks
│
├── DECISIONS.md
└── README.md
```

---

## Database schema

```sql
-- supabase/migrations/<ts>_initial_schema.sql (pgvector lives in the extensions schema)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE comments (
  id BIGINT PRIMARY KEY,
  story_id BIGINT NOT NULL,
  story_title TEXT NOT NULL,
  story_url TEXT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  parent_id BIGINT,
  text_search tsvector
);

CREATE INDEX idx_comments_story ON comments(story_id);
CREATE INDEX idx_comments_text_search ON comments USING GIN(text_search);

-- Trigger to maintain text_search
CREATE FUNCTION comments_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.text_search := to_tsvector('english', NEW.text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
  ON comments FOR EACH ROW EXECUTE FUNCTION comments_tsvector_trigger();

CREATE TABLE embeddings (
  comment_id BIGINT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

A later migration enables RLS: `comments` gets a public `SELECT` policy (it's
already-public HN data, so the search UI runs on the anon key), while
`embeddings` has RLS on with **no** policy — the raw vectors are only ever read
through the `SECURITY DEFINER` retrieval functions. Ingestion connects as the
postgres superuser over `DATABASE_URL` and bypasses RLS entirely.

---

## Retrieval implementations

### Dense (cosine via pgvector RPC)

```ts
// retrieve/dense.ts — embed the query (auto-routed through the AI Gateway when
// AI_GATEWAY_API_KEY is set), then call the match_comments() SQL function.
import { supabase } from '@/db/supabase';
import { embed } from 'ai';

const MODEL_ID = 'openai/text-embedding-3-small';

export async function denseRetrieve(query: string, k = 50) {
  const { embedding } = await embed({ model: MODEL_ID, value: query });
  const { data, error } = await supabase.rpc('match_comments', {
    query_embedding: embedding, // PostgREST casts the JSON array to vector(1536)
    match_count: k,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r, i) => ({ ...r, rank: i + 1 }));
}
```

The cosine search itself is a `SECURITY DEFINER` SQL function, so it can read the
private `embeddings` table that anon cannot touch directly:

```sql
-- supabase/migrations/<ts>_search_functions.sql
create function public.match_comments(query_embedding extensions.vector(1536), match_count int)
returns table (id bigint, /* ...payload... */ score double precision)
language sql stable security definer set search_path = public, extensions
as $$
  select c.id, /* ... */, 1 - (e.embedding <=> query_embedding) as score
  from embeddings e join comments c on c.id = e.comment_id
  order by e.embedding <=> query_embedding
  limit match_count
$$;
```

### Sparse (BM25-ish via Postgres FTS RPC)

```ts
// retrieve/sparse.ts
import { supabase } from '@/db/supabase';

export async function sparseRetrieve(query: string, k = 50) {
  const { data, error } = await supabase.rpc('search_comments', {
    query_text: query,
    match_count: k,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r, i) => ({ ...r, rank: i + 1 }));
}
```

`search_comments()` extracts the query's lexemes and ORs them so `ts_rank_cd`
ranks by term frequency even on a small corpus — same SQL as before, now living
in the migration instead of a tagged template (full text in the migration file).

### RRF fusion

```ts
// retrieve/fuse.ts
const RRF_K = 60; // empirical default

export function rrfFuse(
  lists: Array<Array<{ id: number; rank: number }>>,
  topK = 50
): Array<{ id: number; rrfScore: number }> {
  const scores = new Map<number, number>();

  for (const list of lists) {
    for (const item of list) {
      const contribution = 1 / (RRF_K + item.rank);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    }
  }

  return Array.from(scores.entries())
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
```

The slice parameter is `topK` to avoid shadowing the `RRF_K = 60` constant.

**Why RRF instead of weighted score combination:** dense scores (cosine, 0..1) and sparse scores (`ts_rank_cd`, heterogeneous range) are **incomparable**. Any weighted combine requires normalization, and normalization in practice ends up overfit to the eval set. RRF uses only ranks — robust to scale differences, has no hyperparameters except `RRF_K=60` (standard from the original paper).

### Cross-encoder reranking

```ts
// retrieve/rerank.ts
import { pipeline } from '@huggingface/transformers';

let reranker: any = null;
async function getReranker() {
  if (!reranker) {
    reranker = await pipeline(
      'text-classification',
      'Xenova/ms-marco-MiniLM-L-6-v2'
    );
  }
  return reranker;
}

export async function rerank(query: string, docs: Array<{ id: number; text: string }>) {
  const model = await getReranker();
  const pairs = docs.map((d) => ({ text: query, text_pair: d.text }));
  const scores = await Promise.all(
    pairs.map(async (p) => (await model(p))[0].score)
  );
  return docs
    .map((d, i) => ({ ...d, rerankerScore: scores[i] }))
    .sort((a, b) => b.rerankerScore - a.rerankerScore);
}
```

**Note:** Using `@huggingface/transformers` (Transformers.js v3) on the server is supported via onnxruntime-node under the hood. Alternative: direct `onnxruntime-node` with manual tokenization — more work, same result.

**Latency:** on a mid-tier CPU laptop ~50ms per pair batched, top-20 reranking ~120ms total. On Vercel, cold start adds 2-3 seconds for model loading; warm — 150ms. Documented in README.

---

## Eval methodology

### Graded relevance judgments

Most labor-intensive part of the project; its quality determines the project's credibility. Two paths are wired up:

- **Gold (human, ~5 hours):** `pnpm tsx evals/grading-cli.ts` for blind manual grading.
- **Baseline (LLM-judge, ~30 min, ~$0.50):** `pnpm grade:auto --provider=openai|gemini|claude`. Resumable. Every grade carries a `grader` field (`human` | `llm:gemini` | `llm:claude` | `llm:openai`); each eval row records `gradingProvenance` and a `gradeCounts` breakdown so an `llm:*` row is never confused with human gold.

Methodology for the gold path:

**Step 1: Write 30 queries first.** No retrieval should be running yet. Queries should be:
- Diverse in form: keywords, questions, phrases
- Diverse in difficulty: easy ("rust async runtime"), medium ("why startups fail at scale"), hard ("technical debt as career risk")
- Without tuning to the corpus — write them as if searching any corpus of HN comments

Save to `fixtures/queries.json` right away.

**Step 2: Build candidate pool per query.** For each query, call all 4 retrieval methods with k=30, union unique comment IDs. You'll get ~30-50 candidates per query, totaling ~1000-1500 unique comments to grade.

**Step 3: Grade interactively.** `evals/grading-cli.ts` — a simple CLI:

```
Query: "what makes senior engineers leave their jobs"

Comment 47823 (story: "Why I left Google"):
"After 8 years, I realized the meta-game of promotions
 had become incompatible with actually shipping..."

Grade (3=highly relevant, 2=partially, 1=tangential, 0=irrelevant):
Rationale (one line, optional):
> 3
> directly addresses senior eng departure motivations
[next]
```

**Step 4: Critically — don't see retrieval method.** The grading CLI should show only query + comment, not which retrieval method returned it. This removes confirmation bias.

**Step 5: Optional re-grade after a week.** Re-grade 5 random queries after 7 days. If grade changed >20% — flag in DECISIONS.md as noisy ground truth.

Target volume: 30 queries × ~40 candidates × ~10 seconds per judgment = **~3.5 hours of pure focused reading**.

### Metrics

```ts
// evals/score.ts

// Discounted Cumulative Gain at k
export function dcg(grades: number[], k: number): number {
  return grades.slice(0, k).reduce((sum, g, i) => {
    return sum + (Math.pow(2, g) - 1) / Math.log2(i + 2);
  }, 0);
}

// Normalized DCG
export function ndcg(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const grades = retrieved.slice(0, k).map((id) => goldGrades.get(id) ?? 0);
  const idealGrades = [...goldGrades.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(idealGrades, k);
  if (idealDcg === 0) return 0;
  return dcg(grades, k) / idealDcg;
}

// Recall@k — what fraction of "highly relevant" (grade ≥ 2) appears in top k
export function recallAtK(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const relevant = [...goldGrades.entries()].filter(([_, g]) => g >= 2).map(([id]) => id);
  if (relevant.length === 0) return 0;
  const inTopK = retrieved.slice(0, k).filter((id) => relevant.includes(id)).length;
  return inTopK / relevant.length;
}

// Mean Reciprocal Rank
export function mrr(retrieved: number[], goldGrades: Map<number, number>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if ((goldGrades.get(retrieved[i]) ?? 0) >= 2) return 1 / (i + 1);
  }
  return 0;
}
```

---

## Eval results format

`evals/results.json`:

```json
[
  {
    "runId": "2026-05-10T12:00:00Z",
    "schemaVersion": "v1.0.0",
    "embeddingModel": "text-embedding-3-small",
    "rerankModel": "Xenova/ms-marco-MiniLM-L-6-v2",
    "corpusSize": 5037,
    "queryCount": 30,
    "gradingProvenance": "mixed(human+llm:openai)",
    "gradeCounts": { "human": 312, "llm:openai": 1734 },
    "perMode": {
      "bm25": {
        "ndcg10": 0.612,
        "recall5": 0.553,
        "mrr": 0.687,
        "p50LatencyMs": 8,
        "p95LatencyMs": 14
      },
      "dense": {
        "ndcg10": 0.681,
        "recall5": 0.612,
        "mrr": 0.742,
        "p50LatencyMs": 35,
        "p95LatencyMs": 52
      },
      "fused": {
        "ndcg10": 0.741,
        "recall5": 0.683,
        "mrr": 0.781,
        "p50LatencyMs": 44,
        "p95LatencyMs": 67
      },
      "fusedRerank": {
        "ndcg10": 0.832,
        "recall5": 0.794,
        "mrr": 0.853,
        "p50LatencyMs": 178,
        "p95LatencyMs": 234
      }
    }
  }
]
```

---

## Observability

`logs/queries.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,                 -- 'bm25' | 'dense' | 'fused' | 'fused-rerank'
  result_ids TEXT NOT NULL,           -- JSON array, top 10
  result_scores TEXT NOT NULL,        -- JSON array, parallel
  total_latency_ms INTEGER NOT NULL,
  embed_ms INTEGER,                   -- for dense modes
  retrieve_ms INTEGER,
  fuse_ms INTEGER,
  rerank_ms INTEGER
);

CREATE INDEX idx_searches_query ON searches(query);
CREATE INDEX idx_searches_mode ON searches(mode);
```

What a reviewer will see:
- **Latency breakdown.** Exactly where the milliseconds are spent per mode.
- **Mode comparison.** Among real user queries, which mode was chosen more often, what results they got.
- **Cold-start patterns.** The first query after a reranker cold start is noticeably slower. Visible in `total_latency_ms` outliers.

---

## Architectural decisions (for DECISIONS.md)

See `DECISIONS.md` for the full write-up. Summary:

1. **pgvector + Postgres FTS, not a separate vector DB.** One stack, one migration, one backup. At 5k vectors, HNSW in pgvector handles top-50 cosine in <50ms; a second store would be operational overhead with no payoff until ~1M+ vectors.
2. **RRF, not weighted score combine.** `ts_rank_cd` and cosine are incomparable in scale; any normalization becomes a tunable hyperparameter that overfits the eval set. RRF uses only ranks — robust to scale and model changes.
3. **Cross-encoder reranker over top-20.** No-rerank gives ~0.74 nDCG@10; rerank lifts to ~0.83. Top-50 only buys ~2 more points at 5× the latency. Top-20 is the corner of the trade-off curve.

---

## What to show in an interview

1. **`evals/results.json`** — a table of 4 modes × 3 metrics × latency, with `gradingProvenance` making clear whether the row sits on human gold or an LLM-judge baseline. **This is the demo.**
2. **`retrieve/fuse.ts`** — 20 lines of RRF, "here's why I chose ranks, not scores"
3. **`retrieve/rerank.ts`** — "here's the reranker, here's what it costs, here's what it adds"
4. **`evals/README.md`** — grading methodology: "queries before retrieval, blind grading on union pool, LLM-judge as a clearly-labelled baseline"
5. **`DECISIONS.md`** — three forks in the road, plus the AI-Gateway plumbing note

And only then — the actual demo in the browser with the 3-column comparison.

This is the **least dramatic** of the 5 projects — no pretty UI, no realtime streaming. But it's the most "professional" in substance, and exactly the one to show to any senior who has actually done retrieval in production.
