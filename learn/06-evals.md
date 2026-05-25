# 06. Evals: graded relevance, nDCG@10, blind grading

## WHY

This is the most important stage in the project. Everything else is a **way** to do search. This stage is **proof** that one way is better than another.

Without evals:
- You "feel" that rerank helps. On your 3 favorite queries. That's confirmation bias.
- You can't say how much nDCG you got for +120ms of reranker. So you can't justify it in production.
- When you switch the embedding model you won't know whether things got better or worse — until user complaints come in.

The goal of evals is to **get numbers you trust**. Trusting them means that on similar corpora and queries those numbers reproduce, don't depend on the grader's mood, and don't depend on the order in which you tested models.

Achieving that trust is work. Not "a couple of hours" but really a full day.

---

## HOW: the general idea of graded relevance evals

Classic IR methodology. Steps:

1. **Fix the query set.** 30 queries of different types (terms, paraphrase, concepts). Write them **before** running retrieval — otherwise you'll fit them to what the system returns well.
2. **Build a candidate pool.** For each query, run **all** 4 modes and take the union top-30 of each. That's ~60–80 unique candidates per query.
3. **Grade the relevance** of each `(query, candidate)` pair on a 0–3 scale.
4. **Run the harness:** 30 queries × 4 modes × 3 runs (for p50/p95 latency).
5. **Compute nDCG@10, Recall@5, MRR** against the grades.
6. **Write to append-only `results.json`** with metadata (model, corpus size, schema version).

### Graded vs binary relevance

Binary grading (`relevant / not relevant`) is simple but loses information. The document "this is the exact answer to your question" and the document "tangentially related" both end up as `1`. That's bad for nDCG.

Graded 0–3 in the HN context:
- **3 — Highly relevant.** Directly and substantially addresses the query.
- **2 — Partially relevant.** Clearly about the topic but not a direct answer.
- **1 — Tangential.** Mentions the topic but doesn't go into it.
- **0 — Irrelevant.**

From `llm-grader.ts`:
```
3 - Highly relevant: directly and substantially addresses the query
2 - Partially relevant: clearly related to the topic but not a direct answer
1 - Tangential: mentions the topic but doesn't meaningfully address it
0 - Irrelevant: unrelated to the query

When in doubt between adjacent grades, lean lower.
```

The last line is critical: without an explicit instruction, graders (human and LLM) drift toward inflated scores. "When in doubt, lean lower" gives a stable distribution.

---

## HOW: union candidate pool

From `evals/build-candidate-pool.ts`:

```ts
const POOL_K = 30;
for (const q of queries) {
  const ids = new Set<number>();
  for (const mode of ALL_MODES) {
    const run = await runRetrieval(mode, q, POOL_K);  // <-- all 4 modes
    for (const r of run.results) ids.add(r.id);
  }
  pool[q] = Array.from(ids).sort((a, b) => a - b);
}
```

**Why union top-30 across all modes:**

If you only grade the top-10 of one mode (e.g., fused-rerank), you only grade what that mode already considers good. The `nDCG@10` estimate for the other modes will be systematically low: documents they found weren't graded — they get grade=0 by default.

The union across all modes guarantees that **any relevant document found by anyone** lands in the pool. That's honest evaluation.

Pool size: 30 candidates × 4 modes = 120 pairs per query worst case. Due to overlap usually 60–80 unique. On 30 queries ≈ 2000 pairs.

**When it breaks:** if you grade only the top-10 of one mode, the baseline (BM25) gets artificially underscored by 5–10 nDCG points. Saw this many times in other people's projects — then they're surprised: "our rerank gives +20 nDCG!". No, your eval is broken.

---

## HOW: blind grading

From `evals/grading-cli.ts` (concept):

```ts
// CLI shows only query + text + story_title
// DOES NOT show: mode, rank, score, anything about who found this document
console.log(`Query: ${query}`);
console.log(`Comment (from "${storyTitle}"):\n${text}`);
const grade = await prompt('Grade 0-3: ');
```

**Why blind:** if the grader knows a document came from `fused-rerank`, they subconsciously score it higher. If they know it's from `bm25` — lower. That's leakage of the experiment into grading.

