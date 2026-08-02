// One cron tick: poll MBTA, dedup against stored state, append what changed.
//
// The collector's only job is to capture data that is otherwise lost forever.
// Predictions are ephemeral — once MBTA overwrites one, the old value is gone.
// So this file favours "record it and move on" over "get it perfectly right":
// nothing here interprets the data, and nothing here computes an error. That is
// the matcher's job, and the matcher can be rerun. This cannot.

import {
  MbtaClient,
  MbtaError,
  attrArray,
  attrNumber,
  attrString,
  epochSec,
  indexIncluded,
  parentStationMap,
  relId,
  type Document,
} from './mbta';
import { localHour, serviceDate } from './service-date';
import { claimState, loadState, pruneState, releaseState, type DedupState } from './state';

export interface Env {
  DB: D1Database;
  MBTA_API_KEY?: string;
  /** If set, enables POST /collect?token=… to trigger a tick by hand. */
  COLLECT_TOKEN?: string;
}

export interface RunRecord {
  started_at: number;
  duration_ms: number;
  predictions_seen: number;
  snapshots_written: number;
  vehicles_seen: number;
  vehicle_rows_written: number;
  api_status: number | null;
  error: string | null;
  /** See classifyError. 'd1_limit' is the one that means we are losing data. */
  error_kind: ErrorKind | null;
  /**
   * Total D1 rows this tick wrote, including the dedup-state upsert, this run
   * row itself, and any rows the daily prune deleted. This is the number the
   * free-tier budget is spent in, so it is recorded rather than re-derived.
   */
  rows_written: number;
  /**
   * '<stop>|<route>|<direction>' -> predictions seen this tick, with an explicit
   * 0 for every watched slice that returned none. The zero is the point: it is
   * what distinguishes "this slice is suspended" from "the collector is broken".
   */
  per_slice_counts: Record<string, number>;
  /**
   * Not persisted — collector_runs has no column for these, deliberately.
   * Alerts are low-volume and alert_snapshots can be read directly. These exist
   * for the /collect response and logs.
   */
  alerts_seen: number;
  alert_rows_written: number;
  /**
   * Predictions observed and tracked (dedup state and `revision` both updated)
   * but not written, because their horizon exceeded MAX_STORED_HORIZON_SEC.
   * Not persisted; present so a deploy can be verified against the expected
   * drop in writes/tick.
   */
  horizon_suppressed: number;
  /**
   * True when another invocation held the dedup state row and this tick stood
   * down rather than clobbering it. Persisted, so /status can distinguish a
   * deploy-boundary artefact from an ongoing problem.
   */
  concurrent_tick: boolean;
}

export type ErrorKind = 'd1_limit' | 'd1_other' | 'mbta_api' | 'timeout' | 'other';

/**
 * Substrings that mean "D1 refused this write because of a limit" rather than
 * "D1 could not run this query".
 *
 * D1 does not expose a stable machine-readable code through the Workers binding,
 * so this is necessarily a heuristic over message text. It is deliberately broad:
 * a false positive costs a misleading label on a row whose raw `error` text is
 * still there, while a false negative hides the one failure mode that silently
 * destroys unrecoverable data.
 */
const D1_LIMIT_MARKERS = [
  'daily limit',
  'exceeded',
  'quota',
  'too many requests',
  'rate limit',
  'storage limit',
  'database is full',
  'over capacity',
  '429',
];

/**
 * Markers for "D1 ran and refused" as opposed to "D1 was over a limit".
 * Confirmed against live D1 error text, which does not reliably carry a
 * 'D1_ERROR' prefix.
 */
const D1_OTHER_MARKERS = [
  'd1_error',
  'sqlite_error',
  'sqlite_constraint',
  'no such table',
  'no such column',
  'has no column named',
  'unique constraint',
];

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof MbtaError) return 'mbta_api';

  const name = err instanceof Error ? err.name : '';
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (name === 'TimeoutError' || name === 'AbortError' || message.includes('timed out')) {
    return 'timeout';
  }
  if (D1_LIMIT_MARKERS.some((m) => message.includes(m))) return 'd1_limit';
  // Checked after the limit markers: a limit failure also mentions D1, and the
  // limit label is the more useful of the two.
  //
  // The marker list is wider than 'D1_ERROR' because that prefix is not
  // guaranteed. Verified against real failures: a bad column surfaces as
  // "table X has no column named Y: SQLITE_ERROR" with no D1 prefix at all.
  if (D1_OTHER_MARKERS.some((m) => message.includes(m))) return 'd1_other';
  return 'other';
}

