# 02. Ingest: HN Algolia → Postgres → embeddings

## WHY

Search only works on what's in the index. This stage is about assembling a corpus of 5000 HN comments, putting it into Postgres so two ranking modes (sparse and dense) work out of the gate, and doing it in a reproducible way.

Three phases, three files, each done once:

```
fetch-comments.ts   →  fixtures/comments.json   (HN Algolia → JSON, ~5–10 min)
load-postgres.ts    →  comments table           (JSON → Postgres + tsvector, ~5 sec)
embed.ts            →  embeddings table         (batched embedMany, ~2 min, ~$0.02)
```

Splitting into three scripts isn't cosmetic:
- **Fetch** talks to an external API with a rate limit, can crash midway, must be resumable. That's why it writes to a file, not the DB.
- **Load** is a pure JSON → SQL transform, idempotent via `ON CONFLICT DO NOTHING`. You can re-run it as many times as you want.
- **Embed** is expensive in money (even if cents) and time, talks to a paid API. It must be able to resume from where it crashed.

If this were a single procedure, any failure on the embed phase would mean re-fetching the corpus from HN from scratch. And Algolia is rate-limited softly, but has daily caps.

---

## HOW: phase 1 — fetch

### Where we pull from

The HN Algolia API is the only sane public endpoint for HN. No key, rate limit ~10 RPS unofficially. Two endpoints:

```
GET /api/v1/search?tags=story&numericFilters=created_at_i>{epoch}
GET /api/v1/items/{itemId}    # recursive comment tree
```

Strategy:
1. Pull top-N stories from the last 12 months from `search`.
2. Sort by `num_comments` — more comments = more harvest per fetch.
3. For each story, pull `items/{id}` — get the comment tree.
4. DFS-traverse, filter (`text.length > 100`, not deleted, not dead), take the top 5 branches.

### Key points in `ingest/fetch-comments.ts`

```ts
const TARGET_COMMENTS = 5000;
const TWELVE_MONTHS_SECONDS = 60 * 60 * 24 * 365;
const MIN_TEXT_LEN = 100;
const TOP_PER_STORY = 5;
const RATE_LIMIT_RPS = 10;
```

`MIN_TEXT_LEN = 100` is critical filtering. Short comments ("agreed", "+1", "this") create noise: both BM25 and the embedding produce nonsense on them. 100 characters is the threshold above which a comment usually contains at least one meaningful statement.

`TOP_PER_STORY = 5` is a tradeoff. Taking everything — the corpus skews toward mega-threads (1000+ comments). Taking 1 — you need too many stories. 5 per story → ~1000 stories for 5000 comments.

### Rate limit without libraries

```ts
class RateLimiter {
  private last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait() {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.last);
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }
}
const limiter = new RateLimiter(1000 / RATE_LIMIT_RPS);
```

Not a token bucket, not a leaky bucket — plain spacing. Between two fetches `100ms` must pass (at 10 RPS). If the API responded faster — we wait. The algorithm ignores burst windows, but Algolia is fine at this scale. If a 429 happens — there's retry with exponential backoff:

```ts
if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
// ...
if (attempt < 4) {
  const backoff = 500 * 2 ** attempt;  // 500, 1000, 2000, 4000ms
  await sleep(backoff);
  return fetchJson<T>(url, attempt + 1);
}
```

5 attempts with base-2 exponent — the standard. If after 4 retries (about 8 seconds of waiting in total) the service doesn't recover — skip the story and move on. Lose few, keep most.

### Resumability

```ts
let collected: FlatComment[] = existsSync(FIXTURE_PATH)
  ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as FlatComment[])
  : [];
if (collected.length >= TARGET_COMMENTS) {
  console.log(`Already have ${collected.length} comments...`);
  return;
}
// ...
if (processed % 10 === 0) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(collected));  // periodic save
}
```

Every 10 stories — dump to disk. If the process crashes, on restart it continues from the same place.

**Failure scenario:** once I forgot about saving and lost 4000 comments after 30 minutes of work — Node OOM-ed on parsing one particularly megabyte-sized comment tree. Since then — periodic save everywhere work takes longer than a minute.

