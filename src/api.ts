// Read-only JSON API for the frontend.
//
// Served ENTIRELY from the rollup tables. The frontend must never touch
// prediction_snapshots: it has no secondary index by design (see CLAUDE.md), it
// is 518k rows today and ~3M by November, and any per-request scan of it would
// blow both the Worker CPU limit and the D1 read budget.
//
// KNOWN APPROXIMATION, recorded in the README as a known issue: rollup_error_by_day
// stores one median per (date, slice, bucket). Medians do not compose, so pooling
// across a date range here yields an n-weighted mean of daily medians, not a true
// pooled median. It is close enough for the headline comparison (checked against a
// pooled computation over raw rows: bus +27s vs Orange +4s either way) but it is
// not the same statistic, so the field carries a `method` label saying so. The fix
// is a route-grain pooled rollup, which is out of scope here.

import type { Env } from './collector';

/** Rollups recompute once daily at 04:00 local, so a 30-minute cache is generous. */
const CACHE_CONTROL = 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400';

const BUCKET_ORDER = ['~1.5 min', '~4.5 min', '~9 min', '~16 min'];
const BUCKET_HORIZON: Record<string, number> = {
  '~1.5 min': 90,
  '~4.5 min': 270,
  '~9 min': 540,
  '~16 min': 960,
};

/** Human labels for the watched routes, so the client does not hardcode them. */
const ROUTE_LABEL: Record<string, string> = {
  Orange: 'Orange Line',
  'Green-E': 'Green Line E',
  '39': 'Bus 39',
};

export function jsonResponse(body: unknown, status = 200, cache = true): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': cache ? CACHE_CONTROL : 'no-store',
    },
  });
}

interface Filters {
  from: string | null;
  to: string | null;
  mode: string | null;
  route: string | null;
  includeAdded: boolean;
  includePartial: boolean;
}

function readFilters(url: URL): Filters {
  return {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    mode: url.searchParams.get('mode'),
    route: url.searchParams.get('route'),
    // Defaults are the conservative reading: scheduled trips only, complete days
    // only. Both are opt-in rather than opt-out so a caller cannot accidentally
    // mix a partial day into a comparison.
    includeAdded: url.searchParams.get('include_added') === '1',
    includePartial: url.searchParams.get('include_partial') === '1',
  };
}

/** Shared WHERE builder over rollup_error_by_day. */
function whereClause(f: Filters): { sql: string; binds: unknown[] } {
  const parts: string[] = ['1=1'];
  const binds: unknown[] = [];
  if (f.from) {
    parts.push('d.service_date >= ?');
    binds.push(f.from);
  }
  if (f.to) {
    parts.push('d.service_date <= ?');
    binds.push(f.to);
  }
  if (f.route) {
    parts.push('d.route_id = ?');
    binds.push(f.route);
  }
  if (f.mode) {
    parts.push('w.mode = ?');
    binds.push(f.mode);
  }
  if (!f.includeAdded) parts.push('d.is_added = 0');
  if (!f.includePartial) parts.push('d.is_partial = 0');
  return { sql: parts.join(' AND '), binds };
}

/**
 * GET /api/error-by-horizon
 *
 * One row per route per evaluation point. n is summed and therefore exact;
 * median and p90 are n-weighted means of the daily values — see the module note.
 */
