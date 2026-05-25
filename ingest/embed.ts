import 'dotenv/config';
import { embedMany } from 'ai';
import { db } from '../db/client';

const BATCH_SIZE = 100;
const MODEL_ID = 'openai/text-embedding-3-small';
// $0.02 / 1M input tokens for text-embedding-3-small.
const COST_PER_M_TOKENS = 0.02;

type Pending = { id: number; text: string };

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('AI_GATEWAY_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  const pending = await db<Pending[]>`
    SELECT c.id, c.text
    FROM comments c
    LEFT JOIN embeddings e ON e.comment_id = c.id
    WHERE e.comment_id IS NULL
    ORDER BY c.id
  `;
  console.log(`Embedding ${pending.length} comments in batches of ${BATCH_SIZE}...`);
  if (pending.length === 0) {
    await db.end();
    return;
  }

  let done = 0;
  let totalTokens = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const values = batch.map((b) => b.text);

    const result = await embedMany({
      model: MODEL_ID,
      values,
    });
    const embeddings = result.embeddings;
    // Token usage shape varies across AI SDK versions. Use any-cast to be defensive.
    const usage = (result as unknown as { usage?: { tokens?: number } }).usage;
    if (usage?.tokens) totalTokens += usage.tokens;

    const rows = batch.map((b, j) => ({
      comment_id: b.id,
      embedding: `[${embeddings[j].join(',')}]`,
      model: MODEL_ID,
    }));

    await db`
      INSERT INTO embeddings ${db(rows, 'comment_id', 'embedding', 'model')}
      ON CONFLICT (comment_id) DO NOTHING
    `;

    done += batch.length;
    console.log(`[${done} / ${pending.length}] embedded`);
  }

  const estCost = ((totalTokens || 0) / 1_000_000) * COST_PER_M_TOKENS;
  console.log(
    `\nDone. Total tokens (reported): ${totalTokens || 'unknown'}. Estimated cost: $${estCost.toFixed(4)}.`,
  );
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