interface WatchedStop {
  stop_id: string;
  route_id: string;
  direction_id: number;
}

/**
 * How long we keep recording a vehicle's state changes after it was last seen
 * at a watched stop.
 *
 * Why this exists: at 60-second polling we will sometimes miss STOPPED_AT
 * entirely, because subway dwell time is often shorter than our poll interval.
 * The evidence that the train nonetheless served the stop is the *next*
 * observation, where current_stop_sequence has advanced past it. That is the
 * `sequence_advanced` arrival source. Without lingering we would never capture
 * it and those arrivals would degrade to `unresolved_dropout`.
 */
const VEHICLE_LINGER_SEC = 300;

/** collector_runs retention, per CLAUDE.md. */
const RUN_RETENTION_SEC = 7 * 86_400;

/**
 * D1 caps bound parameters per query. We stay well under the documented 100 so
 * that adding a column later cannot silently push a statement over the edge.
 */
const MAX_BOUND_PARAMS = 80;

/**
 * Longest prediction horizon we store a snapshot for, in seconds (20 minutes).
 *
 * Measured against 14,806 collected rows: 8,813 were predictions more than 20
 * minutes out — 63.2% of the rows that carry a horizon at all, or 59.5% of every
 * row once the 868 NULL-horizon rows are included in the denominator. Either way
 * they dominate the write budget while carrying the least information: a
 * 45-minute-out estimate is close to a restatement of the timetable, and it will
 * be revised many times before it means anything.
 *
 * Expected effect, from the same sample: 40.5% of rows survive the cap
 * (34.6% within the window plus 5.9% NULL horizon), taking ~51 writes/tick to
 * ~21.
 *
 * THIS IS A SCOPING DECISION, NOT A SAMPLING ONE. It declares a range of
 * interest — the last 20 minutes before arrival — and keeps *complete* fidelity
 * inside that range: every revision, at full resolution, with an unbroken
 * revision count. It does not thin, average, or subsample anything within the
 * window. A prediction outside the window is out of scope, not sampled away.
 *
 * Contrast with the jitter threshold considered and rejected (see README): that
 * would have degraded fidelity *within* the range of interest by discarding
 * sub-threshold revisions, making stored values slightly stale and changing what
 * `revision` counts. This changes neither.
 *
 * The cap gates the WRITE only. Dedup state and `revision` are still updated for
 * every observed change at every horizon, so `revision` continues to mean "total
 * times MBTA revised this arrival" rather than "times since it entered the
 * window". Those are different features and the November model needs the former.
 */
const MAX_STORED_HORIZON_SEC = 1200;

/**
 * Collapse many single-row inserts into few multi-row inserts.
 *
 * This is a CPU optimisation, not a write-count one — D1 bills rows written, so
 * the cost to the free tier is identical either way. But each prepared statement
 * costs roughly 0.1ms of CPU to bind, and the Workers free plan allows 10ms per
 * invocation. Measured: 48 single-row statements ran at 7ms; the same data as
 * multi-row inserts runs at a fraction of that.
 *
 * Ordering within the batch is preserved, which matters because the dedup-state
 * write must land in the same transaction as the rows it describes.
 */
