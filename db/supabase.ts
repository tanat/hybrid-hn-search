import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // fallback to .env
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set. See .env.local.example');
}

// Read-only retrieval client. Search goes through the public RPCs
// (match_comments / search_comments) and the RLS read policy on `comments`, so
// the anon key is all we need — no service-role secret on the query path.
// Ingestion is separate: it uses the direct Postgres connection in db/client.ts.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
