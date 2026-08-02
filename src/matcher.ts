// Build step 4: joining a stored prediction to the arrival that fulfilled it.
//
// This is the core of the project. Two record streams, no fully trustworthy
// shared id, timestamps that do not line up, and orphans on both sides. Get the
// rule wrong and every downstream number is quietly wrong with nothing throwing.
//
// Everything here is derived and re-derivable. The matcher may be re-run over
// the same data any number of times; it must only ever improve a row, never
// degrade one. That is enforced by CONFIDENCE, below.

import { serviceDate } from './service-date';
import type { Env } from './collector';

/**
 * A (trip, stop) is only judged once its last predicted arrival is this far in
 * the past. Without it, a train still en route looks identical to one that
 * vanished, and in-flight trips would be permanently written off as dropouts on
 * the first pass.
 */
const SETTLE_SEC = 1800;

/**
 * Rows of prediction_snapshots to scan per run.
 *
 * prediction_snapshots has no secondary index — deliberately, see CLAUDE.md — so
 * this scans. Snapshots are appended in id order, which makes a rowid range an
 * efficient proxy for a time window without paying for an index on observed_at.
 *
 * Sized for roughly 3 hours: post-horizon-cap the collector writes ~20 rows/tick,
 * so ~3,600 rows per 3h. 5,000 leaves headroom for rush hour. At the 15-minute
 * cron this re-reads the unsettled tail about 12 times, ~400k reads/day against
 * a 5,000,000/day budget.
 */
const SCAN_LIMIT = 5_000;

/** Uncertainty for a directly observed STOPPED_AT, per CLAUDE.md. */
const STOPPED_AT_UNCERTAINTY_SEC = 30;

/**
 * Fallback uncertainty when a turnaround arrival has no approach observation to
 * bracket against, so only the reassignment timestamp is available.
 *
 * Deliberately large. That timestamp is when MBTA reassigned the vehicle, which
 * is at or after physical arrival — a one-directional lag, not symmetric noise.
 * A tight uncertainty here would make terminus arrivals read as systematically
 * late, which would surface as "MBTA under-predicts at Forest Hills": a finding
 * manufactured entirely by our own measurement method.
 */
const TURNAROUND_UNBRACKETED_UNCERTAINTY_SEC = 300;

/**
 * How far after the anchor to look for the reassignment STOPPED_AT, and how far
 * before the predicted arrival when there is no anchor observation.
 *
 * These bounds are load-bearing, not defensive. A single vehicle turns around at
 * the same terminus many times a day, so an unbounded search for "earliest
 * STOPPED_AT at this stop by this vehicle" finds the FIRST of the day rather than
 * the one belonging to this trip. Measured when this was unbounded: 167 of 182
 * turnaround arrivals were wrong by more than an hour, the worst by 16 hours.
 */
const TURNAROUND_SEARCH_AFTER_SEC = 1800;
const TURNAROUND_SEARCH_BEFORE_SEC = 600;

/**
 * A matched arrival further than this from the last predicted arrival is flagged
 * implausible. Generous on purpose — see migrations/0006_plausibility.sql.
 *
 * FLAGGED, NEVER DROPPED. Discarding implausible matches would preferentially
 * discard the largest errors, which are mostly real delays: the tail this project
 * exists to measure. The flag exists to catch matcher faults, not to clean data.
 */
const IMPLAUSIBLE_DELTA_SEC = 3600;

export const MATCHER_WATERMARK_KEY = 'matcher_watermark';

/**
 * Source ranking. An upsert may only replace a stored row when the new source
 * ranks strictly higher, so re-running can improve a row and never degrade it.
 *
 * 'no_arrival_predicted' sits at the bottom with 'unresolved_dropout' because
 * both mean "no arrival time recorded", but they are reported separately: one is
 * a failure to arrive, the other is MBTA never having promised an arrival.
 */
export const CONFIDENCE: Record<string, number> = {
  stopped_at: 5,
  stopped_at_turnaround: 4,
  sequence_advanced: 3,
  skipped: 2,
  unresolved_dropout: 1,
  no_arrival_predicted: 1,
};

