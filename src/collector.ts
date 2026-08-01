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
  attrNumber,
  attrString,
  epochSec,
  indexIncluded,
  parentStationMap,
  relId,
  type Document,
} from './mbta';
import { localHour, serviceDate } from './service-date';
import { loadState, pruneState, saveStatement, type DedupState } from './state';

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

    // Both feeds must come from the same tick: the vehicle state we attach to a
    // prediction is meant to describe where the train was when that prediction
    // was made.
    const [predictionDoc, vehicleDoc] = await Promise.all([
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
    ]);
    run.api_status = 200;

    const parents = parentStationMap(predictionDoc, vehicleDoc);
    const state = await loadState(env.DB, serviceDate(observedAt));

    const statements: D1PreparedStatement[] = [];

    const predictions = collectPredictions(
      env.DB,
      predictionDoc,
      vehicleDoc,
      parents,
      slices,
      state,
      observedAt,
    );
    run.predictions_seen = predictions.seen;
    run.snapshots_written = predictions.statements.length;
    statements.push(...predictions.statements);

    const vehicles = collectVehicles(env.DB, vehicleDoc, parents, slices, state, observedAt);
    run.vehicles_seen = vehicles.seen;
    run.vehicle_rows_written = vehicles.statements.length;
    statements.push(...vehicles.statements);

    pruneState(state, observedAt);
    statements.push(saveStatement(env.DB, state, observedAt));

    // One round trip. D1 batch is a single implicit transaction, so either this
    // tick's snapshots and its dedup state both land, or neither does — the
    // state can never claim we recorded something we did not.
    await env.DB.batch(statements);

    if (shouldPrune(observedAt)) {
      await env.DB.prepare('DELETE FROM collector_runs WHERE started_at < ?')
        .bind(observedAt - RUN_RETENTION_SEC)
        .run();
    }
  } catch (err) {
    run.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (err instanceof MbtaError) run.api_status = err.status;
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
          vehicles_seen, vehicle_rows_written, api_status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
  } catch (err) {
    // If even this fails the database is unreachable; surface it in the logs.
    console.error('failed to write collector_runs row', err);
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
  db: D1Database,
  doc: Document,
  vehicleDoc: Document,
  parents: Map<string, string>,
  slices: Set<string>,
  state: DedupState,
  observedAt: number,
): { seen: number; statements: D1PreparedStatement[] } {
  const schedules = indexIncluded(doc, 'schedule');
  const vehicles = new Map(vehicleDoc.data.map((v) => [v.id, v]));

  const insert = db.prepare(
    `INSERT INTO prediction_snapshots
       (observed_at, service_date, trip_id, stop_sequence, route_id, direction_id, stop_id,
        predicted_arrival, predicted_departure, horizon_sec, schedule_relationship, status,
        revision, vehicle_id, vehicle_status, vehicle_stop_sequence, scheduled_arrival)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements: D1PreparedStatement[] = [];
  let seen = 0;

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
    if (!slices.has(`${stopId}|${routeId}|${directionId}`)) continue;
    seen++;

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
    state.p[key] = [fingerprint, revision, observedAt];

    const vehicle = vehicles.get(relId(p, 'vehicle') ?? '') ?? null;
    const schedule = schedules.get(relId(p, 'schedule') ?? '') ?? null;

    statements.push(
      insert.bind(
        observedAt,
        serviceDate(observedAt),
        tripId,
        stopSequence,
        routeId,
        directionId,
        stopId,
        predictedArrival,
        predictedDeparture,
        // Signed on purpose. Negative means the promised time has already passed
        // and MBTA is still showing the prediction — real, and worth keeping.
        predictedArrival === null ? null : predictedArrival - observedAt,
        scheduleRelationship,
        status,
        revision,
        vehicle?.id ?? null,
        vehicle ? attrString(vehicle, 'current_status') : null,
        vehicle ? attrNumber(vehicle, 'current_stop_sequence') : null,
        schedule ? epochSec(attrString(schedule, 'arrival_time')) : null,
      ),
    );
  }

  return { seen, statements };
}

// --- vehicles ---------------------------------------------------------------

function collectVehicles(
  db: D1Database,
  doc: Document,
  parents: Map<string, string>,
  slices: Set<string>,
  state: DedupState,
  observedAt: number,
): { seen: number; statements: D1PreparedStatement[] } {
  const insert = db.prepare(
    `INSERT INTO vehicle_observations
       (observed_at, vehicle_updated_at, service_date, vehicle_id, trip_id, route_id,
        direction_id, current_status, current_stop_sequence, stop_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements: D1PreparedStatement[] = [];
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

    statements.push(
      insert.bind(
        observedAt,
        // MBTA's own timestamp for the state change, not our poll time. This is
        // what keeps arrival accuracy tighter than our 60-second resolution.
        updatedAt,
        serviceDate(observedAt),
        v.id,
        relId(v, 'trip'),
        routeId,
        directionId,
        currentStatus,
        attrNumber(v, 'current_stop_sequence'),
        stopId,
      ),
    );
  }

  return { seen, statements };
}

// --- helpers ----------------------------------------------------------------

/** Once a day, at 04:07 local — outside the 03:00 service-date rollover. */
function shouldPrune(observedAt: number): boolean {
  return localHour(observedAt) === 4 && Math.floor(observedAt / 60) % 60 === 7;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export const __test = { collectPredictions, collectVehicles, shouldPrune };