function chunkedInserts(
  db: D1Database,
  table: string,
  columns: string[],
  rows: unknown[][],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];

  const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < rows.length; i += perStatement) {
    const slice = rows.slice(i, i + perStatement);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${slice.map(() => tuple).join(', ')}`;
    statements.push(db.prepare(sql).bind(...slice.flat()));
  }
  return statements;
}

const PREDICTION_COLUMNS = [
  'observed_at',
  'service_date',
  'trip_id',
  'stop_sequence',
  'route_id',
  'direction_id',
  'stop_id',
  'predicted_arrival',
  'predicted_departure',
  'horizon_sec',
  'schedule_relationship',
  'status',
  'revision',
  'vehicle_id',
  'vehicle_status',
  'vehicle_stop_sequence',
  'scheduled_arrival',
  // Properties of the prediction rather than of this snapshot, repeated on every
  // row it produces. Free: D1 bills rows written, not columns.
  'first_seen_at',
  'first_predicted_arrival',
];

const VEHICLE_COLUMNS = [
  'observed_at',
  'vehicle_updated_at',
  'service_date',
  'vehicle_id',
  'trip_id',
  'route_id',
  'direction_id',
  'current_status',
  'current_stop_sequence',
  'stop_id',
];

const ALERT_COLUMNS = [
  'observed_at',
  'service_date',
  'alert_id',
  'mbta_updated_at',
  'effect',
  'cause',
  'severity',
  'lifecycle',
  'header',
  'active_period_start',
  'active_period_end',
  'active_periods_json',
  'affected_routes',
  'affected_stops',
  'affects_watched',
];

export async function runTick(env: Env, startedAtMs: number): Promise<RunRecord> {
  const observedAt = Math.floor(startedAtMs / 1000);
  const run: RunRecord = {
    started_at: observedAt,
    duration_ms: 0,
    predictions_seen: 0,
    snapshots_written: 0,
    vehicles_seen: 0,
    vehicle_rows_written: 0,
    api_status: null,
    error: null,
    error_kind: null,
    rows_written: 0,
    per_slice_counts: {},
    alerts_seen: 0,
    alert_rows_written: 0,
    horizon_suppressed: 0,
    concurrent_tick: false,
  };

  try {
    const watched = await loadWatchedStops(env.DB);
    if (watched.length === 0) {
      run.error = 'no active rows in watched_stops';
      return await finish(env, run, startedAtMs);
    }

    const stopIds = unique(watched.map((w) => w.stop_id));
    const routeIds = unique(watched.map((w) => w.route_id));
    // '<stop>|<route>|<direction>' — the exact slices we are allowed to record.
    const slices = new Set(watched.map((w) => `${w.stop_id}|${w.route_id}|${w.direction_id}`));

    const client = new MbtaClient(env.MBTA_API_KEY);

    // The prediction and vehicle feeds must come from the same tick: the vehicle
    // state we attach to a prediction is meant to describe where the train was
    // when that prediction was made.
    const [predictionDoc, vehicleDoc, alertDoc] = await Promise.all([
      client.get('/predictions', {
        'filter[stop]': stopIds.join(','),
        'filter[route]': routeIds.join(','),
        // `schedule` gives scheduled_arrival with no extra request and no cache.
        // `stop` gives the parent_station backlink we need to normalise stop ids.
        include: 'stop,schedule',
      }),
      client.get('/vehicles', {
        'filter[route]': routeIds.join(','),
        include: 'stop',
      }),
      // Alerts are fetched in parallel but their failure is NON-FATAL. Predictions
      // are the unrecoverable data; losing a tick of them because the alerts
      // endpoint was slow would be a bad trade. An alert we miss now is still
      // described by its own active_period when we next see it.
      client.get('/alerts', { 'filter[route]': routeIds.join(',') }).catch((err: unknown) => {
        console.error('alerts fetch failed (non-fatal)', err);
        return null;
      }),
    ]);
    run.api_status = 200;

    const parents = parentStationMap(predictionDoc, vehicleDoc);
    const loaded = await loadState(env.DB, serviceDate(observedAt));
    const state = loaded.state;
    // Snapshotted before we mutate `state`, so a failed batch can be rolled back
    // to exactly what the database held when we read it.
    const stateBeforeTick = JSON.stringify(state);

    const statements: D1PreparedStatement[] = [];

    const predictions = collectPredictions(
      predictionDoc,
      vehicleDoc,
      parents,
      slices,
      state,
      observedAt,
    );
    run.predictions_seen = predictions.seen;
    run.snapshots_written = predictions.rows.length;
    run.per_slice_counts = predictions.perSlice;
    run.horizon_suppressed = predictions.horizonSuppressed;
    statements.push(
      ...chunkedInserts(env.DB, 'prediction_snapshots', PREDICTION_COLUMNS, predictions.rows),
    );

    const vehicles = collectVehicles(vehicleDoc, parents, slices, state, observedAt);
    run.vehicles_seen = vehicles.seen;
    run.vehicle_rows_written = vehicles.rows.length;
    statements.push(
      ...chunkedInserts(env.DB, 'vehicle_observations', VEHICLE_COLUMNS, vehicles.rows),
    );

    if (alertDoc) {
      const alerts = collectAlerts(alertDoc, watched, slices, state, observedAt);
      run.alerts_seen = alerts.seen;
      run.alert_rows_written = alerts.rows.length;
      statements.push(...chunkedInserts(env.DB, 'alert_snapshots', ALERT_COLUMNS, alerts.rows));
    }

    pruneState(state, observedAt);

    // Claim the state row by compare-and-set BEFORE writing any data rows. If
    // another invocation has moved it since we read it, that invocation owns this
    // minute: stand down and write nothing rather than duplicate its rows and
    // overwrite its revision increments.
    const claim = await claimState(env.DB, state, observedAt, loaded.updatedAt);
    if (!claim.won) {
      run.concurrent_tick = true;
      run.snapshots_written = 0;
      run.vehicle_rows_written = 0;
      run.alert_rows_written = 0;
      console.warn('concurrent tick detected; standing down', {
        started_at: observedAt,
        state_updated_at: loaded.updatedAt,
      });
      return await finish(env, run, startedAtMs);
    }

    try {
      // A tick where every prediction was unchanged or out of window has nothing
      // to write. D1 rejects an empty batch outright ("No SQL statements
      // detected"), and the claim above has already persisted the dedup touches,
      // so there is genuinely nothing left to do.
      if (statements.length > 0) {
        // One round trip, one transaction: this tick's snapshots either all land
        // or none do.
        await env.DB.batch(statements);
      }
    } catch (batchErr) {
      // We hold the claim but could not honour it. Put the state back, or the
      // next tick will believe these snapshots were stored and skip them.
      await releaseState(env.DB, stateBeforeTick, loaded.updatedAt, claim.updatedAt).catch(
        (releaseErr: unknown) => console.error('failed to release state claim', releaseErr),
      );
      throw batchErr;
    }

    // Counted only after the batch commits. On failure none of it landed, so
    // charging it to the budget would overstate our own consumption.
    // +1 for the state claim.
    run.rows_written =
      run.snapshots_written + run.vehicle_rows_written + run.alert_rows_written + 1;

    if (shouldPrune(observedAt)) {
      // Deletes count against the write quota exactly like inserts do.
      const pruned = await env.DB.prepare('DELETE FROM collector_runs WHERE started_at < ?')
        .bind(observedAt - RUN_RETENTION_SEC)
        .run();
      run.rows_written += pruned.meta?.changes ?? 0;
    }
  } catch (err) {
    run.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    run.error_kind = classifyError(err);
    if (err instanceof MbtaError) run.api_status = err.status;
    // Logged as well as stored, because the failure that matters most — D1
    // refusing writes — is exactly the one that can stop the row below from
    // being written at all. Workers observability sees this without touching D1.
    console.error(`tick failed [${run.error_kind}]`, run.error);
  }

  return await finish(env, run, startedAtMs);
}

/**
 * Record the run no matter what happened. A tick that failed and left no trace
 * is indistinguishable from a tick that never fired; this table is the only
 * thing that makes gaps in collection visible.
 */
async function finish(env: Env, run: RunRecord, startedAtMs: number): Promise<RunRecord> {
  run.duration_ms = Date.now() - startedAtMs;
  try {
    await env.DB.prepare(
      `INSERT INTO collector_runs
         (started_at, duration_ms, predictions_seen, snapshots_written,
          vehicles_seen, vehicle_rows_written, api_status, error, per_slice_counts,
          alert_rows_written, rows_written, error_kind, concurrent_tick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        run.started_at,
        run.duration_ms,
        run.predictions_seen,
        run.snapshots_written,
        run.vehicles_seen,
        run.vehicle_rows_written,
        run.api_status,
        run.error,
        // NULL rather than '{}' when the tick failed before counting anything, so
        // "we counted zero everywhere" stays distinguishable from "we never got
        // far enough to count".
        Object.keys(run.per_slice_counts).length ? JSON.stringify(run.per_slice_counts) : null,
        run.alert_rows_written,
        // +1 for this row. Charged whether or not the batch above committed,
        // because this INSERT is itself a write against the daily quota.
        run.rows_written + 1,
        run.error_kind,
        run.concurrent_tick ? 1 : 0,
      )
      .run();
    run.rows_written += 1;
  } catch (err) {
    // If even this fails, D1 is refusing writes outright — which is precisely the
    // budget-exhaustion case. There is no way to record it in the database, so
    // console is the only channel left. /status detects it as staleness instead.
    const kind = classifyError(err);
    console.error(`failed to write collector_runs row [${kind}]`, err);
  }
  return run;
}