### HTML cleanup

HN returns comments as HTML-flavored text: `<p>`, `<br>`, `<a href="...">`, and HTML entities (`&#x27;`, `&quot;`). You can't drop raw HTML into Postgres — it breaks both tsvector and the embedding (the model spends tokens on markup). In `flattenStripText`:

```ts
let s = text
  .replace(/<\s*p\s*\/?\s*>/gi, '\n\n')
  .replace(/<\s*br\s*\/?\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x27;/g, "'")
  // ... the rest of the entities
```

We don't use a parser like `cheerio` — overkill for HN's conservative HTML. Regexes cover 99% of cases; the remaining 1% (nested tags inside `<code>`) we ignore — that's noise at the level of individual characters.

---

## HOW: phase 2 — load into Postgres

### Schema

```sql
-- db/schema.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT PRIMARY KEY,
  story_id BIGINT NOT NULL,
  story_title TEXT NOT NULL,
  story_url TEXT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  parent_id BIGINT,
  text_search tsvector              -- <-- auto-generated column via trigger
);

CREATE INDEX IF NOT EXISTS idx_comments_text_search ON comments USING GIN(text_search);
```

`text_search` is not a `GENERATED COLUMN`, but a regular column populated by a trigger:

```sql
CREATE OR REPLACE FUNCTION comments_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.text_search := to_tsvector('english', NEW.text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
  ON comments FOR EACH ROW EXECUTE FUNCTION comments_tsvector_trigger();
```

Why a trigger and not `GENERATED ALWAYS AS (to_tsvector('english', text)) STORED`? Both work; the trigger gives you the flexibility to change the configuration (e.g., add custom stopwords) without an `ALTER TABLE`. On 5K rows the difference isn't visible, on millions — the trigger is slightly slower on write, but still fine.

The `'english'` configuration is the standard English stemmer. For HN it works because 99% of the corpus is in English. If you have a multilingual corpus — you need `simple` (no stemming) or a specific configuration per language. This is a tradeoff between recall (stemming helps) and precision (stemming "shatters" specific terms).

### Separate embeddings table

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  comment_id BIGINT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Why a separate table:** embeddings are a computationally expensive artifact. If you change the embedding model, you want to drop/recreate only embeddings, not touch comments. If you make one wide table — recreating the model = `ALTER TABLE` on the main table, which blocks search.

**HNSW parameters:** `m=16, ef_construction=64` — the standard defaults for pgvector 0.9. `m` is the number of connections per node in the graph (higher = better recall, more memory). `ef_construction` is the size of the candidate set during build (higher = better recall, longer build). For 5K vectors this takes ~3 seconds. The third parameter, `ef_search` (default 40), is set at query time — it determines search quality.

**When it breaks:** if you set `m` and `ef_construction` too small (4 and 16), on 5K vectors everything seems fine, but on 500K recall@10 drops 20+ points. If you set them too large (m=64, ef_construction=400), index build takes minutes and the index uses more memory. The community converged on `m=16, ef_construction=64` as a reasonable default.

### Batched loading via postgres.js

```ts
// ingest/load-postgres.ts (simplified)
for (let i = 0; i < comments.length; i += BATCH_SIZE) {  // BATCH_SIZE = 500
  const batch = comments.slice(i, i + BATCH_SIZE);
  await db`
    INSERT INTO comments ${db(batch, 'id', 'story_id', 'story_title', ...)}
    ON CONFLICT (id) DO NOTHING       -- <-- idempotency
  `;
}
```

`postgres.js` accepts an array of objects via `db(array, ...columns)` — expands it into VALUES. `ON CONFLICT (id) DO NOTHING` makes the script idempotent: you can re-run it after topping up the fixture.

Sanity check at the end:

```ts
const [{ nullc }] = await db<{ nullc: number }[]>`
  SELECT COUNT(*)::int AS nullc FROM comments WHERE text_search IS NULL
`;
if (nullc > 0) console.warn(`! ${nullc} rows have NULL text_search`);
```

If the trigger didn't fire (typo in the name, missing function) — you find out immediately, not in an hour during search.

