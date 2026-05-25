import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { readFileSync, existsSync } from 'node:fs';
import { db } from '../db/client';
import {
  loadGrades,
  saveGrades,
  listUngraded,
  recordGrade,
  totalCandidates,
  type CandidatePool,
} from './grades-store';
import { llmGrade, type GraderProvider } from './llm-grader';

const QUERIES_PATH = 'fixtures/queries.json';
const POOL_PATH = 'fixtures/candidate-pool.json';
const GRADES_PATH = 'fixtures/candidate-grades.json';
const CONCURRENCY = 5;

function getProvider(): GraderProvider {
  const flag = process.argv.find((a) => a.startsWith('--provider='));
  const val = flag ? flag.split('=')[1] : (process.env.GRADER_PROVIDER ?? 'gemini');
  if (val !== 'gemini' && val !== 'claude' && val !== 'openai') {
    console.error(`Unknown provider "${val}". Use --provider=gemini|claude|openai`);
    process.exit(1);
  }
  return val as GraderProvider;
}

async function fetchComments(ids: number[]) {
  if (ids.length === 0) return new Map<number, { story_title: string; text: string }>();
  const rows = await db<Array<{ id: number; story_title: string; text: string }>>`
    SELECT id, story_title, text FROM comments WHERE id IN ${db(ids)}
  `;
  const map = new Map<number, { story_title: string; text: string }>();
  for (const r of rows) map.set(Number(r.id), r);
  return map;
}

async function main() {
  if (!existsSync(QUERIES_PATH) || !existsSync(POOL_PATH)) {
    console.error(
      `Missing ${QUERIES_PATH} or ${POOL_PATH}.\n` +
        `Run first: pnpm tsx evals/build-candidate-pool.ts`,
    );
    process.exit(1);
  }

  const provider = getProvider();
  const keyVar = provider === 'gemini' ? 'GEMINI_API_KEY' : 'AI_GATEWAY_API_KEY';
  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      console.error(`GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) is not set in .env.local`);
      process.exit(1);
    }
  } else if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(`${keyVar} is not set in .env.local`);
    process.exit(1);
  }
  console.log(`Auto-grader: provider=${provider}`);

  const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8')) as string[];
  const pool = JSON.parse(readFileSync(POOL_PATH, 'utf-8')) as CandidatePool;
  const filteredPool: CandidatePool = {};
  for (const q of queries) if (pool[q]) filteredPool[q] = pool[q];

  const store = loadGrades(GRADES_PATH);
  const ungraded = listUngraded(filteredPool, store);
  const total = totalCandidates(filteredPool);
  const alreadyDone = total - ungraded.length;

  console.log(`${total} candidates, ${alreadyDone} already graded, ${ungraded.length} remaining.\n`);
  if (ungraded.length === 0) {
    console.log('All candidates graded. Done.');
    await db.end();
    return;
  }

  const allIds = [...new Set(ungraded.map((u) => u.comment_id))];
  const payloads = await fetchComments(allIds);

  let done = alreadyDone;
  let errors = 0;

  for (let i = 0; i < ungraded.length; i += CONCURRENCY) {
    const batch = ungraded.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        const c = payloads.get(item.comment_id);
        if (!c) return;
        try {
          const { grade, reasoning } = await llmGrade(
            provider,
            item.query,
            c.text,
            c.story_title,
          );
          recordGrade(store, {
            query: item.query,
            comment_id: item.comment_id,
            grade,
            rationale: reasoning,
            graded_at: new Date().toISOString(),
            grader: `llm:${provider}`,
          });
          done++;
        } catch (err) {
          errors++;
          console.warn(`  ! failed (query="${item.query}" id=${item.comment_id}): ${err}`);
        }
      }),
    );
    saveGrades(GRADES_PATH, store);
    process.stdout.write(`\r[${done} / ${total}] graded  (${errors} errors)`);
  }

  console.log(`\n\nDone. ${done} graded, ${errors} errors.`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