async function loadWatchedStops(db: D1Database): Promise<WatchedStop[]> {
  const { results } = await db
    .prepare('SELECT stop_id, route_id, direction_id FROM watched_stops WHERE active = 1')
    .all<WatchedStop>();
  return results ?? [];
}

// --- predictions ------------------------------------------------------------

function collectPredictions(
  doc: Document,
  vehicleDoc: Document,
  parents: Map<string, string>,
  slices: Set<string>,
  state: DedupState,
  observedAt: number,
): {
  seen: number;
  rows: unknown[][];
  perSlice: Record<string, number>;
  horizonSuppressed: number;
} {
  const schedules = indexIncluded(doc, 'schedule');
  const vehicles = new Map(vehicleDoc.data.map((v) => [v.id, v]));

  // Seeded with every watched slice at zero, before looking at the feed. A slice
  // that returns nothing must appear as an explicit 0 rather than be absent —
  // an absent key is ambiguous between "no service" and "not watched".
  const perSlice: Record<string, number> = {};
  for (const slice of slices) perSlice[slice] = 0;

  const rows: unknown[][] = [];
  const sd = serviceDate(observedAt);
  let seen = 0;
  let horizonSuppressed = 0;

  for (const p of doc.data) {
    const tripId = relId(p, 'trip');
    const stopSequence = attrNumber(p, 'stop_sequence');
    const routeId = relId(p, 'route');
    const rawStopId = relId(p, 'stop');

    // (service_date, trip_id, stop_sequence) is the prediction's identity. A row
    // missing any part of it cannot be deduplicated or later matched, so it is
    // not worth a write.
    if (!tripId || stopSequence === null || !routeId || !rawStopId) continue;

    const stopId = parents.get(rawStopId) ?? rawStopId;
    const directionId = attrNumber(p, 'direction_id');
    const slice = `${stopId}|${routeId}|${directionId}`;
    if (!slices.has(slice)) continue;
    seen++;
    perSlice[slice] = (perSlice[slice] ?? 0) + 1;

    const predictedArrival = epochSec(attrString(p, 'arrival_time'));
    const predictedDeparture = epochSec(attrString(p, 'departure_time'));
    const scheduleRelationship = attrString(p, 'schedule_relationship');
    const status = attrString(p, 'status');

    // Fingerprint = the promise itself. Vehicle position is deliberately NOT in
    // here: it changes on almost every tick, so including it would mean writing
    // every prediction every minute and dedup would buy nothing. Vehicle state is
    // context attached to whatever snapshot we do write, not a trigger for one.
    const fingerprint = [
      predictedArrival,
      predictedDeparture,
      scheduleRelationship,
      status,
      stopId,
    ].join('|');

    const key = `${tripId}|${stopSequence}`;
    const previous = state.p[key];
    if (previous && previous[0] === fingerprint) {
      previous[2] = observedAt; // still live; keep it out of the prune
      continue;
    }
    const revision = previous ? previous[1] + 1 : 1;

    // Captured on the very first observation at ANY horizon and then carried
    // forward unchanged. The horizon cap means the first row we STORE is usually
    // not the first time we SAW this prediction, so without this MBTA's original
    // estimate is lost — the thing this project is trying to measure movement
    // against.
    //
    // A pre-0004 state entry has length 3 and cannot tell us when it was first
    // seen. Those stamp NULL rather than pretending the current tick was the
    // first; they age out within an hour of deploy.
    let firstSeenAt: number | null;
    let firstPredictedArrival: number | null;
    if (!previous) {
      firstSeenAt = observedAt;
      firstPredictedArrival = predictedArrival;
    } else if (previous.length === 5) {
      firstSeenAt = previous[3];
      firstPredictedArrival = previous[4];
    } else {
      firstSeenAt = null;
      firstPredictedArrival = null;
    }

    state.p[key] = [fingerprint, revision, observedAt, firstSeenAt, firstPredictedArrival];

    // ---- horizon cap -------------------------------------------------------
    // Everything above this line is TRACKING and runs at every horizon. Only the
    // row insert below is gated. That ordering is the whole point: `revision`
    // must keep counting every revision MBTA ever made to this arrival, not just
    // the ones we chose to store. Moving this check any earlier would silently
    // redefine that feature.
    //
    // A NULL horizon means the prediction carries no arrival time at all — a
    // skipped stop, a cancelled trip, a vehicle that will not serve this stop.
    // Those are rare and they are the interesting failures, so they are always
    // written.
    const horizonSec = predictedArrival === null ? null : predictedArrival - observedAt;
    if (horizonSec !== null && horizonSec > MAX_STORED_HORIZON_SEC) {
      horizonSuppressed++;
      continue;
    }

    const vehicle = vehicles.get(relId(p, 'vehicle') ?? '') ?? null;
    const schedule = schedules.get(relId(p, 'schedule') ?? '') ?? null;

    rows.push([
      observedAt,
      sd,
      tripId,
      stopSequence,
      routeId,
      directionId,
      stopId,
      predictedArrival,
      predictedDeparture,
      // Signed on purpose. Negative means the promised time has already passed
      // and MBTA is still showing the prediction — real, and worth keeping.
      horizonSec,
      scheduleRelationship,
      status,
      revision,
      vehicle?.id ?? null,
      vehicle ? attrString(vehicle, 'current_status') : null,
      vehicle ? attrNumber(vehicle, 'current_stop_sequence') : null,
      schedule ? epochSec(attrString(schedule, 'arrival_time')) : null,
      firstSeenAt,
      firstPredictedArrival,
    ]);
  }

  return { seen, rows, perSlice, horizonSuppressed };
}

