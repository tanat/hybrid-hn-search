import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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

const METRIC_LABELS: Array<{ key: keyof ModeMetrics; label: string; bigger: boolean }> = [
  { key: 'ndcg10', label: 'nDCG@10', bigger: true },
  { key: 'recall5', label: 'Recall@5', bigger: true },
  { key: 'mrr', label: 'MRR', bigger: true },
  { key: 'p50LatencyMs', label: 'p50 latency (ms)', bigger: false },
  { key: 'p95LatencyMs', label: 'p95 latency (ms)', bigger: false },
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
        <TableRow>
          <TableHead className="w-40">Mode</TableHead>
          {METRIC_LABELS.map((m) => (
            <TableHead key={m.key}>{m.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {modes.map((mode) => {
          const m = row.perMode[mode];
          return (
            <TableRow key={mode}>
              <TableCell className="font-medium">
                {MODE_LABELS[mode] ?? mode}
              </TableCell>
              {METRIC_LABELS.map((metric) => {
                const v = m[metric.key];
                const isBest = v === bestByMetric[metric.key];
                const isWorst = v === worstByMetric[metric.key] && !isBest;
                return (
                  <TableCell key={metric.key}>
                    <span
                      className={
                        isBest
                          ? 'rounded bg-green-100 px-2 py-0.5 dark:bg-green-900/40'
                          : isWorst
                            ? 'rounded bg-red-100 px-2 py-0.5 dark:bg-red-900/40'
                            : ''
                      }
                    >
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
  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">runId: {row.runId}</Badge>
      <Badge variant="outline">corpus: {row.corpusSize}</Badge>
      <Badge variant="outline">queries: {row.queryCount}</Badge>
      <Badge variant="outline">embed: {row.embeddingModel}</Badge>
      <Badge variant="outline">rerank: {row.rerankModel}</Badge>
    </div>
  );
}
