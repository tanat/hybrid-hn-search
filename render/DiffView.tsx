import { Badge } from '@/components/ui/badge';

export type GradedResult = {
  id: number;
  text: string;
  story_title: string;
  author: string;
  score: number;
  rank: number;
  grade: number | null;
};

const GRADE_STYLES: Record<string, string> = {
  '3': 'bg-green-200 text-green-900 dark:bg-green-800 dark:text-green-100',
  '2': 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100',
  '1': 'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100',
  '0': 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  '?': 'bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500 italic',
};

function GradePill({ grade }: { grade: number | null }) {
  const key = grade === null ? '?' : String(grade);
  return (
    <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs font-mono ${GRADE_STYLES[key]}`}>
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
      <h2 className="mb-4 text-base font-semibold">Query: &ldquo;{query}&rdquo;</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {modes.map((mode) => (
          <div key={mode} className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">{mode}</h3>
            <ol className="space-y-2">
              {perMode[mode].map((r) => (
                <li key={r.id} className="flex gap-2 rounded border p-2 text-xs">
                  <GradePill grade={r.grade} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 font-medium">{r.story_title}</div>
                    <div className="line-clamp-2 text-muted-foreground">
                      {r.text.replace(/\s+/g, ' ').slice(0, 220)}
                    </div>
                    <div className="mt-1 flex gap-1 text-[10px]">
                      <Badge variant="outline">#{r.rank}</Badge>
                      <Badge variant="outline">score {r.score.toFixed(3)}</Badge>
                      <Badge variant="outline">{r.author}</Badge>
                    </div>
                  </div>
                </li>
              ))}
              {perMode[mode].length === 0 && (
                <li className="text-xs text-muted-foreground">no results</li>
              )}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
