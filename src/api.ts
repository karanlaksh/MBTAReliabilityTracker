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
import { serviceDate } from './service-date';

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
/**
 * collector_runs has no index on started_at; ids only increase and ticks are one
 * a minute, so the last N ids bound the 7-day window the frontend labels this
 * as. Without it, the count covered every row ever retained — and the 04:07
 * local prune had been failing on the exhausted read budget, so that was every
 * run since 2026-09-01. 7 x 1,440 = 10,080; the margin absorbs manual and
 * concurrent ticks.
 */
const RUNS_7D_BOUND = 12_000;

export async function summary(env: Env): Promise<Response> {
  const [span, bySource, slices, alerts, runs] = await Promise.all([
    // All three arrival aggregates read arrival_counts (~30 rows per service
    // date), not arrivals. They used to aggregate the whole arrivals table three
    // times per call — ~136k rows each, growing forever — on a page that
    // revalidates every 30 minutes. See migration 0010.
    env.DB.prepare(
      `SELECT MIN(service_date) AS since, MAX(service_date) AS until,
              COALESCE(SUM(n), 0) AS arrivals FROM arrival_counts`,
    ).first<Record<string, string | number>>(),

    env.DB.prepare(
      'SELECT source, SUM(n) AS n FROM arrival_counts GROUP BY source ORDER BY n DESC',
    ).all<{ source: string; n: number }>(),

    env.DB.prepare(
      `SELECT w.stop_id, w.route_id, w.direction_id, w.label, w.mode, w.stop_role,
              COALESCE(a.n, 0) AS arrivals,
              COALESCE(a.recent, 0) AS arrivals_last_7d
         FROM watched_stops w
         LEFT JOIN (
           SELECT stop_id, route_id, direction_id, SUM(n) AS n,
                  SUM(CASE WHEN service_date >= date('now','-7 day') THEN n ELSE 0 END) AS recent
             FROM arrival_counts GROUP BY 1,2,3
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
         FROM collector_runs
        WHERE id > (SELECT MAX(id) FROM collector_runs) - ${RUNS_7D_BOUND}
          AND started_at >= strftime('%s','now') - ${7 * 86_400}`,
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

/** Display gate for the grid, shared with the frontend's copy. */
export const GRID_GATE = { minN: 20, minCoverage: 0.6, minMeanN: 20 } as const;

interface GridCell {
  weekday: number;
  n: number;
}

/**
 * When the grid's display gate should open, AT THE CURRENT RATE.
 *
 * Each cell gains data only from dates of its own weekday, so its rate is
 * n / (folded dates with that weekday). From that, each cell's time to reach
 * minN; the coverage gate opens when the minCoverage-th fraction of cells has
 * reached it, and the mean gate when mean n reaches minMeanN. The estimate is the
 * later of the two, counted forward from WHEN NEW DATA STARTS ARRIVING: the later
 * of the newest folded date and today's newest foldable date (today minus the
 * two-day fold lag), plus that lag. Counting from the newest folded date alone
 * was wrong: with only the August backfill folded it produced a date in early
 * September — in the past — because history is not future accumulation.
 *
 * Deliberately simple and stated as such: it assumes future dates look like the
 * folded ones and that no new cells appear. Returns null until every weekday has
 * at least one folded date — before that there is no rate to extrapolate.
 */
export function estimateGateOpen(
  cells: GridCell[],
  foldedDates: string[],
  today: string,
  gate: { minN: number; minCoverage: number; minMeanN: number } = GRID_GATE,
): { date: string | null; weeks: number | null; basis: string } {
  const perWeekday = new Array(7).fill(0);
  for (const d of foldedDates) perWeekday[new Date(`${d}T12:00:00Z`).getUTCDay()]++;
  if (cells.length === 0 || perWeekday.some((c) => c === 0)) {
    return { date: null, weeks: null, basis: 'not every weekday has a folded date yet' };
  }
  const rates = cells.map((c) => c.n / perWeekday[c.weekday]); // per week
  const toMin = cells
    .map((c, i) => (c.n >= gate.minN ? 0 : (gate.minN - c.n) / rates[i]))
    .sort((x, y) => x - y);
  const coverageWeeks = toMin[Math.min(toMin.length - 1, Math.ceil(gate.minCoverage * toMin.length) - 1)];
  const meanN = cells.reduce((t, c) => t + c.n, 0) / cells.length;
  const meanRate = rates.reduce((t, r) => t + r, 0) / rates.length;
  const meanWeeks = meanN >= gate.minMeanN ? 0 : (gate.minMeanN - meanN) / meanRate;
  const weeks = Math.max(coverageWeeks, meanWeeks);
  const DAY = 86_400_000;
  const newestFolded = Date.parse(`${[...foldedDates].sort().at(-1)!}T12:00:00Z`);
  const newestFoldable = Date.parse(`${today}T12:00:00Z`) - 2 * DAY;
  const t = Math.max(newestFolded, newestFoldable) + Math.ceil(weeks * 7 + 2) * DAY;
  return {
    date: weeks === 0 ? null : new Date(t).toISOString().slice(0, 10),
    weeks: Number(weeks.toFixed(1)),
    basis: 'at the current per-weekday rate, assuming future dates resemble the folded ones',
  };
}

/**
 * GET /api/error-by-slice
 *
 * The typical-week grid, from rollup_grid_totals: cells that accumulate across
 * service dates as exact sums and counts (migration 0011). The displayed value is
 * the share of predictions within 60 seconds; mean and mean absolute error are
 * stored but not served until they are shown.
 *
 * Coverage counts scheduled service only (is_added = 0) in BOTH numerator and
 * denominator: the grid never shows ADDED trips, so their cells must not dilute
 * the gate.
 */
export async function errorBySlice(env: Env, url: URL): Promise<Response> {
  const minN = Math.max(1, Number(url.searchParams.get('min_n') ?? GRID_GATE.minN));

  // Bounded by the number of cells (~6k at most), not by history.
  const [cellsRes, foldedRes] = await Promise.all([
    env.DB.prepare(
      `SELECT stop_id, route_id, direction_id, weekday, hour, horizon_bucket, n, n_within_60
         FROM rollup_grid_totals WHERE is_added = 0`,
    ).all<{
      stop_id: string; route_id: string; direction_id: number; weekday: number;
      hour: number; horizon_bucket: string; n: number; n_within_60: number;
    }>(),
    env.DB.prepare('SELECT service_date FROM rollup_grid_folded ORDER BY service_date').all<{
      service_date: string;
    }>(),
  ]);
  const cells = cellsRes.results ?? [];
  const folded = (foldedRes.results ?? []).map((r) => r.service_date);

  const passing = cells.filter((c) => c.n >= minN);
  const meanN = cells.length ? cells.reduce((t, c) => t + c.n, 0) / cells.length : 0;

  // The heatmap's colour scale, FITTED PER EVALUATION POINT: the 5th-95th
  // percentile of share-within-60s across every stop's cells at that point.
  // One scale per point, shared by all stops, so clicking between stops compares
  // like with like; a scale per stop would make that comparison meaningless.
  // Per point rather than global because the points differ too much for one
  // absolute scale (median cell ~96% at ~1.5 min, ~36% at ~16 min in the demo).
  const scale: Record<string, { lo: number; hi: number; cells: number }> = {};
  for (const b of new Set(passing.map((c) => c.horizon_bucket))) {
    const v = passing.filter((c) => c.horizon_bucket === b).map((c) => c.n_within_60 / c.n).sort((x, y) => x - y);
    const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
    scale[b] = { lo: Number(q(0.05).toFixed(4)), hi: Number(q(0.95).toFixed(4)), cells: v.length };
  }

  // One slice's full weekday x hour grid, for the heatmap: ?stop=&route=&dir=&bucket=.
  // EVERY cell is returned, small ones included, so the page can draw a cell below
  // min_n as empty rather than leaving the reader to wonder whether it is missing.
  // At most 7 x 24 cells, from rows already read above.
  const stop = url.searchParams.get('stop');
  const route = url.searchParams.get('route');
  const dir = url.searchParams.get('dir');
  const bucket = url.searchParams.get('bucket');
  const slice =
    stop && route && dir !== null && bucket
      ? {
          stop_id: stop,
          route_id: route,
          direction_id: Number(dir),
          horizon_bucket: bucket,
          cells: cells
            .filter(
              (c) =>
                c.stop_id === stop &&
                c.route_id === route &&
                c.direction_id === Number(dir) &&
                c.horizon_bucket === bucket,
            )
            .map((c) => ({
              weekday: c.weekday,
              hour: c.hour,
              n: c.n,
              share_within_60s: Number((c.n_within_60 / c.n).toFixed(4)),
            })),
        }
      : null;

  return jsonResponse({
    min_n: minN,
    metric: 'share_within_60s',
    cells_total: cells.length,
    mean_n_per_cell: Math.round(meanN),
    cells_passing: passing.length,
    coverage: cells.length ? Number((passing.length / cells.length).toFixed(4)) : 0,
    gate: GRID_GATE,
    accumulation: {
      dates_folded: folded.length,
      first: folded[0] ?? null,
      last: folded.at(-1) ?? null,
    },
    estimate: estimateGateOpen(cells, folded, serviceDate(Math.floor(Date.now() / 1000))),
    scale,
    slice,
    note: 'accumulates across service dates as exact sums and counts; share within 60s is the displayed value',
    cells: passing
      .sort((x, y) => y.n - x.n)
      .slice(0, 500)
      .map((c) => ({
        stop_id: c.stop_id,
        route_id: c.route_id,
        direction_id: c.direction_id,
        weekday: c.weekday,
        hour: c.hour,
        horizon_bucket: c.horizon_bucket,
        n: c.n,
        share_within_60s: Number((c.n_within_60 / c.n).toFixed(4)),
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

export const __test = {
  readFilters,
  whereClause,
  BUCKET_ORDER,
  BUCKET_HORIZON,
  round1,
  safeParse,
  estimateGateOpen,
};
