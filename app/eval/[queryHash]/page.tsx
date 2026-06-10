import { readFileSync, existsSync } from 'node:fs';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DiffView, type GradedResult } from '@/render/DiffView';
import { queryHash } from '@/evals/queryHash';
import { runRetrieval, ALL_MODES } from '@/retrieve/modes';
import type { Grade } from '@/evals/grades-store';
import { buttonVariants } from '@/components/ui/button';
import { ArrowLeft, Search } from 'lucide-react';

const GRADE_LEGEND: Array<{ key: string; label: string; cls: string }> = [
  { key: '3', label: 'highly relevant', cls: 'bg-green-200 text-green-900 dark:bg-green-500/25 dark:text-green-200' },
  { key: '2', label: 'partially', cls: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300' },
  { key: '1', label: 'tangential', cls: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300' },
  { key: '0', label: 'irrelevant', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300' },
  { key: '?', label: 'not yet graded', cls: 'ring-1 ring-inset ring-border text-zinc-400 dark:text-zinc-500' },
];

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
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <Link
            href="/eval"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Eval dashboard</span>
          </Link>
          <Link
            href="/"
            className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'gap-1.5' })}
          >
            <Search className="size-4" />
            <span className="hidden sm:inline">Search</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <DiffView perMode={perMode} query={query} />

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Grades</span>
          {GRADE_LEGEND.map((g) => (
            <span key={g.key} className="inline-flex items-center gap-1.5">
              <span
                className={`inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[11px] font-semibold ${g.cls}`}
              >
                {g.key}
              </span>
              {g.label}
            </span>
          ))}
        </div>
      </main>
    </div>
  );
}
