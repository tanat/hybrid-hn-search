# 07. Synthesis: optional answer layer on top of top-10

## WHY

After the reranker you have top-10 HN comments. For queries like `"rust async runtime trade-offs"` that's already good: the user sees 10 specific comments with links to the original threads.

But for some queries you want not "a list of links" but **an answer**. Query `"what's wrong with microservices"` — the user doesn't want to read 10 comments and stitch them together. They want: "Here are the main critical points mentioned in the comments: 1) operational complexity 2) network latency 3) ..."

This is the classic RAG task: hand the LLM the found documents and ask it to synthesize an answer. **This is the last step of the pipeline**, and unlike the previous ones, it **is not part of retrieval evaluation**. Synthesis can't be evaluated through nDCG — it either answers the question well or it doesn't, and that's a qualitative judgment.

That's why synthesis is split out as an optional layer. The project's eval table (nDCG@10 / Recall@5 / MRR) is computed **before** synthesis, because retrieval quality is what determines synthesis quality. GIGO: garbage in, garbage out.

---

## HOW: API

Synthesis is called as a separate endpoint after search:

```
POST /api/search       { query, mode } → { results: [...top10] }
POST /api/synthesize   { query, results } → { summary, topThreads }
```

The split is intentional:
- Retrieval is fast (~180ms). Synthesis is slower (~2–5 sec on gpt-4o-mini).
- The user sees retrieval results **immediately**, the synthesis loads asynchronously.
- Synthesis can be skipped entirely if the query is clearly "lookup-style" (`"useEffect cleanup"`).

### Frontend flow

```
1. User types query → /api/search → render 10 cards (~200ms)
2. In the background → /api/synthesize → render summary above the cards (~3s)
3. User sees results immediately, summary fills in
```

This is the "**progressive enhancement**" pattern in RAG UX: the main answer (documents) shows up instantly, the advanced answer (synthesis) catches up.

---

## HOW: code via `generateText + Output.object`

```ts
// simplified
import { gateway, generateText, Output } from 'ai';
import { z } from 'zod';

const SynthesisSchema = z.object({
  summary: z.string().describe('2-4 sentence answer combining the comments'),
  keyPoints: z.array(z.object({
    point: z.string(),
    supportingCommentIds: z.array(z.number()),
  })).max(5),
  topThreads: z.array(z.number()).max(3).describe('Up to 3 story_ids worth opening'),
});

export async function synthesize(query: string, results: RetrievalResult[]) {
  const docsContext = results.slice(0, 10).map((r, i) =>
    `[${i + 1}] (id=${r.id}, from "${r.story_title}")\n${r.text}`
  ).join('\n\n');

  const { output } = await generateText({
    model: gateway('openai/gpt-4o-mini'),
    output: Output.object({ schema: SynthesisSchema }),
    system: `You answer questions using ONLY the provided HN comments.
Cite comment ids you used in supportingCommentIds.
If the comments don't answer the query, say so explicitly in summary.
Do not invent information not in the comments.`,
    prompt: `Query: "${query}"\n\nComments:\n${docsContext}`,
  });
  return output;
}
```

### Key points

**`generateText + Output.object` via AI Gateway.** Structured output (validated by a Zod schema) lives via `output: Output.object({ schema })` inside a regular `generateText`, the result is read as `result.output`. One code path for all LLM calls — text and structured. The model is addressed via `gateway('openai/gpt-4o-mini')`, so a separate `OPENAI_API_KEY` isn't needed — `AI_GATEWAY_API_KEY` is enough.

**A small model is enough.** `gpt-4o-mini` is $0.15/1M input, $0.60/1M output. For synthesis over 10 short comments (~3K input tokens) it's pennies: ~$0.0005 per request.

**Citation via `supportingCommentIds`.** This is critical for UX: each "key point" must reference a specific comment. Otherwise the user can't verify — and that's the foundation of trust.

**`Do not invent information not in the comments`** — an anti-hallucination instruction. Small models tend to "fill in" with their general knowledge. This phrase + explicit "say so explicitly if comments don't answer" gives an honest "I don't know" answer to out-of-distribution queries.

