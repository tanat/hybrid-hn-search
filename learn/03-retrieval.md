# 03. Retrieval: BM25 and dense, two independent stacks

## WHY

In the previous stage you laid down the corpus so that each comment has:
- A `text_search :: tsvector` with a GIN index — for lexical search.
- An `embedding :: vector(1536)` with an HNSW index — for semantic search.

Both are independent "ranked sources". Each answers one question: "give me the top-K documents for this query, sorted by your own relevance criterion". And each answers in its own way.

In this stage we'll implement both retrievers so they:
1. Return the **same** `RetrievalResult[]` (same payload shape, same interface).
2. Return `rank` (1-based position in the list) — needed for RRF in the next stage.
3. Log their latency separately (`embedMs`, `retrieveMs`).

If both retrievers return "something of their own" — the fusion layer turns into a code dump with ifs. So a shared contract is an investment in the simplicity of the whole pipeline.

---

## HOW: the shared contract

```ts
// retrieve/types.ts
export type RetrievalResult = {
  id: number;
  story_id: number;
  story_title: string;
  story_url: string | null;
  author: string;
  text: string;
  points: number;
  created_at: string;
  score: number;       // <-- raw retriever relevance (not comparable across modes!)
  rank: number;        // <-- 1-based position, comparable across modes
};

export type RetrievalMode = 'bm25' | 'dense' | 'fused' | 'fused-rerank';
```

Each mode's `score` lives in its own scale:
- BM25 (`ts_rank_cd`): unbounded, depends on document length and number of occurrences
- Dense (`1 - <=>`): `[0, 2]`, usually `[0.2, 0.6]` on our corpus
- Fused (RRF): `~[0.005, 0.033]`, sum of `1/(k+rank)`
- Rerank: `[0, 1]`, sigmoid over cross-encoder logits

**Key principle:** between modes, compare `rank`, not `score`. If you surface "score: 0.83" in the UI — that's useful for debugging, but useless for the user. Already at this level the reason for the later RRF choice (over weighted combine) is being established.

---

## HOW: sparse retrieval (BM25 via tsvector)

```ts
// retrieve/sparse.ts in full
export async function sparseRetrieve(query: string, k = 50) {
  const t0 = performance.now();
  const rows = await db`
    SELECT c.id, c.story_id, c.story_title, c.story_url, c.author, c.text,
           c.points, c.created_at,
           ts_rank_cd(c.text_search, plainto_tsquery('english', ${query})) AS score
    FROM comments c
    WHERE c.text_search @@ plainto_tsquery('english', ${query})
    ORDER BY score DESC
    LIMIT ${k}
  `;
  const t1 = performance.now();
  const results = rows.map((r, i) => ({ ...r, score: Number(r.score), rank: i + 1 }));
  return { results, timings: { retrieveMs: t1 - t0 } };
}
```

### `plainto_tsquery` vs `to_tsquery` vs `websearch_to_tsquery`

Three parsers for user input. The choice isn't cosmetic:

| Parser | Accepts | What it does with garbage |
|--------|----------------|----------------------|
| `to_tsquery` | formal syntax: `cat & rat & !mouse` | **throws an exception** on any `'`, `:`, extra space |
| `plainto_tsquery` | free text | conjunction of all tokens (`AND`) |
| `websearch_to_tsquery` | Google-style: `"phrase" -negation OR alt` | parses quotes, minuses, OR |

For an educational project `plainto_tsquery` is the sweet spot: doesn't crash, does reasonable default behavior. `websearch_to_tsquery` is more interesting for production because it supports phrases (`"vacuum freeze"`) and negation (`-aws`). On a real product I'd use it.

**When it breaks:** if you use `to_tsquery` directly on user input, any `:` in the query (e.g., "git: how to") causes a ParseError. You find out about it after an hour of debugging.

### `ts_rank_cd` vs `ts_rank`