// --- vehicles ---------------------------------------------------------------

function collectVehicles(
  doc: Document,
  parents: Map<string, string>,
  slices: Set<string>,
  state: DedupState,
  observedAt: number,
): { seen: number; rows: unknown[][] } {
  const rows: unknown[][] = [];
  const sd = serviceDate(observedAt);
  let seen = 0;

  for (const v of doc.data) {
    const currentStatus = attrString(v, 'current_status');
    const updatedAt = epochSec(attrString(v, 'updated_at'));
    if (!currentStatus || updatedAt === null) continue;
    seen++;

    const rawStopId = relId(v, 'stop');
    const stopId = rawStopId ? (parents.get(rawStopId) ?? rawStopId) : null;
    const routeId = relId(v, 'route');
    const directionId = attrNumber(v, 'direction_id');

    // A vehicle's `stop` is the stop it is IN_TRANSIT_TO / INCOMING_AT /
    // STOPPED_AT, so this is true from the moment it starts approaching.
    const atWatchedStop =
      stopId !== null && routeId !== null && slices.has(`${stopId}|${routeId}|${directionId}`);

    const previous = state.h[v.id];
    const lingerUntil = previous?.[2] ?? 0;
    if (!atWatchedStop && observedAt >= lingerUntil) {
      // Somewhere else on the line. Recording every state change of every train
      // on the Orange and Green-E lines would cost ~86,000 writes/day on its own,
      // and none of it is evidence about our stops.
      continue;
    }

    const fingerprint = [
      currentStatus,
      attrNumber(v, 'current_stop_sequence'),
      relId(v, 'trip'),
    ].join('|');
    const newLinger = atWatchedStop ? observedAt + VEHICLE_LINGER_SEC : lingerUntil;

    if (previous && previous[0] === fingerprint) {
      state.h[v.id] = [fingerprint, observedAt, newLinger];
      continue;
    }
    state.h[v.id] = [fingerprint, observedAt, newLinger];

    rows.push([
      observedAt,
      // MBTA's own timestamp for the state change, not our poll time. This is
      // what keeps arrival accuracy tighter than our 60-second resolution.
      updatedAt,
      sd,
      v.id,
      relId(v, 'trip'),
      routeId,
      directionId,
      currentStatus,
      attrNumber(v, 'current_stop_sequence'),
      stopId,
    ]);
  }

  return { seen, rows };
}