export async function errorByHorizon(env: Env, url: URL): Promise<Response> {
  const f = readFilters(url);
  const { sql, binds } = whereClause(f);

  const { results } = await env.DB.prepare(
    `SELECT d.route_id, MAX(w.mode) AS mode, d.horizon_bucket,
            SUM(d.n) AS n,
            SUM(d.median_error_sec * d.n) / SUM(d.n) AS median_sec,
            SUM(d.p90_error_sec    * d.n) / SUM(d.n) AS p90_sec,
            SUM(d.p10_error_sec    * d.n) / SUM(d.n) AS p10_sec,
            SUM(d.pct_within_60s   * d.n) / SUM(d.n) AS pct_within_60s,
            COUNT(DISTINCT d.service_date) AS days,
            MIN(d.service_date) AS first_date, MAX(d.service_date) AS last_date
       FROM rollup_error_by_day d
       LEFT JOIN (SELECT DISTINCT stop_id, mode FROM watched_stops) w ON w.stop_id = d.stop_id
      WHERE ${sql}
      GROUP BY d.route_id, d.horizon_bucket`,
  )
    .bind(...binds)
    .all<Record<string, number | string>>();

  const byRoute = new Map<string, { route_id: string; mode: string; label: string; points: unknown[] }>();
  for (const r of results ?? []) {
    const route = String(r.route_id);
    if (!byRoute.has(route)) {
      byRoute.set(route, {
        route_id: route,
        mode: String(r.mode ?? 'unknown'),
        label: ROUTE_LABEL[route] ?? route,
        points: [],
      });
    }
    byRoute.get(route)!.points.push({
      bucket: r.horizon_bucket,
      horizon_sec: BUCKET_HORIZON[String(r.horizon_bucket)] ?? null,
      n: Number(r.n),
      median_sec: round1(r.median_sec),
      p10_sec: round1(r.p10_sec),
      p90_sec: round1(r.p90_sec),
      pct_within_60s: round1(r.pct_within_60s),
      days: Number(r.days),
    });
  }

  const series = [...byRoute.values()].map((s) => ({
    ...s,
    points: s.points.sort(
      (a, b) =>
        BUCKET_ORDER.indexOf(String((a as { bucket: string }).bucket)) -
        BUCKET_ORDER.indexOf(String((b as { bucket: string }).bucket)),
    ),
  }));

  return jsonResponse({
    sign_convention: 'positive means the train arrived LATER than predicted',
    bucket_order: BUCKET_ORDER,
    method:
      'n is exact; median_sec and p90_sec are n-weighted means of per-day medians, not pooled medians',
    filters: f,
    series,
  });
}

/**
 * GET /api/error-by-day
 *
 * Time series. is_partial is returned on EVERY row, and partial days are included
 * by default here (unlike the horizon endpoint) precisely so the client is forced
 * to decide what to do with them rather than being handed a silently truncated
 * series. A partial day has fewer graded arrivals and renders as a dip at the
 * right-hand edge: a collection artifact that looks exactly like a finding.
 */
export async function errorByDay(env: Env, url: URL): Promise<Response> {
  const f = readFilters(url);
  f.includePartial = url.searchParams.get('include_partial') !== '0';
  const { sql, binds } = whereClause(f);

  const { results } = await env.DB.prepare(
    `SELECT d.service_date, d.route_id, MAX(w.mode) AS mode, d.horizon_bucket,
            MAX(d.is_partial) AS is_partial,
            SUM(d.n) AS n,
            SUM(d.median_error_sec * d.n) / SUM(d.n) AS median_sec,
            SUM(d.p90_error_sec    * d.n) / SUM(d.n) AS p90_sec,
            SUM(d.arrivals_total) AS arrivals_total,
            SUM(d.unfulfilled) AS unfulfilled
       FROM rollup_error_by_day d
       LEFT JOIN (SELECT DISTINCT stop_id, mode FROM watched_stops) w ON w.stop_id = d.stop_id
      WHERE ${sql}
      GROUP BY d.service_date, d.route_id, d.horizon_bucket
      ORDER BY d.service_date`,
  )
    .bind(...binds)
    .all<Record<string, number | string>>();

  return jsonResponse({
    sign_convention: 'positive means the train arrived LATER than predicted',
    method:
      'median_sec and p90_sec are n-weighted means across the slices of a route on that date',
    filters: f,
    rows: (results ?? []).map((r) => ({
      service_date: r.service_date,
      route_id: r.route_id,
      label: ROUTE_LABEL[String(r.route_id)] ?? r.route_id,
      mode: r.mode ?? 'unknown',
      bucket: r.horizon_bucket,
      // Never omitted. The client cannot mistake a partial day for a complete one.
      is_partial: Number(r.is_partial) === 1,
      n: Number(r.n),
      median_sec: round1(r.median_sec),
      p90_sec: round1(r.p90_sec),
      arrivals_total: Number(r.arrivals_total ?? 0),
      unfulfilled: Number(r.unfulfilled ?? 0),
    })),
  });
}

/**
 * GET /api/summary
 *
 * Collection status for the page footer. Per-slice counts include a zero-service
 * marker and the governing alert text, because a watched slice at zero must read
 * as "no service" and not as a broken collector — which is what a flat line at
 * zero looks like.
 */
