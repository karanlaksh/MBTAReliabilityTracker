import { runTick, type Env } from './collector';
import { runBackfill, runMatch } from './matcher';
import { ask } from './ask';
import { ROLLUP_FLOOR, runRollup, shouldRecompute } from './rollup';
import { fetchAccountUsage, type AccountUsage } from './usage';
import { errorByDay, errorByHorizon, errorBySlice, summary } from './api';
import { buildStatus, DAILY_WRITE_LIMIT } from './status';

/** Must match the second entry in wrangler.toml [triggers] crons. */
const MATCHER_CRON = '*/15 * * * *';

/**
 * The scheduled rollup runs only if the account has read at most this many rows
 * so far today. A normal run is ~0.6M (three by_day dates + one grid fold); on
 * the two August backfill nights the grid fold adds ~1M and stops itself at 2M
 * account-wide. At 04:00 local (08:00 UTC) a healthy day has read ~0.3M.
 */
const ROLLUP_MAX_READS_BEFORE = 1_500_000;

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Awaited, not fire-and-forget: runTick already swallows its own errors and
    // records them, and we want the invocation to stay alive until the write
    // lands. ctx is unused but part of the handler contract.
    void ctx;

    // Cloudflare delivers EACH cron expression as its own scheduled event, so at
    // :00/:15/:30/:45 this handler is invoked twice — once per expression. Branch
    // on which one fired; running the collector in both would double-collect every
    // fifteenth minute and trip the concurrency guard.
    if (event.cron === MATCHER_CRON) {
      const match = await runMatch(env, Date.now());
      if (match.error) console.error('matcher failed', match);
      else {
        console.log('matcher', {
          scanned: match.scanned_rows,
          settled: match.settled,
          upserts_attempted: match.upserts_attempted,
          count_rows_written: match.count_rows_written,
          implausible: match.implausible,
          by_source: match.by_source,
        });
      }
      // Rollups ride the matcher cron, gated on LOCAL hour so DST cannot drift
      // the schedule onto the 03:00 service-date rollover, and run after the
      // matcher so the day they summarise is as fully graded as it will get.
      //
      // BOUNDED, AND GATED ON THE READ BUDGET. The unbounded rollup read ~20-30M
      // rows (measured) against a 5M/day limit. This one recomputes three service
      // dates through rowid ranges and folds final dates into the accumulating
      // grid: ~0.6M reads on a normal day. It still runs only if Cloudflare's own account total
      // says there is room, and never on an unknown — a rollup that exhausts the
      // budget costs the rest of the day's collection, which is unrecoverable,
      // while a skipped rollup is recomputed tomorrow.
      const nowSec = Math.floor(Date.now() / 1000);
      if (shouldRecompute(nowSec, Math.floor(nowSec / 60) % 60)) {
        let usage: AccountUsage | null = null;
        try {
          usage = await fetchAccountUsage(env, nowSec);
        } catch (err) {
          console.error('rollup skipped: read usage unavailable', String(err));
        }
        if (usage && usage.rows_read_today <= ROLLUP_MAX_READS_BEFORE) {
          const roll = await runRollup(env, Date.now(), { readsBefore: usage.rows_read_today });
          if (roll.error) console.error('rollup failed', roll);
          else console.log('rollup', roll);
        } else if (usage) {
          console.error('rollup skipped: read budget', {
            rows_read_today: usage.rows_read_today,
            threshold: ROLLUP_MAX_READS_BEFORE,
          });
        }
      }
      return;
    }

    const run = await runTick(env, event.scheduledTime);
    if (run.error) console.error('tick failed', run);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Read-only API for the frontend, served entirely from the rollup tables.
    // Never from prediction_snapshots: no secondary index, 518k rows now and ~3M
    // by November.
    // DEMO ONLY — trip assistant (src/ask.ts). POST {question}, answered from the
    // seeded mbta-demo database. There is deliberately no /api/ask on the real
    // database: the panel only exists in DEMO_MODE, and an unused public endpoint
    // would spend the real read budget. Rate-limited per client anyway: every
    // question reads D1 — whose daily read budget is shared, account-wide, with
    // the live collector — and spends Gemini free-tier quota.
    if (url.pathname === '/demo/api/ask') {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      const db = env.DB_DEMO;
      if (!db) return json({ error: 'demo database not bound' }, 404);
      const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (env.ASK_LIMITER && !(await env.ASK_LIMITER.limit({ key: client })).success) {
        return new Response(JSON.stringify({ status: 'rate_limited', answer: 'Too many questions — wait a minute and try again.' }), {
          status: 429, headers: { 'content-type': 'application/json', ...cors },
        });
      }
      let question = '';
      try {
        question = String(((await request.json()) as { question?: unknown }).question ?? '');
      } catch {
        return json({ error: 'body must be JSON {question}' }, 400);
      }
      const result = await ask(env, db, question, Math.floor(Date.now() / 1000));
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
    }

    // DEMO ONLY. /demo/api/* serves the same handlers from the seeded mbta-demo
    // database: the handlers are unchanged, they are just handed DB_DEMO as DB.
    // The real /api/* paths below are untouched. Undo: remove this block and the
    // DB_DEMO binding (see README "Demo mode").
    if (url.pathname.startsWith('/demo/api/')) {
      if (!env.DB_DEMO) return json({ error: 'demo database not bound' }, 404);
      const demoEnv: Env = { ...env, DB: env.DB_DEMO };
      const path = url.pathname.slice('/demo'.length);
      if (path === '/api/error-by-horizon') return errorByHorizon(demoEnv, url);
      if (path === '/api/error-by-day') return errorByDay(demoEnv, url);
      if (path === '/api/error-by-slice') return errorBySlice(demoEnv, url);
      if (path === '/api/summary') return summary(demoEnv);
      return json({ error: 'not found' }, 404);
    }

    if (url.pathname === '/api/error-by-horizon') return errorByHorizon(env, url);
    if (url.pathname === '/api/error-by-day') return errorByDay(env, url);
    if (url.pathname === '/api/error-by-slice') return errorBySlice(env, url);
    if (url.pathname === '/api/summary') return summary(env);

    // /status is canonical; /health is kept as an alias so anything already
    // pointing at it keeps working.
    if (url.pathname === '/status' || url.pathname === '/health') {
      const status = await buildStatus(env, Math.floor(Date.now() / 1000));
      // 503 when we are stale or over budget, so uptime monitoring can watch the
      // status code alone and never need to parse the body.
      return json(status, status.collecting ? 200 : 503);
    }

    // Manual rollup recompute, bounded exactly like the scheduled one but NOT
    // gated on the read budget — check /status read_budget before calling it.
    //   ?date=YYYY-MM-DD  one service date of rollup_error_by_day, grid untouched.
    //                     Refused before ROLLUP_FLOOR: those dates are not
    //                     summarised, and their existing rows are left alone.
    //   ?fold=YYYY-MM-DD  fold that one date into the grid, if it is eligible
    //                     (final, not yet folded, and in the August backfill or
    //                     at/after ROLLUP_FLOOR); by_day untouched.
    //   (neither)         what the schedule runs: recent dates + pending folds
    // Every response carries rows_read, D1's own measurement of what it cost.
    if (url.pathname === '/rollup' && request.method === 'POST') {
      if (!env.COLLECT_TOKEN || url.searchParams.get('token') !== env.COLLECT_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const date = url.searchParams.get('date');
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: 'date must be YYYY-MM-DD' }, 400);
      }
      if (date !== null && date < ROLLUP_FLOOR) {
        return json({ error: `dates before ${ROLLUP_FLOOR} are not summarised` }, 400);
      }
      const fold = url.searchParams.get('fold');
      if (fold !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fold)) {
        return json({ error: 'fold must be YYYY-MM-DD' }, 400);
      }
      const opts =
        date !== null
          ? { byDayDates: [date], fold: false }
          : fold !== null
            ? { byDayDates: [], foldDates: [fold] }
            : {};
      return json(await runRollup(env, Date.now(), opts));
    }

    // Manual full backfill over all collected data, separate from the cron. Resets
    // the watermark to 0 and repeats until the scan stops advancing. Safe for the
    // DATA at any time: every write is a confidence-guarded upsert. NOT safe for
    // the read budget: every pass over a date before the partial index floor
    // (migration 0009) scans all of vehicle_observations, ~237k rows a pass.
    if (url.pathname === '/backfill' && request.method === 'POST') {
      if (!env.COLLECT_TOKEN || url.searchParams.get('token') !== env.COLLECT_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const passes = await runBackfill(env);
      return json({
        passes: passes.length,
        scanned: passes.reduce((n, p) => n + p.scanned_rows, 0),
        upserts_attempted: passes.reduce((n, p) => n + p.upserts_attempted, 0),
        implausible: passes.reduce((n, p) => n + p.implausible, 0),
        by_source: passes.reduce<Record<string, number>>((acc, p) => {
          for (const [k, v] of Object.entries(p.by_source)) acc[k] = (acc[k] ?? 0) + v;
          return acc;
        }, {}),
        turnaround_spans: passes.flatMap((p) => p.turnaround_spans),
        turnaround_unbracketed: passes.reduce((n, p) => n + p.turnaround_unbracketed, 0),
        final_watermark: passes.at(-1)?.watermark_after ?? 0,
        errors: passes.map((p) => p.error).filter(Boolean),
      });
    }

    // Single matcher pass, for verifying without waiting for the */15 cron.
    if (url.pathname === '/match' && request.method === 'POST') {
      if (!env.COLLECT_TOKEN || url.searchParams.get('token') !== env.COLLECT_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      return json(await runMatch(env, Date.now()));
    }

    // Manual trigger, for verifying a fresh deploy without waiting for the cron.
    // Disabled unless COLLECT_TOKEN is set, because it writes.
    if (url.pathname === '/collect' && request.method === 'POST') {
      if (!env.COLLECT_TOKEN || url.searchParams.get('token') !== env.COLLECT_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      return json(await runTick(env, Date.now()));
    }

    return json(
      {
        error: 'not found',
        routes: [
          'GET /status',
          'GET /health (alias)',
          'POST /collect?token=',
          'POST /match?token=',
          'POST /backfill?token=',
          'POST /rollup?token=',
          'GET /api/error-by-horizon',
          'GET /api/error-by-day',
          'GET /api/error-by-slice',
          'GET /api/summary',
        ],
        daily_write_limit: DAILY_WRITE_LIMIT,
      },
      404,
    );
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The status page will poll this from a browser on another origin.
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
