import { runTick, type Env } from './collector';
import { serviceDate } from './service-date';

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

    if (url.pathname === '/health') {
      return json(await health(env));
    }

    // Manual trigger, for verifying a fresh deploy without waiting for the cron.
    // Disabled unless COLLECT_TOKEN is set, because it writes.
    if (url.pathname === '/collect' && request.method === 'POST') {
      if (!env.COLLECT_TOKEN || url.searchParams.get('token') !== env.COLLECT_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      return json(await runTick(env, Date.now()));
    }

    return json({ error: 'not found', routes: ['GET /health', 'POST /collect?token='] }, 404);
  },
};

/**
 * Enough to answer "is it actually collecting?" without a dashboard. The real
 * status page comes next; this is what it will read.
 */
async function health(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const today = serviceDate(now);

  const last = await env.DB.prepare(
    'SELECT started_at, duration_ms, predictions_seen, snapshots_written, vehicles_seen, vehicle_rows_written, api_status, error FROM collector_runs ORDER BY id DESC LIMIT 1',
  ).first<Record<string, unknown>>();

  const lastHour = await env.DB.prepare(
    `SELECT COUNT(*) AS runs,
            SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS ok,
            SUM(snapshots_written) AS snapshots,
            SUM(vehicle_rows_written) AS vehicle_rows
       FROM collector_runs WHERE started_at >= ?`,
  )
    .bind(now - 3600)
    .first<Record<string, number>>();

  return {
    now,
    service_date: today,
    // A healthy collector has a last run under ~90 seconds old.
    seconds_since_last_run: last ? now - Number(last.started_at) : null,
    last_run: last,
    last_hour: lastHour,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