export interface MatchStats {
  scanned_rows: number;
  candidates: number;
  settled: number;
  unsettled: number;
  /**
   * Upsert statements ATTEMPTED, not distinct arrivals rows. When the watermark
   * stalls on an early unsettled candidate the next pass re-scans everything
   * after it, so settled candidates are re-processed and counted again. Named
   * explicitly because reading it as a row count overstates the table by the
   * amount of that overlap.
   */
  upserts_attempted: number;
  implausible: number;
  by_source: Record<string, number>;
  turnaround_spans: number[];
  turnaround_unbracketed: number;
  watermark_before: number;
  watermark_after: number;
  duration_ms: number;
  error: string | null;
}

interface SnapshotRow {
  id: number;
  service_date: string;
  trip_id: string;
  stop_sequence: number;
  stop_id: string;
  route_id: string;
  direction_id: number | null;
  observed_at: number;
  predicted_arrival: number | null;
  predicted_departure: number | null;
  schedule_relationship: string | null;
  status: string | null;
  vehicle_id: string | null;
}

interface ObservationRow {
  service_date: string;
  trip_id: string | null;
  vehicle_id: string;
  stop_id: string | null;
  current_status: string;
  current_stop_sequence: number | null;
  vehicle_updated_at: number;
}

/** One (service_date, trip_id, stop_sequence, stop_id) and its full snapshot history. */
interface Candidate {
  minRowId: number;
  service_date: string;
  trip_id: string;
  stop_sequence: number;
  stop_id: string;
  route_id: string;
  direction_id: number | null;
  lastPredictedArrival: number | null;
  lastSnapshot: SnapshotRow;
  vehicleIds: Set<string>;
}

interface Resolution {
  source: string;
  actual: number | null;
  uncertainty: number | null;
  matchKey: string | null;
  spanSec: number | null;
}

/**
 * Is this match far enough from what was predicted to suspect the matcher rather
 * than the transit system? Never used to filter — only to flag and count.
 */
export function isImplausible(actual: number | null, lastPredictedArrival: number | null): boolean {
  if (actual === null || lastPredictedArrival === null) return false;
  return Math.abs(actual - lastPredictedArrival) > IMPLAUSIBLE_DELTA_SEC;
}

// --- scan -------------------------------------------------------------------

async function readWatermark(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT value FROM collector_state WHERE key = ?')
    .bind(MATCHER_WATERMARK_KEY)
    .first<{ value: string }>();
  if (!row) return 0;
  try {
    return Number((JSON.parse(row.value) as { last_row_id?: number }).last_row_id ?? 0);
  } catch {
    return 0;
  }
}

async function writeWatermark(db: D1Database, lastRowId: number, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(MATCHER_WATERMARK_KEY, JSON.stringify({ last_row_id: lastRowId, updated_at: now }), now)
    .run();
}

/**
 * Collapse a run of snapshots into one candidate per prediction identity.
 *
 * Identity is (service_date, trip_id, stop_sequence) per CLAUDE.md — stop_id is a
 * mutable attribute and is carried along rather than keyed on.
 */
function groupCandidates(rows: SnapshotRow[]): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const r of rows) {
    const key = `${r.service_date}|${r.trip_id}|${r.stop_sequence}`;
    const existing = out.get(key);
    if (!existing) {
      out.set(key, {
        minRowId: r.id,
        service_date: r.service_date,
        trip_id: r.trip_id,
        stop_sequence: r.stop_sequence,
        stop_id: r.stop_id,
        route_id: r.route_id,
        direction_id: r.direction_id,
        lastPredictedArrival: r.predicted_arrival,
        lastSnapshot: r,
        vehicleIds: new Set(r.vehicle_id ? [r.vehicle_id] : []),
      });
      continue;
    }
    existing.minRowId = Math.min(existing.minRowId, r.id);
    if (r.vehicle_id) existing.vehicleIds.add(r.vehicle_id);
    // Rows arrive in id order, so the last one seen is the newest snapshot.
    existing.lastSnapshot = r;
    existing.stop_id = r.stop_id;
    if (r.predicted_arrival !== null) existing.lastPredictedArrival = r.predicted_arrival;
  }
  return out;
}

// --- evidence ---------------------------------------------------------------

/**
 * MBTA said this stop would not be served. Checked below the observational
 * sources: if a vehicle was actually seen stopping there, that outranks a stale
 * flag.
 */
