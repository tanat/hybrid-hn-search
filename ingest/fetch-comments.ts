import 'dotenv/config';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TARGET_COMMENTS = 5000;
const TWELVE_MONTHS_SECONDS = 60 * 60 * 24 * 365;
const NOW_EPOCH = Math.floor(Date.now() / 1000);
const SINCE_EPOCH = NOW_EPOCH - TWELVE_MONTHS_SECONDS;
const MIN_TEXT_LEN = 100;
// HN Algolia returns points: null for individual comments — only stories carry
// points. Cannot rank-by-points within a story; instead take the first N
// non-deleted comments at top-level (best proxy for "interesting" since HN
// orders root threads by votes server-side).
const TOP_PER_STORY = 5;
const RATE_LIMIT_RPS = 10;
const SEARCH_HITS_PER_PAGE = 50;
const FIXTURE_PATH = 'fixtures/comments.json';
const STORY_LIST_CACHE = 'fixtures/.stories-cache.json';

type StoryHit = {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  created_at_i: number;
};

type ItemNode = {
  id: number;
  type: string;
  author: string | null;
  text: string | null;
  points: number | null;
  created_at_i: number;
  parent_id: number | null;
  story_id?: number | null;
  children?: ItemNode[];
  deleted?: boolean;
  dead?: boolean;
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  private last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait() {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.last);
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }
}
const limiter = new RateLimiter(1000 / RATE_LIMIT_RPS);

async function fetchJson<T>(url: string, attempt = 0): Promise<T> {
  await limiter.wait();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'hybrid-hn-search/0.1 (educational eval project)' },
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (err) {
    if (attempt < 4) {
      const backoff = 500 * 2 ** attempt;
      console.warn(`  ! fetch ${url} failed (${(err as Error).message}); retry in ${backoff}ms`);
      await sleep(backoff);
      return fetchJson<T>(url, attempt + 1);
    }
    throw err;
  }
}

function flattenStripText(text: string): string {
  // HN comments are HTML-flavored. Strip simple tags + decode common entities.
  let s = text
    .replace(/<\s*p\s*\/?\s*>/gi, '\n\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');
  return s.trim();
}

function flattenComments(node: ItemNode, story: StoryHit, acc: FlatComment[]) {
  if (node.type === 'comment') {
    visitComment(node, story, acc);
  }
  if (node.children) {
    for (const child of node.children) flattenComments(child, story, acc);
  }
}

function visitComment(node: ItemNode, story: StoryHit, acc: FlatComment[]) {
  if (node.type !== 'comment') return;
  if (node.deleted || node.dead) return;
  const author = node.author;
  if (!author) return;
  const rawText = node.text;
  if (!rawText) return;
  const text = flattenStripText(rawText);
  if (text.length < MIN_TEXT_LEN) return;
  acc.push({
    id: node.id,
    story_id: Number(story.objectID),
    story_title: story.title,
    story_url: story.url,
    author,
    text,
    points: node.points ?? 0,
    created_at: new Date(node.created_at_i * 1000).toISOString(),
    parent_id: node.parent_id,
  });
}

async function fetchStoryList(): Promise<StoryHit[]> {
  if (existsSync(STORY_LIST_CACHE)) {
    console.log(`Using cached story list at ${STORY_LIST_CACHE}`);
    return JSON.parse(readFileSync(STORY_LIST_CACHE, 'utf-8')) as StoryHit[];
  }
  console.log(`Fetching top stories from last 12 months (since epoch ${SINCE_EPOCH})...`);
  const stories: StoryHit[] = [];
  // HN Algolia caps `page` at 1000 hits via `hitsPerPage * page`; iterate.
  for (let page = 0; page < 20; page++) {
    const url =
      `https://hn.algolia.com/api/v1/search?` +
      `tags=story&numericFilters=created_at_i>${SINCE_EPOCH}` +
      `&hitsPerPage=${SEARCH_HITS_PER_PAGE}&page=${page}` +
      `&attributesToRetrieve=objectID,title,url,points,num_comments,created_at_i`;
    const json = await fetchJson<{ hits: StoryHit[]; nbPages: number }>(url);
    if (!json.hits?.length) break;
    stories.push(...json.hits);
    if (page + 1 >= json.nbPages) break;
  }
  // Sort by num_comments desc to maximize harvest per fetch.
  stories.sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0));
  mkdirSync(dirname(STORY_LIST_CACHE), { recursive: true });
  writeFileSync(STORY_LIST_CACHE, JSON.stringify(stories, null, 2));
  console.log(`  fetched ${stories.length} stories, cached to ${STORY_LIST_CACHE}`);
  return stories;
}

function dedupeAppend(existing: FlatComment[], next: FlatComment[]): FlatComment[] {
  const seen = new Set<number>(existing.map((c) => c.id));
  for (const c of next) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      existing.push(c);
    }
  }
  return existing;
}

async function main() {
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });

  // Resume from existing fixture if present.
  let collected: FlatComment[] = existsSync(FIXTURE_PATH)
    ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as FlatComment[])
    : [];
  if (collected.length >= TARGET_COMMENTS) {
    console.log(`Already have ${collected.length} comments at ${FIXTURE_PATH}, nothing to do.`);
    return;
  }
  if (collected.length > 0) {
    console.log(`Resuming with ${collected.length} comments already in fixture.`);
  }

  const seenStoryIds = new Set<number>(collected.map((c) => c.story_id));
  const stories = await fetchStoryList();
  console.log(`Total stories to walk (low-priority skipped if cached): ${stories.length}`);

  let processed = 0;
  for (const story of stories) {
    processed++;
    if (collected.length >= TARGET_COMMENTS) break;
    const sid = Number(story.objectID);
    if (seenStoryIds.has(sid)) continue;
    if ((story.num_comments ?? 0) < 3) continue;
    try {
      const root = await fetchJson<ItemNode>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
      const flat: FlatComment[] = [];
      flattenComments(root, story, flat);
      // Pre-order DFS puts root-level threads first; take the leading N as a
      // crude proxy for "most prominent" since per-comment points aren't
      // exposed by the Algolia API.
      const top = flat.slice(0, TOP_PER_STORY);
      dedupeAppend(collected, top);
      seenStoryIds.add(sid);
    } catch (err) {
      console.warn(`  ! story ${story.objectID} failed permanently: ${(err as Error).message}`);
      continue;
    }

    if (processed % 10 === 0) {
      console.log(`[${processed} / ${stories.length}] stories processed, ${collected.length} comments collected`);
      // Periodically persist so a crash doesn't lose progress.
      writeFileSync(FIXTURE_PATH, JSON.stringify(collected));
    }
  }

  // Final write (pretty-printed for diff readability if small enough).
  const json = JSON.stringify(collected);
  writeFileSync(FIXTURE_PATH, json);
  const sizeMb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`\nDone. Wrote ${collected.length} comments to ${FIXTURE_PATH} (${sizeMb} MB).`);
  if (collected.length < TARGET_COMMENTS) {
    console.log(`  Note: target was ${TARGET_COMMENTS}; got ${collected.length}. Re-run to fetch more pages.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
