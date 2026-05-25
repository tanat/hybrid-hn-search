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

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Hybrid HN Search</h1>
        <Link href="/eval" className="text-sm underline text-muted-foreground hover:text-foreground">
          eval results →
        </Link>
      </div>

      <form onSubmit={onSubmit} className="flex gap-2 mb-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='try "rust async runtime" or "why startups fail at scale"'
          className="flex-1"
        />
        <Button type="submit">Search</Button>
      </form>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'compare' | 'single')} className="mb-6">
        <TabsList>
          <TabsTrigger value="compare">Compare 3-way</TabsTrigger>
          <TabsTrigger value="single">Single mode</TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="mt-3">
          <RadioGroup value={singleMode} onValueChange={setSingleMode} className="flex gap-4">
            {MODES.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <RadioGroupItem id={`mode-${m.id}`} value={m.id} />
                <Label htmlFor={`mode-${m.id}`} className="text-sm cursor-pointer">
                  {m.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </TabsContent>

        <TabsContent value="compare" className="mt-3 text-xs text-muted-foreground">
          Runs BM25, Dense, and Fused+Rerank in parallel.
        </TabsContent>
      </Tabs>

      {!submitted ? (
        <div className="text-sm text-muted-foreground">Enter a query to begin.</div>
      ) : tab === 'compare' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ResultsColumn title="BM25" {...bm25} />
          <ResultsColumn title="Dense" {...dense} />
          <ResultsColumn title="Fused+Rerank" {...fusedRerank} />
        </div>
      ) : (
        <div className="max-w-2xl mx-auto">
          <ResultsColumn title={singleMode} {...single} />
        </div>
      )}
    </main>
  );
}