function isSkipped(s: SnapshotRow): boolean {
  const rel = (s.schedule_relationship ?? '').toUpperCase();
  if (rel === 'SKIPPED' || rel === 'CANCELLED') return true;
  // All three empty means the vehicle will not make this stop — see CLAUDE.md.
  return s.predicted_arrival === null && s.predicted_departure === null && s.status === null;
}

export function resolveArrival(
  candidate: Candidate,
  observations: ObservationRow[],
  isTerminus: boolean,
): Resolution {
  const target = candidate.stop_sequence;
  const ownTrip = observations.filter((o) => o.trip_id === candidate.trip_id);

  // 1. Directly observed STOPPED_AT at the target.
  //
  // EARLIEST, not latest. At a terminus, and on any long dwell, a vehicle reports
  // STOPPED_AT for several consecutive minutes; taking the latest would push the
  // recorded arrival to the end of the dwell and make every such stop look late.
  const bySequence = ownTrip.filter(
    (o) => o.current_status === 'STOPPED_AT' && o.current_stop_sequence === target,
  );
  const byStopId = ownTrip.filter(
    (o) => o.current_status === 'STOPPED_AT' && o.stop_id === candidate.stop_id,
  );
  // stop_sequence first: stop_id is the mutable field.
  const direct = bySequence.length > 0 ? bySequence : byStopId;
  if (direct.length > 0) {
    return {
      source: 'stopped_at',
      actual: Math.min(...direct.map((o) => o.vehicle_updated_at)),
      uncertainty: STOPPED_AT_UNCERTAINTY_SEC,
      matchKey: bySequence.length > 0 ? 'stop_sequence' : 'stop_id',
      spanSec: null,
    };
  }

  // 2. Terminus turnaround.
  //
  // On arrival at a terminating stop MBTA immediately reassigns the vehicle to
  // its next outbound trip, so the STOPPED_AT is filed under a different trip_id
  // (direction 1, stop_sequence 1). Measured: 0 of 169 Forest Hills arrivals are
  // findable by trip_id; 166 of 169 are findable by vehicle_id.
  //
  // Bracketed, NOT point-estimated. The reassignment timestamp is at or after
  // physical arrival — a one-directional lag. Using it directly would bias every
  // terminus arrival late and read as MBTA under-predicting there.
  if (isTerminus) {
    // T1 first, and it anchors everything. At a terminating stop every
    // observation under the old trip is an approach to the final stop, so the
    // latest of them is the last moment the vehicle was known not yet arrived.
    const lastOwnSighting = ownTrip.reduce<number | null>(
      (max, o) => (max === null || o.vehicle_updated_at > max ? o.vehicle_updated_at : max),
      null,
    );

    // Without an anchor observation, fall back to a window around the last
    // predicted arrival. Wider and weaker, but still bounded — see the constants.
    const windowStart =
      lastOwnSighting ??
      (candidate.lastPredictedArrival !== null
        ? candidate.lastPredictedArrival - TURNAROUND_SEARCH_BEFORE_SEC
        : null);
    const windowEnd =
      (lastOwnSighting ?? candidate.lastPredictedArrival ?? 0) + TURNAROUND_SEARCH_AFTER_SEC;

    const reassigned = observations
      .filter(
        (o) =>
          o.current_status === 'STOPPED_AT' &&
          o.stop_id === candidate.stop_id &&
          o.trip_id !== candidate.trip_id &&
          candidate.vehicleIds.has(o.vehicle_id) &&
          (windowStart === null || o.vehicle_updated_at >= windowStart) &&
          o.vehicle_updated_at <= windowEnd,
      )
      .sort((a, b) => a.vehicle_updated_at - b.vehicle_updated_at);

    if (reassigned.length > 0) {
      const t2 = reassigned[0].vehicle_updated_at;

      if (lastOwnSighting !== null && t2 >= lastOwnSighting) {
        const t1 = lastOwnSighting;
        const span = Math.max(0, t2 - t1);
        return {
          source: 'stopped_at_turnaround',
          actual: Math.round((t1 + t2) / 2),
          uncertainty: Math.max(1, Math.round(span / 2)),
          matchKey: 'stop_id',
          spanSec: span,
        };
      }
      // No approach observation to bracket against. Fall back to the reassignment
      // timestamp alone, with uncertainty wide enough to admit the lag.
      return {
        source: 'stopped_at_turnaround',
        actual: t2,
        uncertainty: TURNAROUND_UNBRACKETED_UNCERTAINTY_SEC,
        matchKey: 'stop_id',
        spanSec: null,
      };
    }
  }

  // 3. Never seen stopped, but observations bracket the target sequence.
  //    Midpoint of the bracket; uncertainty is half its width — computed, not
  //    assumed, so a wide bracket honestly reports itself as imprecise.
  const before = ownTrip
    .filter((o) => o.current_stop_sequence !== null && o.current_stop_sequence <= target)
    .sort((a, b) => b.vehicle_updated_at - a.vehicle_updated_at);
  const after = ownTrip
    .filter((o) => o.current_stop_sequence !== null && o.current_stop_sequence > target)
    .sort((a, b) => a.vehicle_updated_at - b.vehicle_updated_at);

  if (before.length > 0 && after.length > 0) {
    const t1 = before[0].vehicle_updated_at;
    const t2 = after[0].vehicle_updated_at;
    if (t2 >= t1) {
      const span = t2 - t1;
      return {
        source: 'sequence_advanced',
        actual: Math.round((t1 + t2) / 2),
        uncertainty: Math.max(1, Math.round(span / 2)),
        matchKey: 'stop_sequence',
        spanSec: span,
      };
    }
  }

  // 4. MBTA told us it would not be served. runMatch checks this first, so
  //    reaching it here means a skip flag appeared without observational
  //    evidence to outrank it; kept so resolveArrival is correct standalone.
  if (isSkipped(candidate.lastSnapshot)) {
    return { source: 'skipped', actual: null, uncertainty: null, matchKey: null, spanSec: null };
  }

  // 5. Predictions existed, then stopped, and no vehicle evidence explains it.
  //    Never dropped: this is the outcome a rider experiences as a train that
  //    simply never came, and excluding it would make every average optimistic.
  return {
    source: 'unresolved_dropout',
    actual: null,
    uncertainty: null,
    matchKey: null,
    spanSec: null,
  };
}

