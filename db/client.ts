import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // fallback to .env
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. See .env.local.example');
}

export const db = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export type Db = typeof db;
