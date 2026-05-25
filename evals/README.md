# Eval methodology

This is the long-form companion to the eval table in
[../README.md](../README.md). It exists because the most common failure
mode of "RAG eval" is silently leaking the test set into the system; the
recipe below is structured to make that hard.

## The three rules

1. **Queries before retrieval.** Write the 30 queries in
   `fixtures/queries.json` before running any of the retrieval modes
   against them. The risk you're avoiding is writing queries that
   exactly match phrases the corpus happens to contain — that
   over-rewards lexical retrieval.

2. **Union candidate pool.** For each query, take the union of top-30
   from all four modes (`bm25`, `dense`, `fused`, `fused-rerank`). Grade
   the union, not per-mode top-K. Otherwise a relevant comment that
   only one mode found gets graded only when *that* mode is being
   evaluated, and the others appear to "miss" something they were never
   shown.

3. **Blind grading.** `evals/grading-cli.ts` shows query + comment text +
   story title — and nothing else. No mode label, no rank, no score.
   Grades save to `fixtures/candidate-grades.json` after every input.

## Grade scale

| Grade | Meaning                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| 3     | Highly relevant. Would show this if I had only one slot.                        |
| 2     | Partially relevant. Clear answer to a closely-related question.                 |
| 1     | Tangential. Mentions the topic but doesn't answer.                              |
| 0     | Irrelevant.                                                                     |

When in doubt between two adjacent grades, lean lower. The metrics are
sensitive to grade inflation in the 2–3 range (nDCG weights `2^grade - 1`,
so 2 vs 3 is a 4× swing in DCG contribution).

## Query distribution

Aim for variety along *both* form and concreteness. The recipe in
[BUILD_PLAN.md](../BUILD_PLAN.md) calls for:

- 8 keyword-style ("postgres performance tuning")
- 8 question-style ("why do startups fail at scale")
- 8 abstract / conceptual ("technical debt as career risk")
- 6 specific / factual ("what is V8 hidden classes")

The keyword group should expose where BM25 keeps up. The abstract group
should expose where dense pulls ahead. The mix is what makes the
comparison meaningful — a corpus-tuned set of pure keyword queries would
let BM25 win and prove nothing about the rest of the pipeline.

## Metrics

Definitions in [`score.ts`](./score.ts):

- **nDCG@10:** quality-weighted ranking metric, `2^grade - 1` numerator,
  log2 rank discount. Normalized so 1.0 = ideal ranking on this query.
- **Recall@5:** of the items judged ≥ 2 for this query, what fraction
  appears in the top-5 retrieved? (No items ≥ 2 graded ⇒ 0, not NaN.)
- **MRR:** reciprocal rank of the first item judged ≥ 2 in the
  retrieval; 0 if no such item is in the result.

Latency is measured per query as the median of 3 runs (after a reranker
warm-up call), aggregated as p50 / p95 across queries. The first-ever
reranker invocation in a process loads ~90 MB of ONNX weights; the
warm-up call hides that one-time cost from the measurement.

## Re-grade for stability (optional, recommended)

Pick 5 queries at random, re-grade them a week after the first pass.
If grades change by more than 20%, the ground truth is noisy and the
metric deltas between modes need a wider margin to be trusted.
Document the re-grade results in DECISIONS.md if you find drift.

## Files

- `score.ts` — metric implementations + unit tests in `__tests__/`
- `grades-store.ts` — persistence + pause/resume helpers (unit-tested)
- `grading-cli.ts` — interactive readline CLI for the grader
- `build-candidate-pool.ts` — union of top-30 per query, all 4 modes
- `harness.ts` — runs all queries × modes, appends to `results.json`
- `queryHash.ts` — short stable id for `/eval/[queryHash]` URLs
- `results.json` — append-only history (one row per `pnpm eval` invocation)
