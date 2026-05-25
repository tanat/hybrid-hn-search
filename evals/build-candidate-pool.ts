import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runRetrieval, ALL_MODES } from '../retrieve/modes';
import { db } from '../db/client';

const QUERIES_PATH = 'fixtures/queries.json';
const OUTPUT_PATH = 'fixtures/candidate-pool.json';
const POOL_K = 30;

type CandidatePool = Record<string, number[]>;

async function main() {
  const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8')) as string[];
  if (!Array.isArray(queries) || queries.length === 0) {
    console.error(
      `${QUERIES_PATH} is empty. Add 30 queries (strings) to it before running this script.`,
    );
    process.exit(1);
  }
  console.log(`Building candidate pool for ${queries.length} queries (k=${POOL_K} per mode)...`);

  const pool: CandidatePool = {};
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const ids = new Set<number>();
    for (const mode of ALL_MODES) {
      try {
        const run = await runRetrieval(mode, q, POOL_K);
        for (const r of run.results) ids.add(r.id);
      } catch (err) {
        console.warn(`  ! mode=${mode} failed for q="${q}":`, (err as Error).message);
      }
    }
    pool[q] = Array.from(ids).sort((a, b) => a - b);
    console.log(`  [${i + 1}/${queries.length}] "${q}" → ${pool[q].length} unique candidates`);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(pool, null, 2));
  const total = Object.values(pool).reduce((acc, arr) => acc + arr.length, 0);
  console.log(`\nDone. Wrote ${total} (query,candidate) pairs across ${queries.length} queries to ${OUTPUT_PATH}.`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
