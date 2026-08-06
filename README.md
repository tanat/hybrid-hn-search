# Hybrid HN Search

**[Live demo →](https://hybrid-hn-search.vercel.app)**

Hybrid retrieval over a frozen Hacker News comment archive (4,985 comments,
last 12 months). Five modes — BM25, dense, RRF-fused, fused+reranker,
dense+reranker — running side-by-side. The artifact of value is the eval table,
not the UI.

> **Grading:** the numbers below are an **`llm:gemini` baseline** (1,670 graded
> query–candidate pairs — the full candidate pool, nothing left unjudged), not
> human gold. Read them as a relative ranking of the modes, not absolute truth.
> Every eval row records `gradingProvenance` and a `gradeCounts` breakdown.

## Results

| Mode             | nDCG@10   | Recall@5  | MRR       | p50 latency |
| ---------------- | --------- | --------- | --------- | ----------- |
| BM25 only        | 0.144     | 0.081     | 0.351     | 9 ms        |
| Dense only       | **0.483** | 0.290     | 0.681     | 567 ms      |
| RRF fused        | 0.365     | 0.295     | 0.572     | 534 ms      |
| Fused + rerank   | 0.422     | **0.351** | 0.671     | 933 ms      |
| Dense + rerank   | 0.458     | 0.326     | **0.706** | 768 ms      |

<sub>30 queries · 4,985-comment corpus · `text-embedding-3-small` · reranker
`ms-marco-MiniLM-L-6-v2` · `llm:gemini` grades. Bold = best per column.
Recall@5 and MRR are over the 24 queries that have at least one relevant
comment; recall@5 cannot exceed 5/|relevant|, which averages **0.697** here, so
0.35 is roughly half of what was reachable.</sub>

## Which differences are real

A gap between two means over thirty queries is not a finding on its own, so
every pair of modes is compared with a **paired bootstrap** — resample the
queries, recompute the mean difference, report the interval. Paired because both
modes see the same queries, and queries vary far more than modes do.

| Comparison | nDCG@10 | recall@5 | MRR |
| --- | --- | --- | --- |
| dense − fused | **+0.118** [0.084, 0.153] | −0.005 *(ns, p=0.91)* | **+0.109** [0.004, 0.221] |
| dense − fused+rerank | **+0.061** [0.016, 0.107] | **−0.061** [−0.124, −0.007] | +0.010 *(ns, p=0.91)* |
| dense − dense+rerank | +0.025 *(ns, p=0.27)* | −0.036 *(ns, p=0.13)* | −0.025 *(ns, p=0.73)* |
| fused+rerank − dense+rerank | **−0.036** [−0.058, −0.015] | **+0.025** [0.003, 0.053] | **−0.035** [−0.084, −0.004] |

*(ns = the interval spans zero; the two modes are not distinguishable at n=30.)*

## What the numbers actually say

**The answer depends on which metric you are buying, and that is the finding.**

**For ranking quality, plain dense wins and the textbook stack is a waste.** BM25
is weak on this corpus (0.144) — lexical overlap barely helps on paraphrased,
conversational text — and fusing it in **hurts nDCG by 0.118**, well outside the
interval. That much of "hybrid + rerank always wins" is a myth here. But the
correction goes further than this README used to admit: adding a cross-encoder on
top of dense does **not** measurably improve ranking either (+0.025 nDCG,
p=0.27; −0.025 MRR, p=0.73). You pay 200 ms for nothing you can detect.

**For getting relevant comments into the top 5, the lexical leg earns its place
back.** Fused+rerank is the only configuration that significantly beats dense on
recall@5 (+0.061), and it beats dense+rerank too (+0.025) — the configuration
containing the very BM25 signal that hurts nDCG. Fusion widens the candidate set;
the reranker then sorts out the mess. So "BM25 fusion is a net negative" is true
for ranking and false for recall, and stating it without the qualifier was
overreach.

**Earlier versions of this README recommended dense + rerank without having run
it.** The eval measured four modes and inferred the fifth. `dense-rerank` is now
a real mode, and the inference does not survive: it is indistinguishable from
plain dense on both ranking metrics and worse than fused+rerank on recall.

If you want one recommendation from this corpus: **dense alone if you rank,
fused+rerank if you retrieve** — and note that both statements come from an
LLM-graded baseline over thirty queries. A human-graded pass could move the
absolutes; the paired intervals say which orderings would have to move with them.

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
single `AI_GATEWAY_API_KEY` covers OpenAI (`openai/...`), Anthropic
(`anthropic/...`), and Google (`google/...`) without separate provider keys. The
app reads `SUPABASE_URL` + `SUPABASE_ANON_KEY` (search runs on the anon key via
RPC + RLS); bulk ingest and the eval harness use the direct `DATABASE_URL`. The
Gemini grader (`--provider=gemini`) also routes through the gateway on the same
`AI_GATEWAY_API_KEY` — no per-provider key needed.

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
proves the rerank lift. The SQLite query log is likewise local-dev only —
`logSearch` no-ops on Vercel (read-only filesystem), so search still returns
normally without a persisted row.

The artifact of value is `evals/results.json`; the live demo is supporting
material.

## Project files

- [ARCHITECTURE.md](./ARCHITECTURE.md) — stack, retrieval pipeline, RRF math
- [DECISIONS.md](./DECISIONS.md) — three forks, with cost analysis
- [evals/README.md](./evals/README.md) — methodology in detail