---

## HOW: phase 3 — embeddings

### Why `embedMany` and not `embed` in a loop

```ts
// ingest/embed.ts (key chunk)
import { embedMany } from 'ai';
const BATCH_SIZE = 100;
const MODEL_ID = 'openai/text-embedding-3-small';

for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  const batch = pending.slice(i, i + BATCH_SIZE);
  const result = await embedMany({
    model: MODEL_ID,
    values: batch.map((b) => b.text),
  });
  const { embeddings, usage } = result;
  // INSERT into the DB...
}
```

The OpenAI API allows up to 2048 texts per call for `text-embedding-3-small`. Vercel AI SDK `embedMany` automatically chunks under the hood if the limit is exceeded. We use `BATCH_SIZE = 100` — a tradeoff between:

- Too large a batch → a single upstream error wipes 2048 embeddings, retry is expensive.
- Too small → many HTTP round-trips, total time grows.

100 is the sweet spot for educational volume. On 1M+ documents it makes sense to bump it up to 500–1000.

### Via AI Gateway

- AI Gateway gives you **$5/mo free** on embeddings + LLM for each Vercel team.
- The paid tier is **zero markup** on provider tokens. You pay the same as you would directly to OpenAI, plus you get unified observability and rate-limit handling.
- The model is passed as a string `'openai/text-embedding-3-small'` directly to `embedMany`/`embed` — the SDK itself routes requests through the Gateway if `AI_GATEWAY_API_KEY` is in the environment. One key covers both embeddings and the LLM-grader providers (`gateway('openai/...')`, `gateway('anthropic/...')`).
- `'openai/text-embedding-3-small'` is `$0.02 / 1M tokens`. A 5000-comment corpus × ~100 tokens = 500K tokens = **~$0.01** one-time.

That's less than a cup of coffee and doesn't repeat (`ON CONFLICT DO NOTHING` on the next run). One of the cheapest layers in the modern AI stack.

### Idempotent: skip what's already embedded

```ts
const pending = await db<Pending[]>`
  SELECT c.id, c.text
  FROM comments c
  LEFT JOIN embeddings e ON e.comment_id = c.id
  WHERE e.comment_id IS NULL
  ORDER BY c.id
`;
```

We query only those comments for which there's no record in embeddings. If you added 500 new comments to the fixture and re-ran the pipeline — the embed phase will only do those 500.

`ON CONFLICT (comment_id) DO NOTHING` on the insert is a safeguard against race conditions if you run it in parallel.

### What it costs and how long it takes

| Metric | Value |
|---------|----------|
| Corpus | 5000 HN comments |
| Total tokens | ~500K |
| API calls via AI Gateway | 50 (batches of 100) |
| Time on a single MacBook via AI Gateway | ~2 minutes |
| Cost | $0.01 |
| Embeddings table size | ~5000 × 1536 × 4 bytes = ~31 MB |
| HNSW index size | ~10 MB |

### When it breaks: rate limit

Vercel AI Gateway defaults to ~30 RPM on the free tier and ~600 RPM on the paid tier. If you outrun that — `embedMany` will throw 429, and the AI SDK won't retry it on its own. Fix:

```ts
const { embeddings } = await embedMany({
  model: MODEL_ID,
  values,
  maxRetries: 3,           // <-- AI SDK retry with exponent
  maxParallelCalls: 2,     // <-- if you use embedMany on large chunks
});
```

`maxRetries` defaults to 2 in the AI SDK. If you hit the rate limit — bump it to 5 and don't run in parallel from multiple processes.

---

## What you get

After the three scripts, the DB has:

```sql
SELECT
  (SELECT COUNT(*) FROM comments) AS comments,
  (SELECT COUNT(*) FROM embeddings) AS embeddings;

 comments | embeddings
----------+------------
     5000 |       5000
```

And two indexes are ready:
- `idx_comments_text_search` (GIN) — for BM25 mode via `tsvector @@ tsquery`.
- `idx_embeddings_hnsw` — for dense mode via the `<=>` operator.

The next stage is retrieval proper: how to use these two indexes to get the top-K candidates and why exactly this way.
