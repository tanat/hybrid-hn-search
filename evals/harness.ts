import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runRetrieval, ALL_MODES } from '../retrieve/modes';
import { db } from '../db/client';
import { ndcg, recallAtK, mrr } from './score';
import type { Grade } from './grades-store';
import type { RetrievalMode } from '../retrieve/types';

const QUERIES_PATH = 'fixtures/queries.json';
const GRADES_PATH = 'fixtures/candidate-grades.json';
const RESULTS_PATH = 'evals/results.json';

const K_FOR_METRICS = 10;
const K_FOR_RECALL = 5;
const RUNS_PER_QUERY = 3;
const SCHEMA_VERSION = 'v1.0.0';

type ModeAgg = {
  ndcg10: number;
  recall5: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8')) as string[];
  if (!Array.isArray(queries) || queries.length === 0) {
    console.error(`No queries in ${QUERIES_PATH}`);
    process.exit(1);
  }
  if (!existsSync(GRADES_PATH)) {
    console.error(`No grades file at ${GRADES_PATH}. Run grading first.`);
    process.exit(1);
  }
  const gradesArr = JSON.parse(readFileSync(GRADES_PATH, 'utf-8')) as Grade[];
  const goldByQuery = new Map<string, Map<number, number>>();
  for (const g of gradesArr) {
    if (!goldByQuery.has(g.query)) goldByQuery.set(g.query, new Map());
    goldByQuery.get(g.query)!.set(g.comment_id, g.grade);
  }
  const graderCounts: Record<string, number> = {};
  for (const g of gradesArr) {
    const key = g.grader ?? 'human';
    graderCounts[key] = (graderCounts[key] ?? 0) + 1;
  }
  const graders = Object.keys(graderCounts).sort();
  const gradingProvenance =
    graders.length === 1 ? graders[0] : `mixed(${graders.join('+')})`;

  console.log(
    `Eval harness: ${queries.length} queries × ${ALL_MODES.length} modes × ${RUNS_PER_QUERY} runs each`,
  );

  const corpusSize = (await db<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM comments`)[0].c;

  const perMode: Record<RetrievalMode, {
    ndcgs: number[];
    recalls: number[];
    mrrs: number[];
    latencies: number[];
  }> = {
    bm25: { ndcgs: [], recalls: [], mrrs: [], latencies: [] },
    dense: { ndcgs: [], recalls: [], mrrs: [], latencies: [] },
    fused: { ndcgs: [], recalls: [], mrrs: [], latencies: [] },
    'fused-rerank': { ndcgs: [], recalls: [], mrrs: [], latencies: [] },
  };

  // Optional warm-up: run 'fused-rerank' on the first query once to load the model.
  if (queries.length > 0) {
    try {
      console.log('Warming up reranker pipeline...');
      await runRetrieval('fused-rerank', queries[0], K_FOR_METRICS);
    } catch (err) {
      console.warn('Warm-up failed:', (err as Error).message);
    }
  }

  for (const q of queries) {
    const gold = goldByQuery.get(q);
    if (!gold || gold.size === 0) {
      console.warn(`  ! no grades for query "${q}"; skipping`);
      continue;
    }
    for (const mode of ALL_MODES) {
      const runs: number[] = [];
      let lastIds: number[] = [];
      for (let i = 0; i < RUNS_PER_QUERY; i++) {
        const run = await runRetrieval(mode, q, K_FOR_METRICS);
        runs.push(run.latency.totalMs);
        lastIds = run.results.map((r) => r.id);
      }
      perMode[mode].ndcgs.push(ndcg(lastIds, gold, K_FOR_METRICS));
      perMode[mode].recalls.push(recallAtK(lastIds, gold, K_FOR_RECALL));
      perMode[mode].mrrs.push(mrr(lastIds, gold));
      perMode[mode].latencies.push(median(runs));
    }
    console.log(`  ✓ "${q}"`);
  }

  const aggregate: Record<string, ModeAgg> = {};
  for (const mode of ALL_MODES) {
    const m = perMode[mode];
    aggregate[modeKey(mode)] = {
      ndcg10: round3(mean(m.ndcgs)),
      recall5: round3(mean(m.recalls)),
      mrr: round3(mean(m.mrrs)),
      p50LatencyMs: Math.round(percentile(m.latencies, 50)),
      p95LatencyMs: Math.round(percentile(m.latencies, 95)),
    };
  }

  const row = {
    runId: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    embeddingModel: 'text-embedding-3-small',
    rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
    corpusSize,
    queryCount: queries.length,
    gradingProvenance,
    gradeCounts: graderCounts,
    perMode: aggregate,
  };

  // Append-only history.
  let history: unknown[] = [];
  if (existsSync(RESULTS_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
      if (Array.isArray(existing)) history = existing;
    } catch {
      // ignore corrupt file; we'll overwrite with a fresh array
    }
  }
  history.push(row);
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2));
  console.log(`\nWrote run to ${RESULTS_PATH}.`);
  console.log(JSON.stringify(row, null, 2));

  await db.end();
}

function modeKey(mode: RetrievalMode): string {
  return mode === 'fused-rerank' ? 'fusedRerank' : mode;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
