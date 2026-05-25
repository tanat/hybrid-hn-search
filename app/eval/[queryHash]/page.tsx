import { readFileSync, existsSync } from 'node:fs';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DiffView, type GradedResult } from '@/render/DiffView';
import { queryHash } from '@/evals/queryHash';
import { runRetrieval, ALL_MODES } from '@/retrieve/modes';
import type { Grade } from '@/evals/grades-store';

export const dynamic = 'force-dynamic';

const QUERIES_PATH = 'fixtures/queries.json';
const GRADES_PATH = 'fixtures/candidate-grades.json';

function loadQueries(): string[] {
  if (!existsSync(QUERIES_PATH)) return [];
  try {
    const arr = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8'));
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

function loadGoldGradesFor(query: string): Map<number, number> {
  if (!existsSync(GRADES_PATH)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(GRADES_PATH, 'utf-8')) as Grade[];
    const m = new Map<number, number>();
    for (const g of arr) {
      if (g.query === query) m.set(g.comment_id, g.grade);
    }
    return m;
  } catch {
    return new Map();
  }
}

export default async function PerQueryEval({
  params,
}: {
  params: Promise<{ queryHash: string }>;
}) {
  const { queryHash: hash } = await params;
  const queries = loadQueries();
  const query = queries.find((q) => queryHash(q) === hash);
  if (!query) notFound();

  const gold = loadGoldGradesFor(query);

  const perMode: Record<string, GradedResult[]> = {};
  for (const mode of ALL_MODES) {
    try {
      const run = await runRetrieval(mode, query, 10);
      perMode[mode] = run.results.map((r) => ({
        id: r.id,
        text: r.text,
        story_title: r.story_title,
        author: r.author,
        score: r.score,
        rank: r.rank,
        grade: gold.has(r.id) ? gold.get(r.id)! : null,
      }));
    } catch (err) {
      console.warn(`mode ${mode} failed:`, err);
      perMode[mode] = [];
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/eval"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          ← back to eval dashboard
        </Link>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          search →
        </Link>
      </div>
      <DiffView perMode={perMode} query={query} />
      <p className="mt-6 text-xs text-muted-foreground">
        Grades:{' '}
        <span className="rounded bg-green-200 px-1.5 dark:bg-green-800">3</span> highly relevant,{' '}
        <span className="rounded bg-green-100 px-1.5 dark:bg-green-900/40">2</span> partially,{' '}
        <span className="rounded bg-yellow-100 px-1.5 dark:bg-yellow-900/40">1</span> tangential,{' '}
        <span className="rounded bg-zinc-100 px-1.5 dark:bg-zinc-800">0</span> irrelevant,{' '}
        <span className="rounded bg-zinc-50 px-1.5 italic dark:bg-zinc-900">?</span> not yet graded.
      </p>
    </main>
  );
}