// --- run --------------------------------------------------------------------

export async function runMatch(
  env: Env,
  startedAtMs: number,
  opts: { full?: boolean } = {},
): Promise<MatchStats> {
  const now = Math.floor(startedAtMs / 1000);
  const stats: MatchStats = {
    scanned_rows: 0,
    candidates: 0,
    settled: 0,
    unsettled: 0,
    upserts_attempted: 0,
    implausible: 0,
    by_source: {},
    turnaround_spans: [],
    turnaround_unbracketed: 0,
    watermark_before: 0,
    watermark_after: 0,
    duration_ms: 0,
    error: null,
  };

  try {
    const watermark = opts.full ? 0 : await readWatermark(env.DB);
    stats.watermark_before = watermark;

    const termini = new Set<string>(
      (
        await env.DB.prepare(
          "SELECT DISTINCT stop_id FROM watched_stops WHERE stop_role = 'terminus'",
        ).all<{ stop_id: string }>()
      ).results?.map((r) => r.stop_id) ?? [],
    );

    const { results: rows } = await env.DB.prepare(
      `SELECT id, service_date, trip_id, stop_sequence, stop_id, route_id, direction_id,
              observed_at, predicted_arrival, predicted_departure, schedule_relationship,
              status, vehicle_id
         FROM prediction_snapshots WHERE id > ? ORDER BY id LIMIT ?`,
    )
      .bind(watermark, SCAN_LIMIT)
      .all<SnapshotRow>();

    stats.scanned_rows = rows?.length ?? 0;
    if (!rows || rows.length === 0) {
      stats.watermark_after = watermark;
      return finish(stats, startedAtMs);
    }

    const candidates = groupCandidates(rows);
    stats.candidates = candidates.size;

    const settled: Candidate[] = [];
    // The watermark may only advance past rows belonging to candidates we have
    // finished with. Anything still in flight must be re-read next run, so the
    // watermark stops just short of the earliest unsettled row.
    let firstUnsettledRowId = Number.POSITIVE_INFINITY;

    for (const c of candidates.values()) {
      const settledEnough =
        c.lastPredictedArrival !== null && c.lastPredictedArrival < now - SETTLE_SEC;
      // A departure-only prediction never gets an arrival time, so waiting for one
      // would pin the watermark forever. Settle it on the last snapshot instead.
      const departureOnly =
        c.lastPredictedArrival === null && c.lastSnapshot.observed_at < now - SETTLE_SEC;

      if (settledEnough || departureOnly) settled.push(c);
      else {
        stats.unsettled++;
        firstUnsettledRowId = Math.min(firstUnsettledRowId, c.minRowId);
      }
    }
    stats.settled = settled.length;

    if (settled.length > 0) {
      const observations = await loadObservations(env.DB, settled);
      const upserts: D1PreparedStatement[] = [];

      for (const c of settled) {
        let resolution: Resolution;
        if (isSkipped(c.lastSnapshot)) {
          // CHECKED FIRST, ahead of the null-arrival shortcut. A CANCELLED or
          // SKIPPED stop usually carries no arrival time either, so testing for a
          // null arrival first would file it as 'no_arrival_predicted' and quietly
          // drop it out of the unfulfilled denominator. It is unfulfilled: MBTA
          // said a train was coming and then said it was not.
          //
          // This is not hypothetical — it shipped. 22 CANCELLED stops were
          // misfiled this way, understating the unfulfilled rate as 6.2% when it
          // was 8.0%.
          resolution = {
            source: 'skipped',
            actual: null,
            uncertainty: null,
            matchKey: null,
            spanSec: null,
          };
        } else if (c.lastPredictedArrival === null) {
          // Un-promised, not unfulfilled: a departure-only prediction, typically at
          // an origin terminus. Recorded so the distinction is visible rather than
          // inferred from an absent row.
          resolution = {
            source: 'no_arrival_predicted',
            actual: null,
            uncertainty: null,
            matchKey: null,
            spanSec: null,
          };
        } else {
          const key = `${c.service_date}|${c.trip_id}`;
          resolution = resolveArrival(c, observations.get(key) ?? [], termini.has(c.stop_id));
        }

        stats.by_source[resolution.source] = (stats.by_source[resolution.source] ?? 0) + 1;
        const flagged = isImplausible(resolution.actual, c.lastPredictedArrival);
        if (flagged) {
          stats.implausible++;
          console.warn('implausible match — flagged, not dropped', {
            trip_id: c.trip_id,
            stop_id: c.stop_id,
            source: resolution.source,
            actual: resolution.actual,
            last_predicted: c.lastPredictedArrival,
          });
        }
        if (resolution.source === 'stopped_at_turnaround') {
          if (resolution.spanSec === null) stats.turnaround_unbracketed++;
          else stats.turnaround_spans.push(resolution.spanSec);
        }
        upserts.push(upsertArrival(env.DB, c, resolution, now, flagged));
      }

      for (let i = 0; i < upserts.length; i += 50) {
        await env.DB.batch(upserts.slice(i, i + 50));
      }
      stats.upserts_attempted = upserts.length;
    }

    const lastScanned = rows[rows.length - 1].id;
    const newWatermark = Number.isFinite(firstUnsettledRowId)
      ? Math.min(lastScanned, firstUnsettledRowId - 1)
      : lastScanned;
    // Never move backwards, even if the earliest unsettled row precedes the
    // watermark we started from.
    stats.watermark_after = Math.max(watermark, newWatermark);
    if (stats.watermark_after !== watermark) {
      await writeWatermark(env.DB, stats.watermark_after, now);
    }
  } catch (err) {
    stats.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('matcher run failed', stats.error);
  }

  return finish(stats, startedAtMs);
}