- `ts_rank` — accounts only for occurrence frequency and tsvector weights.
- `ts_rank_cd` (cover density) — additionally accounts for term proximity. A document where `"postgres vacuum"` is adjacent ranks higher than one where `postgres` is at the start and `vacuum` at the end.

For short queries (1–4 tokens) `ts_rank_cd` is consistently better. The PostgreSQL docs still write "no general formula for which is best", but the 2026 practice has settled: `cd` for typical UX search.

### Why `WHERE @@` + `ORDER BY ts_rank_cd`, not just `ORDER BY`

Without `WHERE`, Postgres computes rank for **every** row in the table (5000 ops), then sorts. With `WHERE @@` the GIN index first filters matching rows (usually <500 on our corpus), then rank is computed only for them.

The difference on 5000 rows is a few milliseconds. On 5M — it's the difference between 8ms and 5 seconds.

### What comes back

```
Query: "postgres vacuum freeze"
Top-5:
  1. score=0.247  "Yeah, autovacuum freeze threshold is the silent killer..."
  2. score=0.183  "We hit vacuum freeze storms on a 2TB postgres last year..."
  3. score=0.156  "Postgres VACUUM FULL takes table lock — use pg_repack instead..."
  4. score=0.142  "vacuum_freeze_min_age default of 50M transactions is..."
  5. score=0.099  "Set vacuum_cost_limit higher if you have IO headroom..."
```

All five contain words from the query. The `score` numbers aren't comparable to other queries (document lengths differ), but the **order** within one query is correct.

---

## HOW: dense retrieval (pgvector cosine)

```ts
// retrieve/dense.ts in full (simplified)
export async function denseRetrieve(query: string, k = 50) {
  const t0 = performance.now();
  const { embedding } = await embed({
    model: 'openai/text-embedding-3-small',
    value: query,
  });
  const t1 = performance.now();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await db`
    SELECT c.id, /* ... other fields ... */
           1 - (e.embedding <=> ${vectorLiteral}::vector) AS score
    FROM embeddings e
    JOIN comments c ON c.id = e.comment_id
    ORDER BY e.embedding <=> ${vectorLiteral}::vector
    LIMIT ${k}
  `;
  const t2 = performance.now();
  return {
    results: rows.map((r, i) => ({ ...r, rank: i + 1 })),
    timings: { embedMs: t1 - t0, retrieveMs: t2 - t1 },
  };
}
```

### Step 1: embed query

One network call via AI Gateway. Latency ~25ms p50, ~60ms p95. This is the slowest part of dense mode under normal conditions.