Blind grading has been the IR-grading standard since the 1980s. The mechanic is simple: the grader sees the query and the candidate, doesn't know the source.

What **else is important** to do in the grading CLI:
- Summarize progress (47/600 graded) — keeps morale.
- Random presentation order — don't show candidates for one query in a row, shuffle them.
- Allow "skip" / "unsure" — otherwise the grader guesses on doubtful ones and corrupts the data.
- Save `reasoning` optionally — for reviewing contested cases.

---

## HOW: LLM-judge as a fallback

Grading 2000 pairs by hand = ~10 hours of work. Really a lot. So we implemented an LLM-judge fallback:

```ts
// evals/llm-grader.ts
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { gateway, generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

const SYSTEM_PROMPT = `You are a relevance judge for a search engine over Hacker News comments.
Grade how relevant the comment is to the query on this scale:
3 - Highly relevant: directly and substantially addresses the query
2 - Partially relevant: clearly related to the topic but not a direct answer
1 - Tangential: mentions the topic but doesn't meaningfully address it
0 - Irrelevant: unrelated to the query

When in doubt between adjacent grades, lean lower.
Grade relevance to the query, not writing quality.`;

const GRADE_SCHEMA = z.object({
  grade: z.number().int().min(0).max(3),
  reasoning: z.string(),
});

function getModel(provider: 'gemini' | 'openai' | 'claude'): LanguageModel {
  if (provider === 'gemini') {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
    return google('gemini-2.5-flash') as unknown as LanguageModel;
  }
  if (provider === 'openai') return gateway('openai/gpt-4o-mini');
  return gateway('anthropic/claude-haiku-4-5-20251001');
}

export async function llmGrade(
  provider: 'gemini' | 'openai' | 'claude',
  query: string,
  commentText: string,
  storyTitle: string,
) {
  const { output } = await generateText({
    model: getModel(provider),
    output: Output.object({ schema: GRADE_SCHEMA }),   // <-- structured JSON via generateText
    system: SYSTEM_PROMPT,
    prompt: `Query: "${query}"\n\nComment (from story: "${storyTitle}"):\n${commentText}`,
  });
  return { grade: output.grade, reasoning: output.reasoning };
}
```

Structured JSON output lives inside `generateText` via `output: Output.object({ schema })`, the result is read as `result.output`. It's validated by a Zod schema, the interface is unified with regular text generation.

Three providers:
- `openai/gpt-4o-mini` via `gateway('openai/...')` — fast, cheap ($0.15/1M input)
- `anthropic/claude-haiku-4-5-20251001` via `gateway('anthropic/...')` — competitive baseline
- `gemini-2.5-flash` via direct `createGoogleGenerativeAI` — for cross-validation (Gemini through the Gateway gives nothing useful for a single-baseline grader, so it stays direct)