function finish(stats: MatchStats, startedAtMs: number): MatchStats {
  stats.duration_ms = Date.now() - startedAtMs;
  return stats;
}

/**
 * Load vehicle observations for the settled candidates' trips, plus any
 * observation by the same vehicles at the same stops (which is how a terminus
 * turnaround is found, since it is filed under a different trip_id).
 */
async function loadObservations(
  db: D1Database,
  settled: Candidate[],
): Promise<Map<string, ObservationRow[]>> {
  const dates = [...new Set(settled.map((c) => c.service_date))];
  const vehicles = [...new Set(settled.flatMap((c) => [...c.vehicleIds]))];
  const trips = [...new Set(settled.map((c) => c.trip_id))];

  const out = new Map<string, ObservationRow[]>();
  if (dates.length === 0) return out;

  // Bound the read by service_date, then filter in memory. vehicle_observations
  // has no secondary index either, so a scan restricted to the dates in play is
  // cheaper than one round trip per candidate.
  const datePlaceholders = dates.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT service_date, trip_id, vehicle_id, stop_id, current_status,
              current_stop_sequence, vehicle_updated_at
         FROM vehicle_observations WHERE service_date IN (${datePlaceholders})`,
    )
    .bind(...dates)
    .all<ObservationRow>();

  const tripSet = new Set(trips);
  const vehicleSet = new Set(vehicles);

  for (const o of results ?? []) {
    const relevant =
      (o.trip_id !== null && tripSet.has(o.trip_id)) || vehicleSet.has(o.vehicle_id);
    if (!relevant) continue;
    // Indexed by the candidate's trip. A turnaround observation carries a
    // different trip_id, so it is filed under every candidate trip run by that
    // vehicle on the day and filtered again at resolution time.
    for (const c of settled) {
      if (c.service_date !== o.service_date) continue;
      const matches = o.trip_id === c.trip_id || c.vehicleIds.has(o.vehicle_id);
      if (!matches) continue;
      const key = `${c.service_date}|${c.trip_id}`;
      const list = out.get(key);
      if (list) list.push(o);
      else out.set(key, [o]);
    }
  }
  return out;
}

/**
 * Upsert with a confidence guard.
 *
 * The WHERE clause on DO UPDATE is what makes re-running safe: a stored
 * 'stopped_at' is never replaced by a later 'unresolved_dropout' just because a
 * backfill scanned the same rows again. Re-running can only improve a row.
 */
function upsertArrival(
  db: D1Database,
  c: Candidate,
  r: Resolution,
  now: number,
  implausible: boolean,
): D1PreparedStatement {
  const confidence = CONFIDENCE[r.source] ?? 0;
  const cases = Object.entries(CONFIDENCE)
    .map(([source, rank]) => `WHEN '${source}' THEN ${rank}`)
    .join(' ');

  return db
    .prepare(
      `INSERT INTO arrivals
         (service_date, trip_id, stop_id, stop_sequence, route_id, direction_id,
          actual_arrival_at, source, uncertainty_sec, matched_at, match_key,
          evidence_span_sec, implausible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(service_date, trip_id, stop_id) DO UPDATE SET
         actual_arrival_at = excluded.actual_arrival_at,
         source            = excluded.source,
         uncertainty_sec   = excluded.uncertainty_sec,
         stop_sequence     = excluded.stop_sequence,
         route_id          = excluded.route_id,
         direction_id      = excluded.direction_id,
         matched_at        = excluded.matched_at,
         match_key         = excluded.match_key,
         evidence_span_sec = excluded.evidence_span_sec,
         implausible       = excluded.implausible
       WHERE ? > (CASE arrivals.source ${cases} ELSE 0 END)
          OR (? = (CASE arrivals.source ${cases} ELSE 0 END)
              AND excluded.uncertainty_sec IS NOT NULL
              AND (arrivals.uncertainty_sec IS NULL
                   OR excluded.uncertainty_sec < arrivals.uncertainty_sec))`,
    )
    .bind(
      c.service_date,
      c.trip_id,
      c.stop_id,
      c.stop_sequence,
      c.route_id,
      c.direction_id,
      r.actual,
      r.source,
      r.uncertainty,
      now,
      r.matchKey,
      r.spanSec,
      implausible ? 1 : 0,
      confidence,
      confidence,
    );
}

/** Manual backfill: repeat until the scan stops advancing. */
export async function runBackfill(env: Env, maxPasses = 40): Promise<MatchStats[]> {
  const passes: MatchStats[] = [];
  let previous = -1;
  for (let i = 0; i < maxPasses; i++) {
    const stats = await runMatch(env, Date.now(), { full: i === 0 });
    passes.push(stats);
    if (stats.error) break;
    if (stats.watermark_after === previous || stats.scanned_rows === 0) break;
    previous = stats.watermark_after;
  }
  return passes;
}

export const __test = { groupCandidates, resolveArrival, isSkipped, isImplausible, serviceDate };
