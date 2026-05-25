import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runRetrieval, ALL_MODES } from '@/retrieve/modes';
import { logSearch } from '@/db/log';

export const runtime = 'nodejs';
// Don't pre-render; this route does live retrieval against Postgres.
export const dynamic = 'force-dynamic';

const Body = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(ALL_MODES as [string, ...string[]]),
  k: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid request body', detail: (err as Error).message },
      { status: 400 },
    );
  }
  const { query, mode, k = 10 } = parsed;

  try {
    const run = await runRetrieval(mode as never, query, k);

    try {
      logSearch({
        query,
        mode,
        resultIds: run.results.map((r) => r.id),
        resultScores: run.results.map((r) => r.score),
        totalLatencyMs: run.latency.totalMs,
        embedMs: run.latency.embedMs,
        retrieveMs: run.latency.retrieveMs,
        fuseMs: run.latency.fuseMs,
        rerankMs: run.latency.rerankMs,
      });
    } catch (logErr) {
      // Logging is best-effort; don't fail the request.
      console.warn('logSearch failed:', logErr);
    }

    return NextResponse.json({
      query,
      mode,
      results: run.results,
      latency: run.latency,
    });
  } catch (err) {
    console.error('search route error:', err);
    return NextResponse.json(
      { error: 'retrieval failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
