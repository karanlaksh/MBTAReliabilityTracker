// Build step 5: rollup tables.
//
// Two tables, both RECOMPUTED rather than patched, but over BOUNDED ranges:
// rollup_error_by_day one service date at a time (recent dates on schedule, old
// ones only on request, never before ROLLUP_FLOOR), rollup_error_by_slice over
// a rolling 7-day window. Until 2026-09-28 both were recomputed over all
// history, ~20-30M rows read per run against a 5M/day limit. See the staleness
// policy in the README for why recompute rather than incremental patching.
//
// All aggregation happens inside D1 as INSERT ... SELECT. Nothing streams through
// the Worker: we already hit "Worker exceeded CPU time limit" on the backfill path
// at 258k snapshots, and pulling ~44,000 bucket-points into JS to aggregate them
// would hit the same wall. SQL keeps the row-by-row work server-side.

import { localHour, serviceDate } from './service-date';
import type { Env } from './collector';

/**
 * Each bucket is ONE EVALUATION HORIZON, named for it — not a band.
 *
 * A band label invites a "pick a row inside the band" rule, and measured on real
 * data that rule graded the old '0-3' band at a mean horizon of 40 seconds: the
 * last prediction before arrival, which converges to zero error and measures MBTA
 * at its easiest. It reported a median error of 1s and looked reasonable.
 */
const BUCKETS: { label: string; h: number }[] = [
  { label: '~1.5 min', h: 90 },
  { label: '~4.5 min', h: 270 },
  { label: '~9 min', h: 540 },
  { label: '~16 min', h: 960 },
];

/** Local hour at which the daily recompute runs. See README staleness policy. */
const RECOMPUTE_LOCAL_HOUR = 4;

/**
 * rollup_error_by_day dates recomputed per scheduled run: the open date and the
 * two before it. A date is final once the matcher has settled it (~04:00 the
 * next morning); the extra day absorbs a matcher that fell behind.
 */
const BY_DAY_RECENT_DAYS = 3;

/**
 * Days of data behind the typical-week grid. Sized by measured cost, not by
 * preference — see the README rollup cost table.
 */
export const SLICE_WINDOW_DAYS = 7;

/**
 * No service date before this is ever recomputed, on schedule or by hand.
 *
 * From ~2026-09-02 to 2026-09-28 the read limit cut collection to ~20:00-01:30
 * local, so those dates are not comparable with complete ones and are not
 * summarised. Rows in rollup_error_by_day through 2026-09-08 were computed
 * before this rewrite and are left exactly as they are.
 */
export const ROLLUP_FLOOR = '2026-09-28';

export interface RollupStats {
  by_slice_rows: number;
  by_day_rows: number;
  /** Rows inserted. Deletes also cost writes and are not counted here. */
  rows_written: number;
  /** Summed from D1's own per-statement meta: the measured cost of this run. */
  rows_read: number;
  by_day_dates: string[];
  /** Requested dates left untouched: before ROLLUP_FLOOR, or no snapshots. */
  skipped_dates: string[];
  slice_window: { from: string; to: string } | null;
  partial_dates: string[];
  duration_ms: number;
  error: string | null;
}

/**
 * Recover the America/New_York UTC offset for a row from data we already compute
 * correctly, rather than hardcoding -4 hours.
 *
 * D1 has no timezone database, so `localtime` is unavailable and a fixed offset
 * would be wrong for five months of the year. But `service_date` was computed in
 * TypeScript with the real rules, and it rolls at 03:00 local — so the offset is
 * whichever of EDT/EST makes (arrival - offset - 3h) land on that service_date.
 * Self-consistent with the collector by construction.
 */
const OFFSET_SQL = `(CASE
  WHEN date(a.actual_arrival_at - 14400 - 10800, 'unixepoch') = a.service_date THEN -14400
  ELSE -18000 END)`;