// --- alerts -----------------------------------------------------------------

interface InformedEntity {
  route?: string;
  stop?: string;
  direction_id?: number;
}

interface ActivePeriod {
  start?: string | null;
  end?: string | null;
}

/**
 * Alerts are what turn a zero-prediction period from "the collector broke" into
 * "the line was suspended, here is the notice". Deduplicated on content, so a
 * standing alert costs one row, not one row per minute.
 */
function collectAlerts(
  doc: Document,
  watched: WatchedStop[],
  slices: Set<string>,
  state: DedupState,
  observedAt: number,
): { seen: number; rows: unknown[][] } {
  const watchedRoutes = new Set(watched.map((w) => w.route_id));
  const watchedStops = new Set(watched.map((w) => w.stop_id));

  const rows: unknown[][] = [];
  const sd = serviceDate(observedAt);

  for (const a of doc.data) {
    const entities = attrArray<InformedEntity>(a, 'informed_entity');
    const periods = attrArray<ActivePeriod>(a, 'active_period');
    const { start, end } = selectPeriod(periods, observedAt);

    const lifecycle = attrString(a, 'lifecycle');
    const affectsWatched = alertAffectsWatched(entities, slices, watchedRoutes, watchedStops);
    const mbtaUpdatedAt = epochSec(attrString(a, 'updated_at'));

    // MBTA's own updated_at is the change signal. The selected period and
    // lifecycle are included because both can change with the passage of time
    // while updated_at stays put — an UPCOMING alert becoming ONGOING is a real
    // transition and should produce a row.
    const fingerprint = [mbtaUpdatedAt, start, end, lifecycle, affectsWatched ? 1 : 0].join('|');

    const previous = state.a[a.id];
    if (previous && previous[0] === fingerprint) {
      previous[1] = observedAt;
      continue;
    }
    state.a[a.id] = [fingerprint, observedAt];

    const routes = unique(entities.map((e) => e.route).filter((r): r is string => !!r));
    const stops = unique(entities.map((e) => e.stop).filter((s): s is string => !!s));

    rows.push([
      observedAt,
      sd,
      a.id,
      mbtaUpdatedAt,
      attrString(a, 'effect'),
      attrString(a, 'cause'),
      attrNumber(a, 'severity'),
      lifecycle,
      attrString(a, 'header'),
      start,
      end,
      JSON.stringify(periods),
      JSON.stringify(routes),
      JSON.stringify(stops),
      affectsWatched ? 1 : 0,
    ]);
  }

  return { seen: doc.data.length, rows };
}

