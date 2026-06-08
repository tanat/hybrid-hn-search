# Hybrid HN Search

Hybrid retrieval over a frozen Hacker News comment archive (4985 comments,
last 12 months). Four modes — BM25, dense, RRF-fused, fused+reranker —
running side-by-side. The artifact of value is the eval table, not the UI.

> **Status:** repo is deploy-ready. The numbers in the table below are filled
> in by `pnpm eval` once grades land (see [Methodology](#methodology)).
> Every eval row records `gradingProvenance` and a `gradeCounts` breakdown —
> `human` (gold) or `llm:<provider>` (baseline, one of `gemini` / `claude` /
> `openai`). Don't read an `llm:*` row as a final number.

## Results

| Mode             | nDCG@10 | Recall@5 | MRR  | p50 latency |
| ---------------- | ------- | -------- | ---- | ----------- |
| BM25 only        | _tbd_   | _tbd_    | _tbd_| _tbd_       |
| Dense only       | _tbd_   | _tbd_    | _tbd_| _tbd_       |
| RRF fused        | _tbd_   | _tbd_    | _tbd_| _tbd_       |
| Fused + rerank   | _tbd_   | _tbd_    | _tbd_| _tbd_       |

After grading, `pnpm eval` appends a row to
[evals/results.json](./evals/results.json) and the table above gets
the actual numbers. The dashboard at `/eval` renders the latest run
with best-per-metric highlighted green and worst red.

The expected shape (target on this corpus): `bm25` < `dense` < `fused` <
`fused-rerank` on quality, the same ordering on latency. If the rerank
mode doesn't beat BM25 by ≥5 nDCG points, something is wrong with the
fusion or grading.

## Try it

```bash
pnpm install
pnpm db:start        # local Supabase via Docker — API :54321, Postgres :54322, Studio :54323
pnpm db:reset        # apply supabase/migrations: schema + search RPCs + RLS

cp .env.local.example .env.local   # add AI_GATEWAY_API_KEY
pnpm db:status       # copy API URL + anon key into SUPABASE_URL / SUPABASE_ANON_KEY

pnpm ingest:fetch    # ~10 min, HN Algolia API (no key)
pnpm ingest:load     # ~30 sec, JSON → comments table
pnpm ingest:embed    # ~5 min, ~$0.01, needs AI_GATEWAY_API_KEY
pnpm dev             # http://localhost:3000
```

Embeddings and LLM grader providers route through the Vercel AI Gateway, so a
single `AI_GATEWAY_API_KEY` covers OpenAI (`openai/...`) and Anthropic
(`anthropic/...`) without separate provider keys. The app reads `SUPABASE_URL`
+ `SUPABASE_ANON_KEY` (search runs on the anon key via RPC + RLS); bulk ingest
and the eval harness use the direct `DATABASE_URL`. Gemini grading is direct via
the Google SDK and needs `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
only if you pick `--provider=gemini`.

The 3-way compare panel runs `bm25`, `dense`, and `fused-rerank` in
parallel; the radio toggle on the page can also drive single-mode
`fused`. Click *eval results →* in the header for the dashboard.

## Methodology

Ground-truth grades are hand-written by default; an LLM-judge baseline
exists as a faster path to fill the table before the human pass lands.
Either way, every grade carries a `grader` field (`human` |
`llm:gemini` | `llm:claude` | `llm:openai`) and each eval row records
`gradingProvenance` + `gradeCounts` so an LLM-baseline run is never
mistaken for human gold. Full methodology lives in
[evals/README.md](./evals/README.md):

1. Write 30 queries **before** running any retrieval, in
   [fixtures/queries.json](./fixtures/queries.json). Mix of keyword,
   question, abstract, specific.
2. `pnpm tsx evals/build-candidate-pool.ts` unions top-30 from all 4
   modes per query, ~30–50 unique candidates per query.
3. Either:
   - **Hand-grade** (gold): `pnpm tsx evals/grading-cli.ts` walks the
     pool one (query, comment) at a time. The CLI **never reveals which
     mode returned a candidate**, so blind grading is enforced. Stamps
     each grade with `grader: "human"`.
   - **LLM-judge baseline** (~30 min, ~$0.50):
     `pnpm grade:auto --provider=openai|gemini|claude`. Resumable;
     stamps each grade with `grader: "llm:<provider>"`. Useful as a
     sanity-check baseline or while the human pass is still in flight —
     never as the final number.
4. `pnpm eval` reads grades, runs each mode 3× per query, computes
   nDCG@10 / Recall@5 / MRR / p50 / p95, appends to
   [evals/results.json](./evals/results.json) along with
   `gradingProvenance` (e.g. `"human"` or `"mixed(human+llm:openai)"`)
   and a `gradeCounts` breakdown.

The rationale for blind grading + union pool: any "tune-and-grade" loop
overfits to whatever model was active when the grader was reading. A union
candidate pool also makes sure no mode is silently penalized for finding a
relevant comment that the grader never got to see.

## Architecture

Supabase Postgres + pgvector for both indexes — vector and full-text search run
as SQL RPCs (`match_comments` / `search_comments`) that the app calls with the
anon key, gated by RLS. RRF fusion over ranks (no score normalization) and the
cross-encoder reranker over fusion top-20 stay in JS. Full reasoning lives in
[ARCHITECTURE.md](./ARCHITECTURE.md) and the three forks are written up in
[DECISIONS.md](./DECISIONS.md):

- pgvector + Postgres FTS on Supabase, not a separate vector DB
- RRF fusion, not weighted score combine
- Reranker top-20, not top-50 and not skipped

## Repo map

```
app/                 Next.js 15 routes (search, /eval, /eval/[queryHash], /api/search)
supabase/            config.toml + migrations/ (schema, search RPCs, RLS)
db/                  supabase.ts (anon retrieval client), client.ts (postgres.js), sqlite query log
ingest/              fetch-comments.ts, load-postgres.ts, embed.ts
retrieve/            dense.ts, sparse.ts, fuse.ts, rerank.ts, modes.ts dispatcher
render/              CommentCard, ResultsColumn, EvalTable, DiffView
evals/               score.ts, grades-store.ts, grading-cli.ts, build-candidate-pool.ts,
                     harness.ts, results.json (append-only), README.md (methodology)
fixtures/            comments.json (committed), queries.json, candidate-grades.json
scripts/             test-{dense,sparse,mode}.ts
```

## Deploy

Dev and prod are the same stack, so deploy is a Supabase push, not a
dump/restore:

```bash
pnpm supabase link --project-ref <your-project-ref>
pnpm supabase db push          # applies supabase/migrations to the hosted project
```

Then load the corpus against the hosted `DATABASE_URL` (`pnpm ingest:load` +
`pnpm ingest:embed`, or apply the committed `deploy/data.sql` dump), and deploy
the Next.js app to Vercel with `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`DATABASE_URL`, and `AI_GATEWAY_API_KEY` set.

The reranker bundle (`@huggingface/transformers` + `onnxruntime-node`
prebuilds + the ~90 MB ONNX weights) usually exceeds the 50 MB Vercel
function size limit, so the `runRetrieval` dispatcher treats `fused-rerank`
as `fused` when `process.env.VERCEL` is set (override with `RERANK_IN_PROD=1`).
The local dev server still demonstrates the full pipeline, and the eval table
proves the rerank lift.

The artifact of value is `evals/results.json`; the live demo is supporting
material.

## Project files

- [ARCHITECTURE.md](./ARCHITECTURE.md) — stack, retrieval pipeline, RRF math
- [DECISIONS.md](./DECISIONS.md) — three forks, with cost analysis
- [evals/README.md](./evals/README.md) — methodology in detail
