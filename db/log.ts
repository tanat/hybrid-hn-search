import 'server-only';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const LOG_PATH = process.env.QUERY_LOG_PATH ?? 'logs/queries.sqlite';

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const db = new Database(LOG_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      result_ids TEXT NOT NULL,
      result_scores TEXT NOT NULL,
      total_latency_ms INTEGER NOT NULL,
      embed_ms INTEGER,
      retrieve_ms INTEGER,
      fuse_ms INTEGER,
      rerank_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_searches_query ON searches(query);
    CREATE INDEX IF NOT EXISTS idx_searches_mode ON searches(mode);
  `);
  dbInstance = db;
  return db;
}

export type LogEntry = {
  query: string;
  mode: string;
  resultIds: number[];
  resultScores: number[];
  totalLatencyMs: number;
  embedMs?: number;
  retrieveMs?: number;
  fuseMs?: number;
  rerankMs?: number;
};

export function logSearch(entry: LogEntry) {
  // The SQLite query log is a local-dev artifact. Vercel's filesystem is
  // read-only (outside /tmp) and ephemeral, so skip logging in production —
  // search still returns normally, just without a persisted row.
  if (process.env.VERCEL) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO searches
     (ts, query, mode, result_ids, result_scores, total_latency_ms,
      embed_ms, retrieve_ms, fuse_ms, rerank_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.query,
    entry.mode,
    JSON.stringify(entry.resultIds),
    JSON.stringify(entry.resultScores),
    Math.round(entry.totalLatencyMs),
    entry.embedMs !== undefined ? Math.round(entry.embedMs) : null,
    entry.retrieveMs !== undefined ? Math.round(entry.retrieveMs) : null,
    entry.fuseMs !== undefined ? Math.round(entry.fuseMs) : null,
    entry.rerankMs !== undefined ? Math.round(entry.rerankMs) : null,
  );
}
