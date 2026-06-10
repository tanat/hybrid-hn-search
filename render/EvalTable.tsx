import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TrendingUp, TrendingDown, Gauge } from 'lucide-react';

export type ModeMetrics = {
  ndcg10: number;
  recall5: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type EvalRow = {
  runId: string;
  embeddingModel: string;
  rerankModel: string;
  corpusSize: number;
  queryCount: number;
  perMode: Record<string, ModeMetrics>;
};

const MODE_LABELS: Record<string, string> = {
  bm25: 'BM25',
  dense: 'Dense',
  fused: 'RRF fused',
  fusedRerank: 'Fused + rerank',
};

const METRIC_LABELS: Array<{
  key: keyof ModeMetrics;
  label: string;
  bigger: boolean;
  group: 'quality' | 'latency';
}> = [
  { key: 'ndcg10', label: 'nDCG@10', bigger: true, group: 'quality' },
  { key: 'recall5', label: 'Recall@5', bigger: true, group: 'quality' },
  { key: 'mrr', label: 'MRR', bigger: true, group: 'quality' },
  { key: 'p50LatencyMs', label: 'p50', bigger: false, group: 'latency' },
  { key: 'p95LatencyMs', label: 'p95', bigger: false, group: 'latency' },
];

function formatVal(metric: keyof ModeMetrics, v: number) {
  if (metric === 'p50LatencyMs' || metric === 'p95LatencyMs') return `${Math.round(v)} ms`;
  return v.toFixed(3);
}

export function EvalTable({ row }: { row: EvalRow }) {
  const modes = Object.keys(row.perMode);
  const bestByMetric: Record<string, number> = {};
  const worstByMetric: Record<string, number> = {};
  for (const m of METRIC_LABELS) {
    const values = modes.map((mode) => row.perMode[mode][m.key]);
    bestByMetric[m.key] = m.bigger ? Math.max(...values) : Math.min(...values);
    worstByMetric[m.key] = m.bigger ? Math.min(...values) : Math.max(...values);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-40">Mode</TableHead>
          {METRIC_LABELS.map((m) => (
            <TableHead
              key={m.key}
              className={`text-right ${m.group === 'latency' ? 'text-muted-foreground' : ''}`}
            >
              <span className="inline-flex items-center gap-1">
                {m.key === 'p50LatencyMs' && <Gauge className="size-3 opacity-70" />}
                {m.label}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {modes.map((mode) => {
          const m = row.perMode[mode];
          const isWinner = m.ndcg10 === bestByMetric['ndcg10'];
          return (
            <TableRow key={mode} className={isWinner ? 'bg-primary/[0.04]' : undefined}>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-2">
                  {isWinner && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
                  {MODE_LABELS[mode] ?? mode}
                </span>
              </TableCell>
              {METRIC_LABELS.map((metric) => {
                const v = m[metric.key];
                const isBest = v === bestByMetric[metric.key];
                const isWorst = v === worstByMetric[metric.key] && !isBest;
                const cls = isBest
                  ? 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300'
                  : isWorst
                    ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                    : 'text-foreground/80';
                return (
                  <TableCell key={metric.key} className="text-right">
                    <span
                      className={`inline-flex items-center justify-end gap-1 rounded-md px-2 py-0.5 font-mono text-xs tabular-nums ${cls}`}
                    >
                      {isBest && metric.group === 'quality' && (
                        <TrendingUp className="size-3" />
                      )}
                      {isWorst && metric.group === 'quality' && (
                        <TrendingDown className="size-3" />
                      )}
                      {formatVal(metric.key, v)}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function EvalRunMeta({ row }: { row: EvalRow }) {
  const items: Array<{ label: string; value: string }> = [
    { label: 'run', value: row.runId },
    { label: 'corpus', value: String(row.corpusSize) },
    { label: 'queries', value: String(row.queryCount) },
    { label: 'embed', value: row.embeddingModel },
    { label: 'rerank', value: row.rerankModel },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs"
        >
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-mono text-foreground/90">{it.value}</span>
        </span>
      ))}
    </div>
  );
}
