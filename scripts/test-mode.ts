import 'dotenv/config';
import { runRetrieval } from '../retrieve/modes';
import type { RetrievalMode } from '../retrieve/types';
import { db } from '../db/client';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: pnpm tsx scripts/test-mode.ts <bm25|dense|fused|fused-rerank> "<query>"');
    process.exit(1);
  }
  const mode = args[0] as RetrievalMode;
  const query = args.slice(1).join(' ').trim();

  const { results, latency } = await runRetrieval(mode, query, 10);
  console.log(`Mode: ${mode}  total=${latency.totalMs.toFixed(0)}ms`);
  console.log(`  breakdown: ${JSON.stringify(latency)}`);
  for (const r of results) {
    const snippet = r.text.replace(/\s+/g, ' ').slice(0, 140);
    console.log(`  [${r.rank}] (score=${r.score.toFixed(4)}) "${snippet}..."`);
    console.log(`       — ${r.author} on ${r.story_title}`);
  }
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
