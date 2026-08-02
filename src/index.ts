import { runTick, type Env } from './collector';
import { runBackfill, runMatch } from './matcher';
import { buildStatus, DAILY_WRITE_LIMIT } from './status';

/** Must match the second entry in wrangler.toml [triggers] crons. */
const MATCHER_CRON = '*/15 * * * *';

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
          implausible: match.implausible,
          by_source: match.by_source,
        });
      }
      return;
    }

    const run = await runTick(env, event.scheduledTime);
    if (run.error) console.error('tick failed', run);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // /status is canonical; /health is kept as an alias so anything already
    // pointing at it keeps working.
    if (url.pathname === '/status' || url.pathname === '/health') {
      const status = await buildStatus(env, Math.floor(Date.now() / 1000));
      // 503 when we are stale or over budget, so uptime monitoring can watch the
      // status code alone and never need to parse the body.
      return json(status, status.collecting ? 200 : 503);
    }

    // Manual full backfill over all collected data, separate from the cron. Resets
    // the watermark to 0 and repeats until the scan stops advancing. Safe to run
    // at any time: every write is a confidence-guarded upsert.
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
