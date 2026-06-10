export type GradedResult = {
  id: number;
  text: string;
  story_title: string;
  author: string;
  score: number;
  rank: number;
  grade: number | null;
};

const MODE_LABELS: Record<string, string> = {
  bm25: 'BM25',
  dense: 'Dense',
  fused: 'RRF fused',
  fusedRerank: 'Fused + rerank',
};

const GRADE_STYLES: Record<string, string> = {
  '3': 'bg-green-200 text-green-900 dark:bg-green-500/25 dark:text-green-200',
  '2': 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  '1': 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  '0': 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300',
  '?': 'bg-transparent text-zinc-400 ring-1 ring-inset ring-border dark:text-zinc-500',
};

function GradePill({ grade }: { grade: number | null }) {
  const key = grade === null ? '?' : String(grade);
  return (
    <span
      className={`inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular-nums ${GRADE_STYLES[key]}`}
      title={grade === null ? 'not yet graded' : `relevance grade ${key}`}
    >
      {key}
    </span>
  );
}

export function DiffView({
  perMode,
  query,
}: {
  perMode: Record<string, GradedResult[]>;
  query: string;
}) {
  const modes = Object.keys(perMode);
  return (
    <div>
      <div className="mb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Query</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">
          &ldquo;{query}&rdquo;
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {modes.map((mode) => (
          <div
            key={mode}
            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card/40"
          >
            <h3 className="border-b border-border bg-card px-3 py-2 text-sm font-semibold tracking-tight">
              {MODE_LABELS[mode] ?? mode}
            </h3>
            <ol className="space-y-2 p-2.5">
              {perMode[mode].map((r, i) => (
                <li
                  key={r.id}
                  className="flex gap-2 rounded-lg border border-border bg-card p-2 text-xs"
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <GradePill grade={r.grade} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 font-medium">{r.story_title}</div>
                    <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                      {r.text.replace(/\s+/g, ' ').slice(0, 220)}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="font-mono tabular-nums text-foreground/70">
                        {r.score.toFixed(3)}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{r.author}</span>
                    </div>
                  </div>
                </li>
              ))}
              {perMode[mode].length === 0 && (
                <li className="px-1 py-4 text-center text-xs text-muted-foreground">
                  no results
                </li>
              )}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
