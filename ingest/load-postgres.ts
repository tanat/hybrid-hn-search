import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { db } from '../db/client';

type FlatComment = {
  id: number;
  story_id: number;
  story_title: string;
  story_url: string | null;
  author: string;
  text: string;
  points: number;
  created_at: string;
  parent_id: number | null;
};

const FIXTURE_PATH = 'fixtures/comments.json';
const BATCH_SIZE = 500;

async function main() {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  const rawComments = JSON.parse(raw) as FlatComment[];
  // postgres.js refuses `undefined`; normalize optional fields to null.
  const comments: FlatComment[] = rawComments.map((c) => ({
    id: c.id,
    story_id: c.story_id,
    story_title: c.story_title,
    story_url: c.story_url ?? null,
    author: c.author,
    text: c.text,
    points: c.points ?? 0,
    created_at: c.created_at,
    parent_id: c.parent_id ?? null,
  }));
  console.log(`Loading ${comments.length} comments into Postgres...`);

  let loaded = 0;
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    // postgres.js expands arrays of objects via tagged template + db(values, columns).
    await db`
      INSERT INTO comments ${db(
        batch,
        'id',
        'story_id',
        'story_title',
        'story_url',
        'author',
        'text',
        'points',
        'created_at',
        'parent_id',
      )}
      ON CONFLICT (id) DO NOTHING
    `;
    loaded += batch.length;
    console.log(`[${loaded} / ${comments.length}] loaded`);
  }

  const [{ count }] = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM comments`;
  console.log(`\nDone. comments table has ${count} rows.`);

  const [{ nullc }] = await db<{ nullc: number }[]>`
    SELECT COUNT(*)::int AS nullc FROM comments WHERE text_search IS NULL
  `;
  if (nullc > 0) {
    console.warn(`  ! ${nullc} rows have NULL text_search — trigger may not have fired`);
  } else {
    console.log(`  All rows have text_search populated.`);
  }

  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
