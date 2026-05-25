import 'dotenv/config';
import { denseRetrieve } from '../retrieve/dense';
import { db } from '../db/client';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('usage: pnpm tsx scripts/test-dense.ts "<query>"');
    process.exit(1);
  }
  const { results, timings } = await denseRetrieve(query, 10);
  console.log(
    `Top ${results.length} dense matches  (embed ${timings.embedMs.toFixed(0)}ms, retrieve ${timings.retrieveMs.toFixed(0)}ms)`,
  );
  for (const r of results) {
    const snippet = r.text.replace(/\s+/g, ' ').slice(0, 140);
    console.log(`  [${r.rank}] (score=${r.score.toFixed(3)}) "${snippet}..."`);
    console.log(`       — ${r.author} on ${r.story_title}`);
  }
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