/**
 * The period covering now; failing that the next one to start; failing that the
 * most recent one to have ended. An alert always gets a period recorded, so a
 * row is never left without a time context.
 */
function selectPeriod(
  periods: ActivePeriod[],
  observedAt: number,
): { start: number | null; end: number | null } {
  let upcoming: { start: number; end: number | null } | null = null;
  let past: { start: number; end: number | null } | null = null;

  for (const p of periods) {
    const start = epochSec(p.start ?? null);
    const end = epochSec(p.end ?? null);
    if (start === null) continue;
    // end === null means open-ended, which counts as still covering us.
    if (start <= observedAt && (end === null || end >= observedAt)) return { start, end };
    if (start > observedAt) {
      if (!upcoming || start < upcoming.start) upcoming = { start, end };
    } else if (!past || start > past.start) {
      past = { start, end };
    }
  }
  return upcoming ?? past ?? { start: null, end: null };
}

/**
 * Whether an alert touches anything we watch.
 *
 * informed_entity is progressively specific: a whole-route alert names only a
 * route, a station closure names a stop, and a directional diversion names
 * route + stop + direction. Each shape needs its own test — treating a missing
 * field as a non-match would silently miss line-wide suspensions, which are
 * exactly the ones that produce zero-prediction periods.
 */
function alertAffectsWatched(
  entities: InformedEntity[],
  slices: Set<string>,
  watchedRoutes: Set<string>,
  watchedStops: Set<string>,
): boolean {
  for (const e of entities) {
    const { route, stop } = e;
    const direction = typeof e.direction_id === 'number' ? e.direction_id : null;

    if (route && stop) {
      if (direction === null) {
        if (slices.has(`${stop}|${route}|0`) || slices.has(`${stop}|${route}|1`)) return true;
      } else if (slices.has(`${stop}|${route}|${direction}`)) {
        return true;
      }
    } else if (stop) {
      if (watchedStops.has(stop)) return true;
    } else if (route) {
      if (watchedRoutes.has(route)) return true;
    }
  }
  return false;
}

// --- helpers ----------------------------------------------------------------

/** Once a day, at 04:07 local — outside the 03:00 service-date rollover. */
function shouldPrune(observedAt: number): boolean {
  return localHour(observedAt) === 4 && Math.floor(observedAt / 60) % 60 === 7;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export const __test = {
  chunkedInserts,
  PREDICTION_COLUMNS,
  collectPredictions,
  collectVehicles,
  collectAlerts,
  selectPeriod,
  alertAffectsWatched,
  shouldPrune,
};