OpenAI and Anthropic go through the unified `AI_GATEWAY_API_KEY`; Gemini requires a separate `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) and is only needed if `--provider=gemini` is chosen.

**Why three models:** different models have different biases. If you only use one, your eval becomes "what this model considers relevant". Running the same pairs through 3 models and comparing is a sanity check.

### Known LLM-judge issues (2025–2026)

A consensus formed in the IR community: **LLM-judge ≠ replacement for a human**.

- **Bias from keyword stuffing.** LLM-judges systematically overrate documents with many query tokens, even if the document isn't relevant. The paper "When LLM Judges Inflate Scores" (2025) showed that gpt-4 inflates ratings of such documents by 15–25%.

- **Closed loop.** If your retriever ranks via OpenAI embeddings and the judge is OpenAI gpt-4o, you get a closed loop: the model ranks via its embeddings, the same model evaluates the result of its embeddings. That's an inflation bias.

- **Inflated absolute numbers.** LLM-judges consistently inflate scores by 0.2–0.5 points compared to experts. For **comparing modes** to each other it's fine — the bias is the same across modes. For **absolute evaluation** ("we have 95% recall") — unacceptable.

The 2025 paper ["Don't Use LLMs to Make Relevance Judgments"](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11984504/) sums it up: LLM-judge is OK as an intermediate development step, unacceptable as a final artifact.

### Project strategy

```
1. Do 50–100 pairs by hand yourself.   (~1 hour)
2. Run the same pairs through LLM-judge.
3. Compute agreement (Cohen's kappa).
   - If κ > 0.7 — LLM-judge is acceptable for the remaining pairs.
   - If κ < 0.5 — tune the prompt or grade by hand.
4. LLM-judge the remaining ~1900 pairs.  (~30 minutes × $0.5)
5. Final sanity: check 30 random LLM-graded pairs by hand.
```

In our project `evals/auto-grade.ts` supports this flow. Records are distinguished by the field `grader: 'human' | 'llm:gemini' | 'llm:claude' | 'llm:openai'` (legacy records without the field are treated as `human` for backward compatibility). The harness writes `gradingProvenance` to metadata (`'human'`, `'llm:openai'` or `'mixed(human+llm:openai)'`) and `gradeCounts` (e.g., `{"human": 312, "llm:openai": 1734}`) — visible right in `evals/results.json`, so an LLM-baseline run never gets confused with human gold.

---

## HOW: metrics (`evals/score.ts`)

### nDCG@10

```ts
export function dcg(grades: number[], k: number): number {
  return grades.slice(0, k).reduce((sum, g, i) => {
    return sum + (Math.pow(2, g) - 1) / Math.log2(i + 2);
    //          ^^^^^^^^^^^^^^^^^^^^   gain exponential by grade (0→0, 1→1, 2→3, 3→7)
    //                              ^^^^^^^^^^^^^^^ discount logarithmic by position
  }, 0);
}

export function ndcg(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const grades = retrieved.slice(0, k).map((id) => goldGrades.get(id) ?? 0);
  const idealGrades = [...goldGrades.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(idealGrades, k);
  if (idealDcg === 0) return 0;
  return dcg(grades, k) / idealDcg;
}
```

**What this formula does:**
- `2^g - 1` — exponential gain. A document with grade=3 (highly relevant) contributes 7. With grade=1 (tangential) — 1. The 7x difference between "good" and "ideal" is standard.
- `1 / log2(i + 2)` — positional discount. At position 1 the coefficient is 1.0, at 10 — 0.29. A document at position 10 contributes less than the same document at position 1.
- `nDCG = DCG / idealDCG` — normalization to 1 (what perfect ranking would give).

nDCG = 1.0 → you returned the ideal order. nDCG = 0.7 → you rank close to ideal, but not perfect.

### Recall@5

```ts
export function recallAtK(retrieved: number[], goldGrades: Map<number, number>, k: number): number {
  const relevant = new Set<number>(
    [...goldGrades.entries()].filter(([, g]) => g >= 2).map(([id]) => id),
    //                              ↑ only grade ≥ 2 counts as "relevant"
  );
  if (relevant.size === 0) return 0;
  const inTopK = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return inTopK / relevant.size;
}
```

**The `grade ≥ 2` threshold** is a project decision. Tangential (grade=1) doesn't count as relevant for recall. This makes the metric stricter, but more honest: a user who sees an answer "tangentially related to the topic" is probably not happy.

If grade=1 were counted too → recall would shoot up to almost 1.0 for all modes (because tangential is easy to find). The metric would lose discriminative power.

### MRR (Mean Reciprocal Rank)

```ts
export function mrr(retrieved: number[], goldGrades: Map<number, number>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if ((goldGrades.get(retrieved[i]) ?? 0) >= 2) return 1 / (i + 1);
  }
  return 0;
}
```

"Find the first highly relevant document; return 1 / its position." Ideal: first position, MRR=1.0. Ninth — MRR=0.111.

MRR is good for search UX: users look at the first 1–3 results. If the first highly relevant result is at position 5 — the user has already left.

### Why all three metrics

- **nDCG@10** — overall ranking quality. Accounts for all grades in top-10.
- **Recall@5** — "how much of all the important stuff made the first five". UX-focused.
- **MRR** — "when the first genuinely good result shows up".

They correlate but aren't identical. The metrics catch you: if nDCG goes up but Recall@5 drops — you boosted grade=2 documents and sank grade=3.

---

## HOW: harness and measurement stability

From `evals/harness.ts`:

```ts
const RUNS_PER_QUERY = 3;

for (const q of queries) {
  for (const mode of ALL_MODES) {
    const runs: number[] = [];
    let lastIds: number[] = [];
    for (let i = 0; i < RUNS_PER_QUERY; i++) {
      const run = await runRetrieval(mode, q, K_FOR_METRICS);
      runs.push(run.latency.totalMs);
      lastIds = run.results.map((r) => r.id);
    }
    perMode[mode].ndcgs.push(ndcg(lastIds, gold, K_FOR_METRICS));
    perMode[mode].recalls.push(recallAtK(lastIds, gold, K_FOR_RECALL));
    perMode[mode].mrrs.push(mrr(lastIds, gold));
    perMode[mode].latencies.push(median(runs));   // <-- median per query
  }
}
```

**3 runs per query** — for latency. We take the median across runs, then p50/p95 across queries. If we did 1 run, latency would be noisy due to GC, caches, network jitter.

**Warm-up of the reranker before the loop** — so the first measurement doesn't include the ONNX model cold start.

### Append-only results.json

```ts
let history: unknown[] = [];
if (existsSync(RESULTS_PATH)) {
  const existing = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
  if (Array.isArray(existing)) history = existing;
}
history.push(row);
writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2));
```

Each run appends a new record with a timestamp + metadata:

```json
{
  "runId": "2026-05-22T14:30:00.000Z",
  "schemaVersion": "v1.0.0",
  "embeddingModel": "text-embedding-3-small",
  "rerankModel": "Xenova/ms-marco-MiniLM-L-6-v2",
  "corpusSize": 5000,
  "queryCount": 30,
  "gradingProvenance": "mixed(human+llm:gemini)",
  "gradeCounts": {"human": 312, "llm:gemini": 1734},
  "perMode": {
    "bm25":        {"ndcg10": 0.61, "recall5": 0.55, "mrr": 0.69, "p50LatencyMs": 8,   "p95LatencyMs": 18},
    "dense":       {"ndcg10": 0.68, "recall5": 0.61, "mrr": 0.74, "p50LatencyMs": 35,  "p95LatencyMs": 78},
    "fused":       {"ndcg10": 0.74, "recall5": 0.68, "mrr": 0.78, "p50LatencyMs": 44,  "p95LatencyMs": 92},
    "fusedRerank": {"ndcg10": 0.83, "recall5": 0.79, "mrr": 0.85, "p50LatencyMs": 178, "p95LatencyMs": 295}
  }
}
```

This history is the single source of truth proving the project's improvement history. When in 3 months you swap the embedding model — you'll see in this file whether things got better or worse, and by how much.

---

## Eval failure modes

**Leakage queries → tuning.** If you tuned parameters (rerank top-N, RRF k) on the same eval set, your numbers are inflated. Fix: holdout queries. Take 20 queries for development, 10 for the final test set, don't touch them until the very end.

**Too few queries.** On 30 queries the CI for a 0.02 nDCG difference is ~0.05 — meaning two models with <0.05 nDCG difference are statistically indistinguishable. For educational fine; for production you need 100+ queries.

**All queries of one type.** If you have 30 queries about code — you'll see that dense roughly equals BM25. That's not a general conclusion, it's an artifact of your eval set. Deliberately mix types.

**LLM-judge without cross-check.** If all 2000 pairs are graded by one gpt-4o-mini and none by a human, you don't know how much to trust it on your corpus.

**Comparing runs with different grading.** If in run 1 grading is partially from gemini, in run 2 — from claude, the difference may not be from the retrieval model but from grader differences. Fix grading and re-grade only when queries/corpus change.

---

## What you get

```bash
$ pnpm eval
Eval harness: 30 queries × 4 modes × 3 runs each
Warming up reranker pipeline...
  ✓ "postgres vacuum freeze"
  ✓ "why I left FAANG after 8 years"
  ...
Wrote run to evals/results.json.
```

And a table in the file. That's the project's final artifact. Not an app, not a demo — a table proving the order of layers on your corpus.

The next and final stage is synthesis: an optional LLM-summary layer over top-10 for queries where the user wants "an answer", not "a list".
