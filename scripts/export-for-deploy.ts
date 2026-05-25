import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';

// Dumps the current Postgres database (running in docker) into two SQL
// files suitable for import into Neon:
//   deploy/schema.sql — DDL only
//   deploy/data.sql   — INSERT statements only
// `vector` extension must already exist on the target Neon database;
// migrate-to-neon.sh / your manual import is responsible for that.

const CONTAINER = process.env.PG_DOCKER_CONTAINER ?? 'hnsearch-postgres';
const DB = process.env.PGDATABASE_FOR_DUMP ?? 'hnsearch';
const USER = process.env.PGUSER_FOR_DUMP ?? 'hnsearch';
const OUT_DIR = 'deploy';

function run(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

function ensureContainer() {
  try {
    const id = execSync(`docker ps -q -f name=${CONTAINER}`).toString().trim();
    if (!id) {
      throw new Error(`docker container "${CONTAINER}" is not running`);
    }
  } catch (err) {
    console.error(
      `Cannot find container ${CONTAINER}. Set PG_DOCKER_CONTAINER or start docker compose.`,
    );
    throw err;
  }
}

function main() {
  ensureContainer();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Dumping schema → ${OUT_DIR}/schema.sql`);
  run(
    `docker exec ${CONTAINER} pg_dump --schema-only --no-owner --no-privileges -U ${USER} ${DB} > ${OUT_DIR}/schema.sql`,
  );

  console.log(`Dumping data → ${OUT_DIR}/data.sql`);
  run(
    `docker exec ${CONTAINER} pg_dump --data-only --no-owner --inserts --rows-per-insert=200 -U ${USER} ${DB} > ${OUT_DIR}/data.sql`,
  );

  for (const file of ['schema.sql', 'data.sql']) {
    const path = `${OUT_DIR}/${file}`;
    const sizeMb = (statSync(path).size / 1024 / 1024).toFixed(2);
    console.log(`  ${path} (${sizeMb} MB)`);
  }

  console.log(`
Done. To import into Neon:
  1. Create a Neon project, copy the connection string into NEON_DATABASE_URL.
  2. CREATE EXTENSION IF NOT EXISTS vector;       (in Neon SQL editor)
  3. psql "$NEON_DATABASE_URL" -f ${OUT_DIR}/schema.sql
  4. psql "$NEON_DATABASE_URL" -f ${OUT_DIR}/data.sql
  5. Sanity check: SELECT COUNT(*) FROM comments;  -- should match local`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
