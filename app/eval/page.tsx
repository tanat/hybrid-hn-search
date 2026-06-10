import { readFileSync, existsSync } from 'node:fs';
import Link from 'next/link';
import { EvalTable, EvalRunMeta, type EvalRow } from '@/render/EvalTable';
import { queryHash } from '@/evals/queryHash';
import { buttonVariants } from '@/components/ui/button';
import { ArrowLeft, BarChart3, ChevronRight, ClipboardList } from 'lucide-react';

export const dynamic = 'force-dynamic';

const RESULTS_PATH = 'evals/results.json';
const QUERIES_PATH = 'fixtures/queries.json';

function loadResults(): EvalRow[] {
  if (!existsSync(RESULTS_PATH)) return [];
  try {
    const arr = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
    return Array.isArray(arr) ? (arr as EvalRow[]) : [];
  } catch {
    return [];
  }
}

function loadQueries(): string[] {
  if (!existsSync(QUERIES_PATH)) return [];
  try {
    const arr = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8'));
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

export default function EvalDashboard() {
  const runs = loadResults();
  const queries = loadQueries();
  const latest = runs.at(-1);

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <BarChart3 className="size-4.5" strokeWidth={2.5} />
            </span>
            <div className="leading-tight">
              <h1 className="text-base font-semibold tracking-tight">Eval Results</h1>
              <p className="hidden text-xs text-muted-foreground sm:block">
                Offline retrieval quality &amp; latency benchmark
              </p>
            </div>
          </div>
          <Link
            href="/"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Back to search</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {!latest ? (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
            <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ClipboardList className="size-5" />
            </span>
            <h2 className="text-sm font-semibold">No eval results yet</h2>
            <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
              Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pnpm eval</code>{' '}
              after grading to populate{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                evals/results.json
              </code>
              .
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Latest run
                </h2>
              </div>
              <EvalRunMeta row={latest} />
              <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
                <EvalTable row={latest} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded bg-green-200 dark:bg-green-500/30" /> best
                </span>{' '}
                <span className="ml-2 inline-flex items-center gap-1">
                  <span className="size-2 rounded bg-red-200 dark:bg-red-500/30" /> worst
                </span>{' '}
                <span className="ml-2">per metric across modes.</span>
              </p>
            </section>

            {queries.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Per-query breakdown
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {queries.map((q) => (
                    <li key={q}>
                      <Link
                        href={`/eval/${queryHash(q)}`}
                        className="group flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/60"
                      >
                        <span className="truncate text-foreground/90">&ldquo;{q}&rdquo;</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  Open a query to see the top-10 from each mode side-by-side, color-coded by
                  ground-truth grade.
                </p>
              </section>
            )}

            {runs.length > 1 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Run history ({runs.length})
                </h2>
                <ul className="space-y-1.5">
                  {[...runs].reverse().map((r) => (
                    <li
                      key={r.runId}
                      className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground"
                    >
                      <span className="text-foreground/80">{r.runId}</span> · embed=
                      {r.embeddingModel} · queries={r.queryCount}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
