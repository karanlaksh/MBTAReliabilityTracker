import { runTick, type Env } from './collector';
import { buildStatus, DAILY_WRITE_LIMIT } from './status';

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Awaited, not fire-and-forget: runTick already swallows its own errors and
    // records them, and we want the invocation to stay alive until the write
    // lands. ctx is unused but part of the handler contract.
    void ctx;
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
        routes: ['GET /status', 'GET /health (alias)', 'POST /collect?token='],
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
