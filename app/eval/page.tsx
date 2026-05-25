import { readFileSync, existsSync } from 'node:fs';
import Link from 'next/link';
import { EvalTable, EvalRunMeta, type EvalRow } from '@/render/EvalTable';
import { queryHash } from '@/evals/queryHash';

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
    <main className="mx-auto min-h-screen max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Eval Results</h1>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          ← back to search
        </Link>
      </div>

      {!latest ? (
        <div className="rounded border border-dashed p-6 text-sm text-muted-foreground">
          No eval results yet. Run <code className="font-mono">pnpm eval</code> after grading
          to populate <code className="font-mono">evals/results.json</code>.
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Latest run
            </h2>
            <EvalRunMeta row={latest} />
            <div className="mt-3 overflow-x-auto rounded border">
              <EvalTable row={latest} />
            </div>
          </section>

          {queries.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Per-query breakdown
              </h2>
              <ul className="space-y-1">
                {queries.map((q) => (
                  <li key={q}>
                    <Link
                      href={`/eval/${queryHash(q)}`}
                      className="text-sm underline hover:text-foreground"
                    >
                      &ldquo;{q}&rdquo;
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Click a query to see the top-10 from each mode side-by-side, color-coded by
                ground-truth grade.
              </p>
            </section>
          )}

          {runs.length > 1 && (
            <section className="mt-10">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Run history ({runs.length})
              </h2>
              <ul className="space-y-2 text-xs text-muted-foreground">
                {[...runs].reverse().map((r) => (
                  <li key={r.runId} className="font-mono">
                    {r.runId} · embed={r.embeddingModel} · queries={r.queryCount}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