### Streaming alternative

If you want to see the summary "type out":

```ts
import { gateway, streamText, Output } from 'ai';

const { partialOutputStream } = streamText({
  model: gateway('openai/gpt-4o-mini'),
  output: Output.object({ schema: SynthesisSchema }),
  // ...
});

for await (const partial of partialOutputStream) {
  // emit to the front via SSE
}
```

Streaming structured output is assembled from the same `Output.object` — `streamText` with `output:` returns a `partialOutputStream` with incremental JSON parts. In this project the stream isn't used — `generateText` + a spinner is enough for an educational corpus. In production with UX-critical latency, stream makes sense.

---

## Which models make sense

Current model palette:

| Model | Price $/1M input | Synthesis quality | Latency 10 docs |
|--------|-----------------|---------------------|------------------|
| `openai/gpt-4o-mini` | $0.15 | good | ~2.5 s |
| `openai/gpt-4o` | $2.50 | excellent | ~3 s |
| `anthropic/claude-haiku-4-5` | $0.25 | good | ~2 s |
| `anthropic/claude-sonnet-4-5` | $3 | excellent | ~3.5 s |
| `gemini-2.5-flash` | $0.10 | good | ~2 s |

For synthesis over 10 short comments any `flash`/`mini`-tier model is fine. Using `gpt-4o` or `claude-sonnet` is 10x overspend for a marginal quality gain.

---

## Failure modes

**Hallucinations from the model's general knowledge.** The most common problem: the user asks `"what is vector cosine"` — retrieval returns 3 not-very-relevant comments — the LLM tops it up with "Cosine similarity is..." from its own knowledge. The user thinks it came from HN. Fix: explicit instruction + temperature 0 + check `supportingCommentIds.length > 0`.

**Long-doc context overflow.** If 10 comments are long (2K tokens each), that's 20K input. On `gpt-4o-mini` (128K context) it's fine, but expensive. Better to cut each comment to the first 500 characters in the synthesis context — small loss, 4x savings.

**Synthesis masks bad retrieval.** If retrieval returned irrelevant documents, the LLM can **sound confident** even when the answer is garbage. Rule of thumb: if `nDCG@10 < 0.4` on this query — turn off synthesis or show a disclaimer. The proper solution is a check pipeline "is this query answerable from these docs".

**Cost at scale.** At 1000 search/day, synthesis = ~$0.50/day. At 100K/day — $50. Not drama, but more than retrieval itself costs. Fix: cache synthesis by `hash(query, sorted_doc_ids)`, because the same retrievals give the same synthesis (with temperature 0).

---

## Where synthesis fits, where it doesn't

**Fits:**
- Conceptual queries: `"why do startups fail"`, `"is rust worth learning"`, `"when do you need microservices"`.
- Opinion comparison: top-10 is different viewpoints, summary aggregates them.
- Discussion recap: "what the community thinks about X".

**Doesn't fit:**
- Lookup queries: `"useEffect cleanup"`. The user wants to see code. Synthesis here is a needless layer.
- Names/facts: `"who created postgres"`. That's general knowledge, no RAG needed.
- Queries with one correct answer: better to show the top-1 document.

In the UI you can automatically decide "run synthesis or not" via query classification, but that's a separate task (a query classifier). For an educational corpus — leave the "Get summary" button optional and let the user decide.

---

## What you get

After 7 stages you have:
- A corpus of 5000 HN comments in Postgres with two indexes (GIN + HNSW).
- 4 retrieval modes (`bm25`, `dense`, `fused`, `fused-rerank`).
- An eval table with nDCG@10 / Recall@5 / MRR / p50/p95 latency, proving the order of layers.
- An optional synthesis layer for queries where an aggregated answer is needed.

And most importantly — an understanding of **why exactly this way, and where it breaks**. On the next corpus you won't be copying the architecture, you'll be repeating the methodology: measure each layer separately, grade with blind+pool, keep reproducibility through append-only results.

This is production-grade hybrid search in 2026. Not "one model solves everything", but **a controlled pipeline of independently verifiable layers**.
