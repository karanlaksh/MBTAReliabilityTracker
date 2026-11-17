import { describe, expect, it } from 'vitest';
import { cached, cacheKey, invalidateApiCache } from '../src/cache';

const T0 = 1_794_876_000;

/**
 * D1 stand-in for api_cache: the SELECT honours expires_at, the upsert replaces,
 * DELETE empties. `broken` makes every call throw, as an unmigrated table would.
 */
function fakeDb(broken = false) {
  const rows = new Map<string, { body: string; generated_at: number; expires_at: number }>();
  const db = {
    prepare: (sql: string) => {
      if (broken) throw new Error('D1_ERROR: no such table: api_cache');
      const stmt = (args: unknown[]) => ({
        first: async () => {
          const r = rows.get(args[0] as string);
          return r && r.expires_at > (args[1] as number) ? r : null;
        },
        run: async () => {
          if (sql.startsWith('DELETE')) rows.clear();
          else rows.set(args[0] as string, { body: args[1] as string, generated_at: args[2] as number, expires_at: args[3] as number });
          return { meta: {} };
        },
      });
      return { bind: (...args: unknown[]) => stmt(args), ...stmt([]) };
    },
  } as unknown as D1Database;
  return { db, rows };
}

const u = (qs = '') => new URL(`https://w.dev/api/error-by-slice${qs}`);

function counter(body = '{"ok":true}', status = 200) {
  const c = { calls: 0, run: async () => { c.calls++; return new Response(body, { status }); } };
  return c;
}

describe('cacheKey', () => {
  it('ignores params no handler reads, so a cache-buster cannot force a miss', () => {
    expect(cacheKey(u('?stop=place-rugg&x=123'))).toBe(cacheKey(u('?stop=place-rugg&x=456')));
    expect(cacheKey(u('?stop=place-rugg&x=123'))).toBe('/api/error-by-slice?stop=place-rugg');
  });

  it('does not depend on param order', () => {
    expect(cacheKey(u('?dir=0&stop=a'))).toBe(cacheKey(u('?stop=a&dir=0')));
  });

  it('keeps distinct answers distinct', () => {
    expect(cacheKey(u('?dir=0'))).not.toBe(cacheKey(u('?dir=1')));
    expect(cacheKey(new URL('https://w.dev/demo/api/summary'))).not.toBe(
      cacheKey(new URL('https://w.dev/api/summary')),
    );
  });
});

describe('cached', () => {
  it('runs the handler once, then serves from the stored row', async () => {
    const { db } = fakeDb();
    const h = counter();
    const a = await cached(db, u(), 3600, T0, h.run);
    const b = await cached(db, u(), 3600, T0 + 60, h.run);
    expect(h.calls).toBe(1);
    expect(a.headers.get('x-cache')).toBe('MISS');
    expect(b.headers.get('x-cache')).toBe('HIT');
    expect(await b.text()).toBe('{"ok":true}');
  });

  it('reports when the data was produced, not when it was sent', async () => {
    const { db } = fakeDb();
    await cached(db, u(), 3600, T0, counter().run);
    const hit = await cached(db, u(), 3600, T0 + 1800, counter().run);
    expect(hit.headers.get('x-generated-at')).toBe(String(T0));
  });

  it('recomputes once the TTL has passed', async () => {
    const { db } = fakeDb();
    const h = counter();
    await cached(db, u(), 3600, T0, h.run);
    await cached(db, u(), 3600, T0 + 3600, h.run);
    expect(h.calls).toBe(2);
  });

  it('recomputes after invalidation, as every rollup run does', async () => {
    const { db } = fakeDb();
    const h = counter();
    await cached(db, u(), 86_400, T0, h.run);
    await invalidateApiCache(db);
    await cached(db, u(), 86_400, T0 + 60, h.run);
    expect(h.calls).toBe(2);
  });

  it('never stores an error response', async () => {
    const { db, rows } = fakeDb();
    const res = await cached(db, u(), 3600, T0, counter('{"error":"x"}', 500).run);
    expect(res.status).toBe(500);
    expect(rows.size).toBe(0);
  });

  it('fails open: a broken cache table still serves the handler', async () => {
    const { db } = fakeDb(true);
    const h = counter();
    const res = await cached(db, u(), 3600, T0, h.run);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    await expect(invalidateApiCache(db)).resolves.toBeUndefined();
  });
});
