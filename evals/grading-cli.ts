import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { db } from '../db/client';
import {
  loadGrades,
  saveGrades,
  listUngraded,
  recordGrade,
  totalCandidates,
  type CandidatePool,
  type Grade,
} from './grades-store';

const QUERIES_PATH = 'fixtures/queries.json';
const POOL_PATH = 'fixtures/candidate-pool.json';
const GRADES_PATH = 'fixtures/candidate-grades.json';

const HELP = `
GRADE CLI — relevance judgments for Phase 9.

Grade scale:
  3 = highly relevant; would show this if I had only one slot
  2 = partially relevant; clear answer to a closely related question
  1 = tangential; mentions topic but doesn't answer
  0 = irrelevant
  s = skip this candidate (won't be saved; revisit on next run)
  ? = show this help
  q = quit (progress already saved)

Tips:
  - Be consistent. If unsure between 1 and 2, lean lower.
  - Don't grade based on writing quality; grade based on whether the comment
    answers the query.
  - Take a break every 30-45 minutes; consistency drops past that.
`;

async function fetchCommentBatch(ids: number[]) {
  if (ids.length === 0) return new Map<number, { story_title: string; author: string; text: string }>();
  const rows = await db<
    Array<{ id: number; story_title: string; author: string; text: string }>
  >`
    SELECT id, story_title, author, text FROM comments WHERE id IN ${db(ids)}
  `;
  const map = new Map<number, { story_title: string; author: string; text: string }>();
  for (const r of rows) map.set(Number(r.id), { story_title: r.story_title, author: r.author, text: r.text });
  return map;
}

async function main() {
  if (!existsSync(QUERIES_PATH) || !existsSync(POOL_PATH)) {
    console.error(
      `Missing ${QUERIES_PATH} or ${POOL_PATH}. Build the candidate pool first:\n` +
        `  pnpm tsx evals/build-candidate-pool.ts`,
    );
    process.exit(1);
  }
  const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8')) as string[];
  const pool = JSON.parse(readFileSync(POOL_PATH, 'utf-8')) as CandidatePool;

  // Make sure the pool only contains queries we still know about.
  const filteredPool: CandidatePool = {};
  for (const q of queries) if (pool[q]) filteredPool[q] = pool[q];

  const store = loadGrades(GRADES_PATH);
  const ungraded = listUngraded(filteredPool, store);
  const total = totalCandidates(filteredPool);
  const graded = total - ungraded.length;

  console.log(`Loaded ${queries.length} queries, ${total} candidates total.`);
  console.log(`Already graded: ${graded}. Remaining: ${ungraded.length}.`);
  console.log(`Type ? at any prompt for help. Progress saves after every grade.\n`);

  if (ungraded.length === 0) {
    console.log('All candidates graded. Done.');
    await db.end();
    return;
  }

  // Pre-fetch the comment payloads for the upcoming batch so we don't issue
  // one DB query per grade prompt.
  const payloads = await fetchCommentBatch(Array.from(new Set(ungraded.map((u) => u.comment_id))));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  let count = graded;
  let quit = false;
  for (const item of ungraded) {
    if (quit) break;
    const c = payloads.get(item.comment_id);
    if (!c) {
      console.warn(`  ! comment ${item.comment_id} not in DB; skipping`);
      continue;
    }

    console.log('─'.repeat(72));
    console.log(`Query: "${item.query}"`);
    console.log(`Comment ${item.comment_id} (story: "${c.story_title}", by ${c.author}):\n`);
    console.log(c.text);
    console.log('');

    let grade: Grade['grade'] | null = null;
    while (grade === null && !quit) {
      const ans = (await rl.question('Grade (0-3, s=skip, ?=help, q=quit): ')).trim().toLowerCase();
      if (ans === 'q') {
        quit = true;
        break;
      }
      if (ans === '?') {
        console.log(HELP);
        continue;
      }
      if (ans === 's') {
        console.log('  skipped (will appear again on next run)\n');
        break;
      }
      if (['0', '1', '2', '3'].includes(ans)) {
        grade = Number(ans) as Grade['grade'];
      } else {
        console.log('  please enter 0, 1, 2, 3, s, ?, or q');
      }
    }
    if (quit || grade === null) continue;

    const rationale = (await rl.question('Rationale (one line, enter to skip): ')).trim() || undefined;
    const g: Grade = {
      query: item.query,
      comment_id: item.comment_id,
      grade,
      rationale,
      graded_at: new Date().toISOString(),
    };
    recordGrade(store, g);
    saveGrades(GRADES_PATH, store);
    count++;
    console.log(`  ✓ saved (${count} / ${total})\n`);
  }

  rl.close();
  console.log(`\nSession ended. ${count} of ${total} graded.`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
