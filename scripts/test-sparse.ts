import 'dotenv/config';
import { sparseRetrieve } from '../retrieve/sparse';
import { db } from '../db/client';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('usage: pnpm tsx scripts/test-sparse.ts "<query>"');
    process.exit(1);
  }
  const { results, timings } = await sparseRetrieve(query, 10);
  console.log(`Top ${results.length} sparse matches  (retrieve ${timings.retrieveMs.toFixed(0)}ms)`);
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
