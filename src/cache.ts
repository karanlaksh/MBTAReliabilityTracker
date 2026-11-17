// Response cache for the public read-only API. See migration 0013 for why it
// lives in D1 rather than the Workers Cache API.
//
// THE PROPERTY THIS BUYS: D1 reads for /api/* are bounded by time, not by
// traffic. A key costs its full query price at most once per TTL (or once per
// rollup, whichever comes first); every other request for it is one row read.
// 230 page views and 23,000 cost the same.
//
// It fails open. If the cache read or write throws — table not migrated yet, a
// transient D1 error — the request is served uncached, exactly as before. A
// cache that can take the API down is worse than no cache.

import { CACHE_CONTROL } from './api';

/**
 * Rollup-backed endpoints change only when a rollup runs, and every rollup run
 * calls invalidateApiCache(). This TTL is the backstop for the case it cannot
 * cover: a scheduled rollup skipped on the read-budget gate, where the data is
 * unchanged but error-by-slice's gate estimate is computed from today's service
 * date and would otherwise go stale indefinitely.
 */
export const ROLLUP_BACKED_TTL_SEC = 86_400;

/**
 * /api/summary also reads tables that change between rollups: arrival_counts
 * (every 15-minute matcher pass) and collector_runs (every minute). One hour,
 * not the page's 30 minutes, because it is the most expensive endpoint per call
 * — its alert lookup alone read 25,656 rows on 2026-11-16 — and at most 24
 * misses a day caps it at ~24 x its per-call price however many people visit.
 */
export const SUMMARY_TTL_SEC = 3_600;

/**
 * Responses above this are served but not stored. D1 caps a row at 2,000,000
 * bytes; this leaves margin. None of today's responses are near it.
 */
const MAX_BODY_BYTES = 1_500_000;

/**
 * The only query params any handler reads (readFilters and errorBySlice in
 * api.ts). Everything else is dropped from the key, so `?x=<random>` cannot
 * force a miss and cannot mint new rows. A param added to a handler must be
 * added here too, or two different responses would share one key.
 */
const KEY_PARAMS = [
  'from', 'to', 'mode', 'route', 'include_added', 'include_partial',
  'min_n', 'stop', 'dir', 'bucket',
] as const;

/** Path plus allowlisted params in a fixed order: one key per distinct answer. */
export function cacheKey(url: URL): string {
  const parts: string[] = [];
  for (const p of KEY_PARAMS) {
    const v = url.searchParams.get(p);
    if (v !== null) parts.push(`${p}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `${url.pathname}?${parts.join('&')}` : url.pathname;
}

/**
 * Serve from cache, or run `compute` and store its body.
 *
 * Every response carries `x-cache: HIT|MISS` and `x-generated-at` (epoch
 * seconds the handler ran). The frontend's data-age line reads x-generated-at:
 * the HTTP Date header is when this response was SENT, which on a hit is not
 * when the data was produced, and the page must not claim fresher data than it
 * has.
 */
export async function cached(
  db: D1Database,
  url: URL,
  ttlSec: number,
  now: number,
  compute: () => Promise<Response>,
): Promise<Response> {
  const key = cacheKey(url);

  try {
    const hit = await db
      .prepare('SELECT body, generated_at FROM api_cache WHERE key = ? AND expires_at > ?')
      .bind(key, now)
      .first<{ body: string; generated_at: number }>();
    if (hit) return withCacheHeaders(new Response(hit.body, { headers: JSON_HEADERS }), 'HIT', hit.generated_at);
  } catch (err) {
    console.error('api cache read failed; serving uncached', String(err));
  }

  const res = await compute();
  if (res.status !== 200) return res;
  const body = await res.text();

  if (body.length <= MAX_BODY_BYTES) {
    try {
      await db
        .prepare(
          `INSERT INTO api_cache (key, body, generated_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET body = excluded.body,
             generated_at = excluded.generated_at, expires_at = excluded.expires_at`,
        )
        .bind(key, body, now, now + ttlSec)
        .run();
    } catch (err) {
      console.error('api cache write failed', String(err));
    }
  } else {
    console.error('api cache: body too large to store', { key, bytes: body.length });
  }
  return withCacheHeaders(new Response(body, { status: 200, headers: res.headers }), 'MISS', now);
}

/**
 * Drop every cached response. Called after each rollup run, scheduled or
 * manual, success or failure: a failed run may still have committed some
 * dates, and serving the database as it now is beats serving a cached version
 * of what it was.
 */
export async function invalidateApiCache(db: D1Database): Promise<void> {
  try {
    await db.prepare('DELETE FROM api_cache').run();
  } catch (err) {
    console.error('api cache invalidation failed', String(err));
  }
}

/** Same headers jsonResponse() sets for a cacheable response in api.ts. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': CACHE_CONTROL,
};

function withCacheHeaders(res: Response, status: 'HIT' | 'MISS', generatedAt: number): Response {
  const headers = new Headers(res.headers);
  headers.set('x-cache', status);
  headers.set('x-generated-at', String(generatedAt));
  // Readable cross-origin by the heatmap's browser fetch.
  headers.set('access-control-expose-headers', 'x-cache, x-generated-at');
  return new Response(res.body, { status: res.status, headers });
}