/**
 * The graded prediction for evaluation horizon H, and the eligibility rule.
 *
 * CARRY-FORWARD: the prediction in effect at horizon H is the LAST SNAPSHOT
 * WRITTEN with horizon_sec >= H — that is, the one with the smallest such
 * horizon_sec, since horizon decreases as time passes and rows are appended in
 * time order. Predictions persist on the display until revised, so an unrevised
 * prediction is still the prediction a rider saw.
 *
 * THE STORED horizon_sec IS A SELECTION CRITERION, NOT THE HORIZON BEING GRADED.
 * A row written at horizon 1100 can be the prediction in effect at horizon 300:
 * the stored value is frozen at write time while the displayed countdown keeps
 * decreasing. Reading it as "the horizon this row is about" is precisely the
 * mistake that produced the 40-second bucket.
 *
 * ELIGIBILITY, and why it is not a rule about ADDED trips: a (trip, stop) counts
 * toward horizon H only if it has any snapshot at horizon >= H. That is exactly
 * the population that could have had a prediction at H. It handles unscheduled
 * ADDED trips — which cannot have a 16-minute-out prediction by construction —
 * and equally handles the late-entering SCHEDULED trips (measured: 49 blocked at
 * ~9 min, 15 at ~4.5 min) that a rule about ADDED would have silently missed.
 * One rule, no exceptions. is_added stays a dimension so the two can be compared.
 */
/**
 * Packing base for the carry-forward pick. predicted_arrival (epoch seconds,
 * < 1e10 until 2286) occupies the low digits and horizon_sec the high ones, so
 * MIN over the packed value selects the smallest qualifying horizon and carries
 * that row's predicted_arrival with it — an argmin inside a plain GROUP BY.
 */
const PACK = 10_000_000_000;

function gradedSql(r: SnapshotRange): string {
  // ONE PASS FOR ALL FOUR BUCKETS. The previous version ran this join once per
  // bucket and picked with ROW_NUMBER() each time: measured locally at
  // production scale, ~18 rows read per snapshot per date, because every window
  // function sorts through a temp b-tree that D1 bills as reads. Here each
  // (trip, stop) is grouped once and all four picks come out of that group.
  //
  // Selection is unchanged: for horizon H, the snapshot with the smallest
  // horizon_sec >= H. Ties on horizon_sec — two rows for one (trip, stop) at the
  // same stored horizon — now resolve to the earlier predicted_arrival; the old
  // ROW_NUMBER ordering left them arbitrary.
  //
  // BOUNDED BY ROWID, NOT BY AN INDEX. prediction_snapshots.service_date comes
  // from the tick time and ticks append in order, so each service date is a
  // contiguous id range; findDateStartId locates it in ~20 one-row probes. The
  // unbounded version of this join read 1.4M-3.8M rows per statement.
  //
  // CROSS JOIN is SQLite's explicit join-order control: it forces the id range
  // on p to be the outer loop, with each row probing arrivals through its
  // UNIQUE (service_date, trip_id, stop_id) index. The other order would scan a
  // whole day of snapshots once per arrival.
  const upper = r.hiId === null ? '' : `AND p.id < ${int(r.hiId)}`;
  const minH = Math.min(...BUCKETS.map((b) => b.h));
  const picks = BUCKETS.map(
    (b) =>
      `MIN(CASE WHEN p.horizon_sec >= ${b.h} THEN p.horizon_sec * ${PACK} + p.predicted_arrival END) AS k${b.h}`,
  ).join(',\n           ');
  const unpivot = BUCKETS.map(
    (b) => `SELECT ${b.h} AS h, '${b.label}' AS horizon_bucket`,
  ).join(' UNION ALL ');
  const kFor = `CASE b.h ${BUCKETS.map((b) => `WHEN ${b.h} THEN k${b.h}`).join(' ')} END`;
  // MATERIALIZED + CROSS JOIN below: evaluate the join once, then fan each
  // group out to four bucket rows. Left to the planner, SQLite put the 4-row
  // bucket list in the outer loop and re-ran the whole join per bucket —
  // measured at 4x the reads of this form.
  return `
    WITH picks AS MATERIALIZED (
      SELECT a.stop_id, a.route_id, a.direction_id, a.service_date, a.trip_id,
             a.actual_arrival_at,
             ${picks}
        FROM prediction_snapshots p
        CROSS JOIN arrivals a
          ON a.service_date = p.service_date
         AND a.trip_id      = p.trip_id
         AND a.stop_id      = p.stop_id
       WHERE p.id >= ${int(r.loId)} ${upper}
         AND p.service_date >= '${date(r.from)}' AND p.service_date <= '${date(r.to)}'
         AND a.actual_arrival_at IS NOT NULL
         AND p.predicted_arrival IS NOT NULL
         AND p.horizon_sec >= ${minH}
       GROUP BY a.service_date, a.trip_id, a.stop_id
    )
    SELECT a.stop_id, a.route_id, a.direction_id, a.service_date,
           CASE WHEN a.trip_id LIKE 'ADDED%' THEN 1 ELSE 0 END AS is_added,
           CAST(strftime('%w', a.service_date) AS INTEGER) AS weekday,
           CAST(strftime('%H', a.actual_arrival_at + ${OFFSET_SQL}, 'unixepoch') AS INTEGER) AS hour,
           b.horizon_bucket,
           a.actual_arrival_at - (${kFor} % ${PACK}) AS err
      FROM picks a
      CROSS JOIN (${unpivot}) b
     -- Eligibility: a (trip, stop) counts toward H only if it had a snapshot at
     -- horizon >= H. A NULL pick is exactly "never predicted that far out".
     WHERE ${kFor} IS NOT NULL`;
}

