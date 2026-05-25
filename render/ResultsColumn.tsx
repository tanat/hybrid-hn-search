'use client';

import { CommentCard, type CommentResult } from './CommentCard';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';

type Props = {
  title: string;
  results: CommentResult[];
  latencyMs: number | null;
  loading?: boolean;
  error?: string | null;
};

export function ResultsColumn({ title, results, latencyMs, loading, error }: Props) {
  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        {latencyMs !== null && (
          <Badge variant="outline" className="text-xs font-mono">
            {Math.round(latencyMs)} ms
          </Badge>
        )}
      </div>
      <ScrollArea className="flex-1 pr-2 max-h-[70vh]">
        {error ? (
          <div className="text-sm text-destructive p-2">Error: {error}</div>
        ) : loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="text-sm text-muted-foreground p-2">No results.</div>
        ) : (
          <div>
            {results.map((r) => (
              <CommentCard key={r.id} result={r} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
