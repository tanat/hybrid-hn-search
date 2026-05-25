import { denseRetrieve } from './dense';
import { sparseRetrieve } from './sparse';
import { rrfFuse } from './fuse';
import { rerank } from './rerank';
import type { RetrievalMode, RetrievalResult } from './types';

export type RetrievalLatency = {
  totalMs: number;
  embedMs?: number;
  retrieveMs?: number;
  fuseMs?: number;
  rerankMs?: number;
};

export type RetrievalRun = {
  mode: RetrievalMode;
  results: RetrievalResult[];
  latency: RetrievalLatency;
};

const FUSED_K_BEFORE_RERANK = 20;

export async function runRetrieval(
  mode: RetrievalMode,
  query: string,
  k = 10,
): Promise<RetrievalRun> {
  const startTotal = performance.now();

  if (mode === 'bm25') {
    const { results, timings } = await sparseRetrieve(query, k);
    return {
      mode,
      results: results.slice(0, k),
      latency: {
        totalMs: performance.now() - startTotal,
        retrieveMs: timings.retrieveMs,
      },
    };
  }

  if (mode === 'dense') {
    const { results, timings } = await denseRetrieve(query, k);
    return {
      mode,
      results: results.slice(0, k),
      latency: {
        totalMs: performance.now() - startTotal,
        embedMs: timings.embedMs,
        retrieveMs: timings.retrieveMs,
      },
    };
  }

  // Fused / fused-rerank both need the union pool.
  const poolSize = mode === 'fused-rerank' ? Math.max(50, FUSED_K_BEFORE_RERANK * 2) : 50;
  const [denseR, sparseR] = await Promise.all([
    denseRetrieve(query, poolSize),
    sparseRetrieve(query, poolSize),
  ]);

  const t0 = performance.now();
  const fused = rrfFuse(
    [
      denseR.results.map((r) => ({ id: r.id, rank: r.rank })),
      sparseR.results.map((r) => ({ id: r.id, rank: r.rank })),
    ],
    poolSize,
  );
  const fuseMs = performance.now() - t0;

  // Reattach payloads (prefer dense doc text since it covers all candidates;
  // fall back to sparse).
  const byId = new Map<number, RetrievalResult>();
  for (const r of denseR.results) byId.set(r.id, r);
  for (const r of sparseR.results) if (!byId.has(r.id)) byId.set(r.id, r);

  const fusedDocs: RetrievalResult[] = fused
    .map((f, i) => {
      const base = byId.get(f.id);
      if (!base) return null;
      return { ...base, score: f.rrfScore, rank: i + 1 };
    })
    .filter((x): x is RetrievalResult => x !== null);

  if (mode === 'fused') {
    return {
      mode,
      results: fusedDocs.slice(0, k),
      latency: {
        totalMs: performance.now() - startTotal,
        embedMs: denseR.timings.embedMs,
        retrieveMs: Math.max(denseR.timings.retrieveMs, sparseR.timings.retrieveMs),
        fuseMs,
      },
    };
  }

  // mode === 'fused-rerank'

  // On Vercel the @huggingface/transformers + onnxruntime-node bundle
  // typically blows the 50 MB function size limit. Fall back to fused.
  // The eval table (run locally) is the artifact that proves the rerank
  // lift; the deploy is supporting material.
  if (process.env.VERCEL && process.env.RERANK_IN_PROD !== '1') {
    return {
      mode,
      results: fusedDocs.slice(0, k),
      latency: {
        totalMs: performance.now() - startTotal,
        embedMs: denseR.timings.embedMs,
        retrieveMs: Math.max(denseR.timings.retrieveMs, sparseR.timings.retrieveMs),
        fuseMs,
      },
    };
  }

  const candidates = fusedDocs.slice(0, FUSED_K_BEFORE_RERANK);
  const t1 = performance.now();
  const reranked = await rerank(
    query,
    candidates.map((c) => ({ id: c.id, text: c.text })),
  );
  const rerankMs = performance.now() - t1;

  // Merge reranker score back onto the full result objects.
  const docById = new Map(candidates.map((c) => [c.id, c]));
  const finalResults: RetrievalResult[] = reranked
    .map((r, i) => {
      const doc = docById.get(r.id);
      if (!doc) return null;
      return { ...doc, score: r.rerankerScore, rank: i + 1 };
    })
    .filter((x): x is RetrievalResult => x !== null)
    .slice(0, k);

  return {
    mode,
    results: finalResults,
    latency: {
      totalMs: performance.now() - startTotal,
      embedMs: denseR.timings.embedMs,
      retrieveMs: Math.max(denseR.timings.retrieveMs, sparseR.timings.retrieveMs),
      fuseMs,
      rerankMs,
    },
  };
}

export const ALL_MODES: RetrievalMode[] = ['bm25', 'dense', 'fused', 'fused-rerank'];