/** A service-date span of prediction_snapshots and the id range that holds it. */
export interface SnapshotRange {
  from: string;
  to: string;
  loId: number;
  /** Exclusive. null = through the newest row. */
  hiId: number | null;
}

/** Values are interpolated into SQL, so refuse anything that is not the expected shape. */
function int(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${n}`);
  return n;
}
function date(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`not a date: ${d}`);
  return d;
}

/**
 * Smallest id whose service_date >= target, by binary search over rowid.
 *
 * Each probe is `WHERE id >= ? ORDER BY id LIMIT 1` — a rowid seek reading one
 * row — so this costs ~log2(rows) reads, about 20 at a million rows. Relies on
 * service_date being non-decreasing in id order, which holds because the
 * collector stamps every row with serviceDate(tick time) and appends in tick
 * order. Returns null when no row is that recent.
 *
 * Split from D1 so it is testable against an in-memory array.
 */
export async function findDateStartId(
  probe: (id: number) => Promise<{ id: number; service_date: string } | null>,
  bounds: { minId: number; maxId: number },
  target: string,
): Promise<number | null> {
  let lo = bounds.minId;
  let hi = bounds.maxId;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = await probe(mid);
    if (row === null) {
      hi = mid - 1;
    } else if (row.service_date >= target) {
      found = row.id;
      hi = mid - 1;
    } else {
      lo = row.id + 1;
    }
  }
  return found;
}

async function d1DateStartId(db: D1Database, target: string): Promise<number | null> {
  // ORDER BY id LIMIT 1, never MIN/MAX: a rowid seek, one row read.
  const first = await db
    .prepare('SELECT id FROM prediction_snapshots ORDER BY id ASC LIMIT 1')
    .first<{ id: number }>();
  const last = await db
    .prepare('SELECT id FROM prediction_snapshots ORDER BY id DESC LIMIT 1')
    .first<{ id: number }>();
  if (!first || !last) return null;
  const stmt = db.prepare(
    'SELECT id, service_date FROM prediction_snapshots WHERE id >= ? ORDER BY id LIMIT 1',
  );
  return findDateStartId(
    (id) => stmt.bind(id).first<{ id: number; service_date: string }>(),
    { minId: first.id, maxId: last.id },
    target,
  );
}

/** The id range holding service dates [from, to]. null if none of it exists. */
export async function snapshotRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<SnapshotRange | null> {
  const loId = await d1DateStartId(db, from);
  if (loId === null) return null;
  const hiId = await d1DateStartId(db, addDays(to, 1));
  return { from, to, loId, hiId };
}

export function addDays(d: string, n: number): string {
  const t = Date.parse(`${date(d)}T12:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Percentiles by ordinal rank. SQLite has no percentile aggregate, so rank within
 * each group and pick. Every group also carries n — nothing in this project
 * reports a median without its sample size.
 */
function statsSql(groupCols: string[], r: SnapshotRange): string {
  const g = [...groupCols, 'horizon_bucket'].join(', ');
  return `
    WITH graded AS (${gradedSql(r)}),
    ranked AS (
      SELECT ${g}, err,
             ROW_NUMBER() OVER (PARTITION BY ${g} ORDER BY err) AS r,
             COUNT(*)     OVER (PARTITION BY ${g})              AS c,
             AVG(err)     OVER (PARTITION BY ${g})              AS mean_err,
             AVG(CASE WHEN ABS(err) <= 60 THEN 1.0 ELSE 0.0 END)
               OVER (PARTITION BY ${g})                         AS within60
        FROM graded
    )
    SELECT ${g}, MAX(c) AS n,
           MAX(mean_err) AS mean_error_sec,
           MAX(CASE WHEN r = (c + 1) / 2 THEN err END) AS median_error_sec,
           MAX(CASE WHEN r = MAX(1, CAST(c * 0.1 AS INTEGER)) THEN err END) AS p10_error_sec,
           MAX(CASE WHEN r = MAX(1, CAST(c * 0.9 AS INTEGER)) THEN err END) AS p90_error_sec,
           MAX(within60) AS pct_within_60s
      FROM ranked GROUP BY ${g}`;
}

export interface RollupOptions {
  /**
   * Service dates to recompute in rollup_error_by_day. Defaults to the open date
   * and the BY_DAY_RECENT_DAYS - 1 before it. Dates before ROLLUP_FLOOR are
   * dropped, and reported in skipped_dates.
   */
  byDayDates?: string[];
  /** Rebuild rollup_error_by_slice over its window. Default true. */
  slice?: boolean;
}

export async function runRollup(
  env: Env,
  startedAtMs: number,
  opts: RollupOptions = {},
): Promise<RollupStats> {
  const now = Math.floor(startedAtMs / 1000);
  const stats: RollupStats = {
    by_slice_rows: 0,
    by_day_rows: 0,
    rows_written: 0,
    rows_read: 0,
    by_day_dates: [],
    skipped_dates: [],
    slice_window: null,
    partial_dates: [],
    duration_ms: 0,
    error: null,
  };

  try {
    // The service date currently in progress. Its arrivals are still being
    // matched — settlement waits 30 minutes past last predicted arrival — so any
    // figure for it is incomplete by construction, not by accident.
    const openDate = serviceDate(now);
    stats.partial_dates = [openDate];

    // --- table 2: day grain, ONE SERVICE DATE PER BATCH --------------------
    // Exists because table 1 has NO DATE DIMENSION and so cannot express a
    // before/during/after comparison at all. Its purpose is time series, and
    // specifically Green-E: Aug 3-7 running vs Aug 8-16 suspended, on Orange and
    // bus 39 — slices that stay collectable through both windows.
    //
    // Only the named dates are touched; every other row, including the history
    // through 2026-09-08, is left exactly as it is. Each date is DELETE + INSERT
    // in one db.batch(), which D1 runs as a single transaction: the previous
    // version ran the DELETE as its own statement, so when the INSERTs hit the
    // read limit the delete had already committed and the table stayed empty.
    const requested =
      opts.byDayDates ??
      Array.from({ length: BY_DAY_RECENT_DAYS }, (_, i) => addDays(openDate, i - BY_DAY_RECENT_DAYS + 1));
    const byDayDates = requested.filter((d) => d >= ROLLUP_FLOOR);
    stats.skipped_dates.push(...requested.filter((d) => d < ROLLUP_FLOOR));
    const dayCols = ['service_date', 'stop_id', 'route_id', 'direction_id', 'is_added'];
    for (const d of byDayDates) {
      const range = await snapshotRange(env.DB, d, d);
      if (range === null || (range.hiId !== null && range.hiId <= range.loId)) {
        stats.skipped_dates.push(d);
        continue;
      }
      const statements = [
        env.DB.prepare('DELETE FROM rollup_error_by_day WHERE service_date = ?').bind(d),
        env.DB.prepare(
            `INSERT INTO rollup_error_by_day
               (service_date, stop_id, route_id, direction_id, horizon_bucket, is_added,
                n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
                pct_within_60s, arrivals_total, unfulfilled, no_arrival_predicted,
                is_partial, computed_at)
             SELECT s.service_date, s.stop_id, s.route_id, s.direction_id,
                    s.horizon_bucket, s.is_added,
                    s.n, s.mean_error_sec, s.median_error_sec, s.p10_error_sec,
                    s.p90_error_sec, s.pct_within_60s,
                    d.graded, d.unfulfilled, d.not_promised,
                    CASE WHEN s.service_date >= ?1 THEN 1 ELSE 0 END,
                    ${now}
               FROM (${statsSql(dayCols, range)}) s
               LEFT JOIN (
                 SELECT service_date, stop_id, route_id, direction_id,
                        SUM(CASE WHEN source <> 'no_arrival_predicted' THEN 1 ELSE 0 END) AS graded,
                        SUM(CASE WHEN source IN ('skipped','unresolved_dropout') THEN 1 ELSE 0 END) AS unfulfilled,
                        SUM(CASE WHEN source = 'no_arrival_predicted' THEN 1 ELSE 0 END) AS not_promised
                   FROM arrivals WHERE service_date = ?2 GROUP BY 1,2,3,4
               ) d
                 ON d.service_date = s.service_date AND d.stop_id = s.stop_id
                AND d.route_id = s.route_id AND d.direction_id = s.direction_id`,
          ).bind(openDate, d),
      ];
      const results = await env.DB.batch(statements);
      for (const [i, res] of results.entries()) {
        stats.rows_read += res.meta?.rows_read ?? 0;
        if (i > 0) stats.by_day_rows += res.meta?.changes ?? 0;
      }
      stats.by_day_dates.push(d);
    }

    // --- table 1: the typical-week grid, over a bounded window -------------
    // It has no date dimension, so it cannot be patched a date at a time, and
    // medians do not compose: every run recomputes the whole window. The window
    // is therefore what bounds the cost — see SLICE_WINDOW_DAYS.
    if (opts.slice !== false) {
      const windowStart = addDays(openDate, -(SLICE_WINDOW_DAYS - 1));
      const from = windowStart > ROLLUP_FLOOR ? windowStart : ROLLUP_FLOOR;
      const range = await snapshotRange(env.DB, from, openDate);
      if (range !== null) {
        stats.slice_window = { from, to: openDate };
        const sliceCols = ['stop_id', 'route_id', 'direction_id', 'weekday', 'hour', 'is_added'];
        const results = await env.DB.batch([
          env.DB.prepare('DELETE FROM rollup_error_by_slice'),
          env.DB.prepare(
              `INSERT INTO rollup_error_by_slice
                 (stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added,
                  n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
                  pct_within_60s, computed_at)
               SELECT stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added,
                      n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
                      pct_within_60s, ${now}
                 FROM (${statsSql(sliceCols, range)})`,
            ),
        ]);
        for (const [i, res] of results.entries()) {
          stats.rows_read += res.meta?.rows_read ?? 0;
          if (i > 0) stats.by_slice_rows += res.meta?.changes ?? 0;
        }
      }
    }

    stats.rows_written = stats.by_slice_rows + stats.by_day_rows;
  } catch (err) {
    stats.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('rollup failed', stats.error);
  }

  stats.duration_ms = Date.now() - startedAtMs;
  return stats;
}

/**
 * Whether this matcher tick should also recompute rollups.
 *
 * Gated on LOCAL hour rather than a fixed UTC cron. 04:00 local is 08:00 UTC in
 * summer but 09:00 UTC in winter, so a fixed UTC schedule would drift — and it
 * would drift onto 03:00 local, which is the service-date rollover boundary and
 * the worst possible moment to sample.
 *
 * 04:00 local, not midnight: service dates roll at 03:00 and settlement waits 30
 * minutes past a trip's last predicted arrival, so the previous service date is
 * not fully graded until roughly 03:30-04:00. A midnight recompute would leave
 * the most recent day partially graded every single time.
 */
export function shouldRecompute(now: number, minuteOfHour: number): boolean {
  return localHour(now) === RECOMPUTE_LOCAL_HOUR && minuteOfHour < 15;
}

export const __test = { BUCKETS, shouldRecompute, gradedSql, statsSql, findDateStartId, addDays };
