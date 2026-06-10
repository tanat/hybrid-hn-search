'use client';

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResultsColumn } from '@/render/ResultsColumn';
import type { CommentResult } from '@/render/CommentCard';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Search, BarChart3, ArrowRight, Layers, Sparkles } from 'lucide-react';

type ApiResponse = {
  query: string;
  mode: string;
  results: CommentResult[];
  latency: { totalMs: number; embedMs?: number; retrieveMs?: number; fuseMs?: number; rerankMs?: number };
};

type ModeState = {
  results: CommentResult[];
  latencyMs: number | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: ModeState = { results: [], latencyMs: null, loading: false, error: null };

const MODES = [
  { id: 'bm25', label: 'BM25' },
  { id: 'dense', label: 'Dense' },
  { id: 'fused', label: 'Fused' },
  { id: 'fused-rerank', label: 'Fused+Rerank' },
] as const;

const COMPARE_MODES: Array<typeof MODES[number]['id']> = ['bm25', 'dense', 'fused-rerank'];

async function searchOne(query: string, mode: string): Promise<ApiResponse> {
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [tab, setTab] = useState<'compare' | 'single'>('compare');
  const [singleMode, setSingleMode] = useState<string>('fused-rerank');

  const [bm25, setBm25] = useState<ModeState>(EMPTY);
  const [dense, setDense] = useState<ModeState>(EMPTY);
  const [fusedRerank, setFusedRerank] = useState<ModeState>(EMPTY);
  const [single, setSingle] = useState<ModeState>(EMPTY);

  useEffect(() => {
    if (!submitted) return;
    if (tab === 'compare') {
      setBm25({ ...EMPTY, loading: true });
      setDense({ ...EMPTY, loading: true });
      setFusedRerank({ ...EMPTY, loading: true });
      const setters: Record<string, (s: ModeState) => void> = {
        bm25: setBm25,
        dense: setDense,
        'fused-rerank': setFusedRerank,
      };
      for (const m of COMPARE_MODES) {
        searchOne(submitted, m)
          .then((r) =>
            setters[m]({ results: r.results, latencyMs: r.latency.totalMs, loading: false, error: null }),
          )
          .catch((err) =>
            setters[m]({ results: [], latencyMs: null, loading: false, error: err.message }),
          );
      }
    } else {
      setSingle({ ...EMPTY, loading: true });
      searchOne(submitted, singleMode)
        .then((r) =>
          setSingle({ results: r.results, latencyMs: r.latency.totalMs, loading: false, error: null }),
        )
        .catch((err) =>
          setSingle({ results: [], latencyMs: null, loading: false, error: err.message }),
        );
    }
  }, [submitted, tab, singleMode]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSubmitted(q);
  };

  const singleLabel = MODES.find((m) => m.id === singleMode)?.label ?? singleMode;

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Search className="size-4.5" strokeWidth={2.5} />
            </span>
            <div className="leading-tight">
              <h1 className="text-base font-semibold tracking-tight">Hybrid HN Search</h1>
              <p className="hidden text-xs text-muted-foreground sm:block">
                BM25 · dense · RRF fusion · cross-encoder rerank
              </p>
            </div>
          </div>
          <Link
            href="/eval"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}
          >
            <BarChart3 className="size-4" />
            <span className="hidden sm:inline">Eval results</span>
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <form onSubmit={onSubmit} className="relative mx-auto flex max-w-3xl items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='try "rust async runtime" or "why startups fail at scale"'
              aria-label="Search query"
              className="h-11 rounded-xl pl-10 pr-3 text-sm shadow-sm md:text-sm"
            />
          </div>
          <Button type="submit" size="lg" className="h-11 rounded-xl px-5 shadow-sm">
            Search
          </Button>
        </form>

        <div className="mx-auto mt-5 max-w-3xl">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'compare' | 'single')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="compare" className="gap-1.5">
                  <Layers className="size-3.5" />
                  Compare 3-way
                </TabsTrigger>
                <TabsTrigger value="single" className="gap-1.5">
                  <Sparkles className="size-3.5" />
                  Single mode
                </TabsTrigger>
              </TabsList>

              <TabsContent value="compare" className="mt-0 text-xs text-muted-foreground">
                Runs BM25, Dense &amp; Fused+Rerank in parallel.
              </TabsContent>
            </div>

            <TabsContent value="single" className="mt-3">
              <RadioGroup
                value={singleMode}
                onValueChange={setSingleMode}
                className="flex flex-wrap gap-2"
              >
                {MODES.map((m) => {
                  const active = singleMode === m.id;
                  return (
                    <Label
                      key={m.id}
                      htmlFor={`mode-${m.id}`}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        active
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      <RadioGroupItem id={`mode-${m.id}`} value={m.id} />
                      {m.label}
                    </Label>
                  );
                })}
              </RadioGroup>
            </TabsContent>
          </Tabs>
        </div>

        <div className="mt-8">
          {!submitted ? (
            <EmptyState />
          ) : tab === 'compare' ? (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <ResultsColumn title="BM25" subtitle="Lexical / sparse" accent="sparse" {...bm25} />
              <ResultsColumn title="Dense" subtitle="Semantic / vector" accent="dense" {...dense} />
              <ResultsColumn
                title="Fused + Rerank"
                subtitle="RRF + cross-encoder"
                accent="fused"
                {...fusedRerank}
              />
            </div>
          ) : (
            <div className="mx-auto max-w-2xl">
              <ResultsColumn title={singleLabel} subtitle="Single mode" accent="fused" {...single} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState() {
  const examples = ['rust async runtime', 'why startups fail at scale', 'postgres vs sqlite'];
  return (
    <div className="mx-auto flex max-w-md flex-col items-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Search className="size-5" />
      </span>
      <h2 className="text-sm font-semibold">Search Hacker News comments</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Enter a query to compare how lexical, semantic, and reranked retrieval each rank the same
        corpus.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {examples.map((e) => (
          <span
            key={e}
            className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
          >
            {e}
          </span>
        ))}
      </div>
    </div>
  );
}
