'use client';

import { CommentCard, type CommentResult } from './CommentCard';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, SearchX } from 'lucide-react';

type Accent = 'sparse' | 'dense' | 'fused';

type Props = {
  title: string;
  subtitle?: string;
  accent?: Accent;
  results: CommentResult[];
  latencyMs: number | null;
  loading?: boolean;
  error?: string | null;
};

const ACCENT_BAR: Record<Accent, string> = {
  sparse: 'bg-chart-3',
  dense: 'bg-chart-2',
  fused: 'bg-primary',
};

const ACCENT_DOT: Record<Accent, string> = {
  sparse: 'bg-chart-3',
  dense: 'bg-chart-2',
  fused: 'bg-primary',
};

export function ResultsColumn({
  title,
  subtitle,
  accent = 'fused',
  results,
  latencyMs,
  loading,
  error,
}: Props) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card/40">
      <header className="relative border-b border-border bg-card px-3.5 py-3">
        <span className={`absolute inset-x-0 top-0 h-0.5 ${ACCENT_BAR[accent]}`} aria-hidden />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${ACCENT_DOT[accent]}`} aria-hidden />
              <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            </div>
            {subtitle && (
              <p className="mt-0.5 pl-4 text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {latencyMs !== null && (
              <Badge variant="outline" className="font-mono text-xs tabular-nums">
                {Math.round(latencyMs)} ms
              </Badge>
            )}
            {!loading && !error && results.length > 0 && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {results.length} results
              </span>
            )}
          </div>
        </div>
      </header>

      <ScrollArea className="scrollbar-thin max-h-[70vh] flex-1">
        <div className="p-3">
          {error ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-8 text-center">
              <AlertCircle className="size-5 text-destructive" />
              <p className="text-sm font-medium text-destructive">Request failed</p>
              <p className="max-w-full break-words text-xs text-muted-foreground">{error}</p>
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-2 rounded-xl border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-5 w-12 rounded-full" />
                  </div>
                  <Skeleton className="h-3 w-2/5" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted-foreground">
              <SearchX className="size-5 opacity-60" />
              <p className="text-sm">No results.</p>
            </div>
          ) : (
            <ol className="space-y-2.5">
              {results.map((r, i) => (
                <CommentCard key={r.id} result={r} position={i + 1} />
              ))}
            </ol>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