We use the same `text-embedding-3-small` we used for documents. **This is critically important**: the query embedding and the document embedding must come from the same model at the same dimensionality. Otherwise cosine between them is meaningless (even the dimensions won't match, the DB will throw an error).

A note on asymmetric models: some embedding models are trained with different "prompt prefixes" for query and document (e.g., BGE requires a `"query:"` prefix). OpenAI has no such prefixes — `text-embedding-3-small` is symmetric. This simplifies the code, but in pure IR terms we lose 1–3 points of nDCG. For an educational corpus, not a big deal.

### Step 2: SQL with pgvector operators

Three key points in the SQL:

**The `<=>` operator** — cosine distance (`1 - cosine_similarity`). Smaller = better. Alternatives:
- `<->` — L2 distance (Euclidean). Equivalent to `<=>` for normalized vectors.
- `<#>` — negative inner product. Equivalent for normalized.

OpenAI embeddings are normalized (norm = 1), so all three give the same order. We use `<=>` because it's intuitive by shape.

**`ORDER BY` in identical form.** If you write:
```sql
ORDER BY 1 - (e.embedding <=> ${vec}::vector)  DESC
```
instead of `ORDER BY e.embedding <=> ${vec}::vector ASC`, the planner **won't use the HNSW index**. The planner matches the exact form of the expression against what's in the index. Any wrapper (subtraction, function) → seq scan.

This is the most common trap. Verified via `EXPLAIN`:
```sql
EXPLAIN SELECT ... ORDER BY e.embedding <=> ${vec}::vector LIMIT 50;
-- look for "Index Scan using idx_embeddings_hnsw" instead of "Seq Scan"
```

**Literal, not bind parameter:** `${vectorLiteral}::vector`, where `vectorLiteral` is the string `[0.012,-0.034,...]`. `postgres.js` sends this as a literal in SQL, not as a parameter. The reason: pgvector parameter binding via `postgres.js` sometimes breaks on 1536-dimensional arrays over slow TCP — the literal is more stable. At larger scale you can switch to bind, but for educational volume the literal is fine.

### HNSW parameters at query time

`ef_search` (default 40) — the size of the candidate set during search. The higher, the better recall, but slower. If you want recall@10 closer to 100%, do:

```sql
SET LOCAL hnsw.ef_search = 100;
-- ... your SELECT ...
```

On 5K vectors the difference between `ef_search=40` and `ef_search=100` is 2–3ms, recall@10 goes from 97% to 99.5%. A cheap gain.

**When it breaks (HNSW and updates):** HNSW in pgvector 0.9 supports inserts, but doesn't tolerate mass updates with vector changes well. If you regularly recompute embeddings — do `REINDEX INDEX idx_embeddings_hnsw;` once a day. Otherwise the index degrades in recall.

### What comes back

```
Query: "why senior engineers leave bigtech"
Top-5:
  1. score=0.412  "I left FAANG after 9 years. The compensation was great but..."
  2. score=0.398  "Stock vest cliff is brutal — you stay 4 years to grind through..."
  3. score=0.372  "Burnout in tech is real. It's not the hours, it's the meetings..."
  4. score=0.355  "Layoffs in 2024 changed everything for senior ICs..."
  5. score=0.341  "After 12 YOE I went indie. Best decision I ever made..."
```

None of the top-5 contain the words "senior", "leave", "bigtech". BM25 would return nothing or noise on this query. Dense catches the concept — because during training the model saw millions of examples of "burnout" → "leaving job" → "FAANG" in a shared context.

---

## HOW: both retrievers in parallel

In `retrieve/modes.ts`:

```ts
const [denseR, sparseR] = await Promise.all([
  denseRetrieve(query, poolSize),
  sparseRetrieve(query, poolSize),
]);
```

`Promise.all` is critical. Sparse doesn't depend on dense, dense doesn't depend on sparse. Run sequentially, latency ≈ sparse + dense = ~45ms. In parallel — `max(sparse, dense) = ~35ms`. On fused/fused-rerank that's 10ms of free savings.

Postgres holds both queries simultaneously via two connections from the pool. `postgres.js` pool defaults to 10 — that's plenty.

**When it breaks:** if you share one Postgres client across multiple parallel `await db\`...\``, on older driver versions the queries serialize. Modern `postgres.js` (v3+) spreads them across different connections — but check the version.

---

## When each mode wins: intuition through examples

```
Query type             | BM25 nDCG | Dense nDCG | Best on
-----------------------+-----------+------------+------------
"pgvector HNSW"        |    0.85   |    0.62    | BM25 (precise terms)
"useEffect cleanup"    |    0.78   |    0.71    | BM25 (specific API)
"why I left FAANG"     |    0.42   |    0.69    | Dense (concept)
"stock vest cliff"     |    0.55   |    0.66    | Dense (slight edge)
"impostor syndrome"    |    0.38   |    0.74    | Dense (phraseology)
"react server"         |    0.81   |    0.79    | Tie
```

These numbers are illustrative, your specific ones will differ. But the **pattern reproduces**: the more unique the tokens in the query → BM25; the more "fuzzy" the concept → dense. Hybrid (RRF) wins on both categories because it loses neither's strength.

The next stage is fusion proper: how to combine these two lists without score normalization.