export async function summary(env: Env): Promise<Response> {
  const [span, bySource, slices, alerts, runs] = await Promise.all([
    env.DB.prepare(
      `SELECT MIN(service_date) AS since, MAX(service_date) AS until,
              COUNT(*) AS arrivals FROM arrivals`,
    ).first<Record<string, string | number>>(),

    env.DB.prepare(
      'SELECT source, COUNT(*) AS n FROM arrivals GROUP BY source ORDER BY n DESC',
    ).all<{ source: string; n: number }>(),

    env.DB.prepare(
      `SELECT w.stop_id, w.route_id, w.direction_id, w.label, w.mode, w.stop_role,
              COALESCE(a.n, 0) AS arrivals,
              COALESCE(a.recent, 0) AS arrivals_last_7d
         FROM watched_stops w
         LEFT JOIN (
           SELECT stop_id, route_id, direction_id, COUNT(*) AS n,
                  SUM(CASE WHEN service_date >= date('now','-7 day') THEN 1 ELSE 0 END) AS recent
             FROM arrivals GROUP BY 1,2,3
         ) a ON a.stop_id=w.stop_id AND a.route_id=w.route_id AND a.direction_id=w.direction_id
        WHERE w.active = 1
        ORDER BY w.mode, w.route_id, w.stop_id, w.direction_id`,
    ).all<Record<string, string | number>>(),

    // Most recent alert per affected route, for the zero-service explanation.
    env.DB.prepare(
      `SELECT affected_routes, effect, severity, header, active_period_start, active_period_end
         FROM alert_snapshots
        WHERE affects_watched = 1 AND active_period_start > 0
          AND effect IN ('SUSPENSION','SHUTTLE','STATION_CLOSURE','DETOUR')
        ORDER BY active_period_start DESC LIMIT 40`,
    ).all<Record<string, string | number>>(),

    env.DB.prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(concurrent_tick),0) AS concurrent,
              MAX(started_at) AS last_run
         FROM collector_runs`,
    ).first<Record<string, number>>(),
  ]);

  const sources = bySource.results ?? [];
  const graded = sources.filter((r) => r.source !== 'no_arrival_predicted').reduce((n, r) => n + r.n, 0);
  const unfulfilled = sources
    .filter((r) => r.source === 'skipped' || r.source === 'unresolved_dropout')
    .reduce((n, r) => n + r.n, 0);

  const computedAt = await env.DB.prepare(
    'SELECT MAX(computed_at) AS c FROM rollup_error_by_day',
  ).first<{ c: number }>();

  return jsonResponse({
    since: span?.since ?? null,
    until: span?.until ?? null,
    arrivals: Number(span?.arrivals ?? 0),
    rollup_computed_at: computedAt?.c ?? null,
    graded_predictions: graded,
    unfulfilled,
    // Reported with its denominator. 'no_arrival_predicted' is excluded because
    // MBTA never promised an arrival there: un-promised is not unfulfilled.
    unfulfilled_rate: graded > 0 ? Number((unfulfilled / graded).toFixed(4)) : null,
    arrivals_by_source: sources,
    collector: {
      runs_retained: Number(runs?.runs ?? 0),
      failed_runs: Number(runs?.failed ?? 0),
      concurrent_ticks: Number(runs?.concurrent ?? 0),
      last_run: Number(runs?.last_run ?? 0),
    },
    slices: (slices.results ?? []).map((s) => ({
      stop_id: s.stop_id,
      route_id: s.route_id,
      direction_id: s.direction_id,
      label: s.label,
      mode: s.mode,
      stop_role: s.stop_role,
      arrivals: Number(s.arrivals),
      arrivals_last_7d: Number(s.arrivals_last_7d),
      // The frontend renders this as "no service — <alert>", never as a zero.
      no_recent_service: Number(s.arrivals_last_7d) === 0,
    })),
    service_alerts: (alerts.results ?? []).map((a) => ({
      routes: safeParse(a.affected_routes),
      effect: a.effect,
      severity: a.severity,
      header: a.header,
      start: a.active_period_start,
      end: a.active_period_end,
    })),
  });
}

function round1(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function safeParse(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const __test = { readFilters, whereClause, BUCKET_ORDER, BUCKET_HORIZON, round1, safeParse };
