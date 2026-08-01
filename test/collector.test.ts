import { beforeEach, describe, expect, it } from 'vitest';
import { __test } from '../src/collector';
import { emptyState, type DedupState } from '../src/state';
import type { Document, Resource } from '../src/mbta';

const { collectPredictions, collectVehicles } = __test;

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T0 = at('2026-08-01T12:00:00-04:00');

/**
 * D1 stand-in. collectPredictions/collectVehicles only ever prepare a statement
 * and bind it, so the bound argument list is exactly what would hit the database.
 */
interface BoundStatement {
  args: unknown[];
}
const fakeDb = {
  prepare: () => ({ bind: (...args: unknown[]) => ({ args }) as BoundStatement }),
} as unknown as D1Database;

const argsOf = (s: unknown) => (s as BoundStatement).args;

// Column order matches the INSERT in collector.ts.
const P = {
  serviceDate: 1,
  tripId: 2,
  stopSequence: 3,
  stopId: 6,
  predictedArrival: 7,
  horizonSec: 9,
  revision: 12,
  vehicleId: 13,
  vehicleStopSequence: 15,
  scheduledArrival: 16,
} as const;
const V = {
  observedAt: 0,
  vehicleUpdatedAt: 1,
  vehicleId: 3,
  currentStatus: 7,
  currentStopSequence: 8,
  stopId: 9,
} as const;

// Ruggles: parent 'place-rugg', Orange Line southbound platform '70010'.
const SLICES = new Set(['place-rugg|Orange|0']);
const PARENTS = new Map([
  ['70010', 'place-rugg'],
  ['70011', 'place-rugg'],
  ['70279', 'place-astao'], // somewhere else on the Orange Line
]);

function prediction(overrides: {
  trip?: string;
  stopSequence?: number;
  stop?: string;
  route?: string;
  direction?: number;
  arrival?: string | null;
  vehicle?: string | null;
  schedule?: string | null;
}): Resource {
  const o = overrides;
  return {
    id: `prediction-${o.trip ?? 'trip1'}`,
    type: 'prediction',
    attributes: {
      arrival_time: o.arrival === undefined ? '2026-08-01T12:05:00-04:00' : o.arrival,
      departure_time: null,
      direction_id: o.direction ?? 0,
      schedule_relationship: null,
      status: null,
      stop_sequence: o.stopSequence ?? 140,
    },
    relationships: {
      trip: { data: { id: o.trip ?? 'trip1', type: 'trip' } },
      route: { data: { id: o.route ?? 'Orange', type: 'route' } },
      stop: { data: { id: o.stop ?? '70010', type: 'stop' } },
      ...(o.vehicle === null ? {} : { vehicle: { data: { id: o.vehicle ?? 'O-1', type: 'vehicle' } } }),
      ...(o.schedule ? { schedule: { data: { id: o.schedule, type: 'schedule' } } } : {}),
    },
  };
}

function vehicle(overrides: {
  id?: string;
  status?: string;
  stopSequence?: number;
  stop?: string | null;
  route?: string;
  direction?: number;
  updatedAt?: string;
  trip?: string;
}): Resource {
  const o = overrides;
  return {
    id: o.id ?? 'O-1',
    type: 'vehicle',
    attributes: {
      current_status: o.status ?? 'IN_TRANSIT_TO',
      current_stop_sequence: o.stopSequence ?? 140,
      direction_id: o.direction ?? 0,
      updated_at: o.updatedAt ?? '2026-08-01T12:00:03-04:00',
    },
    relationships: {
      route: { data: { id: o.route ?? 'Orange', type: 'route' } },
      trip: { data: { id: o.trip ?? 'trip1', type: 'trip' } },
      ...(o.stop === null ? {} : { stop: { data: { id: o.stop ?? '70010', type: 'stop' } } }),
    },
  };
}

const doc = (data: Resource[], included: Resource[] = []): Document => ({ data, included });

const runPredictions = (
  preds: Resource[],
  vehicles: Resource[],
  state: DedupState,
  now: number,
  included: Resource[] = [],
) => collectPredictions(fakeDb, doc(preds, included), doc(vehicles), PARENTS, SLICES, state, now);

const runVehicles = (vehicles: Resource[], state: DedupState, now: number) =>
  collectVehicles(fakeDb, doc(vehicles), PARENTS, SLICES, state, now);

describe('collectPredictions', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('normalises a platform stop id to its parent station', () => {
    const { statements } = runPredictions([prediction({})], [], state, T0);
    expect(argsOf(statements[0])[P.stopId]).toBe('place-rugg');
  });

  it('ignores predictions outside the watched slices', () => {
    const other = [
      prediction({ trip: 'a', direction: 1 }), // watched stop, unwatched direction
      prediction({ trip: 'b', route: 'Red' }), // unwatched route
      prediction({ trip: 'c', stop: '70279' }), // unwatched stop
    ];
    const { seen, statements } = runPredictions(other, [], state, T0);
    expect(seen).toBe(0);
    expect(statements).toHaveLength(0);
  });

  it('skips predictions missing part of the natural key', () => {
    const broken = prediction({});
    delete broken.attributes!.stop_sequence;
    expect(runPredictions([broken], [], state, T0).statements).toHaveLength(0);
  });

  it('records the first sighting as revision 1', () => {
    const { statements } = runPredictions([prediction({})], [], state, T0);
    expect(statements).toHaveLength(1);
    const a = argsOf(statements[0]);
    expect(a[P.revision]).toBe(1);
    expect(a[P.serviceDate]).toBe('2026-08-01');
    expect(a[P.tripId]).toBe('trip1');
    expect(a[P.stopSequence]).toBe(140);
  });

  it('writes nothing when the prediction is unchanged', () => {
    runPredictions([prediction({})], [], state, T0);
    const second = runPredictions([prediction({})], [], state, T0 + 60);
    expect(second.seen).toBe(1);
    expect(second.statements).toHaveLength(0);
  });

  it('increments revision when the promised time changes', () => {
    runPredictions([prediction({})], [], state, T0);
    const { statements } = runPredictions(
      [prediction({ arrival: '2026-08-01T12:07:00-04:00' })],
      [],
      state,
      T0 + 60,
    );
    expect(argsOf(statements[0])[P.revision]).toBe(2);
  });

  it('does NOT write a snapshot just because the vehicle moved', () => {
    // The budget depends on this: vehicle position changes nearly every tick, so
    // including it in the fingerprint would mean writing every prediction every
    // minute and dedup would buy nothing.
    runPredictions([prediction({})], [vehicle({ stopSequence: 130 })], state, T0);
    const { statements } = runPredictions(
      [prediction({})],
      [vehicle({ stopSequence: 138, status: 'INCOMING_AT' })],
      state,
      T0 + 60,
    );
    expect(statements).toHaveLength(0);
  });

  it('attaches the vehicle state present at the moment it does write', () => {
    const { statements } = runPredictions(
      [prediction({})],
      [vehicle({ id: 'O-1', stopSequence: 132 })],
      state,
      T0,
    );
    const a = argsOf(statements[0]);
    expect(a[P.vehicleId]).toBe('O-1');
    expect(a[P.vehicleStopSequence]).toBe(132);
  });

  it('computes a signed horizon against the observation time', () => {
    const ahead = runPredictions([prediction({})], [], state, T0);
    expect(argsOf(ahead.statements[0])[P.horizonSec]).toBe(300);

    // A prediction whose promised time has already passed keeps a negative
    // horizon rather than being clamped or dropped.
    const late = runPredictions([prediction({ trip: 'trip2' })], [], state, T0 + 420);
    expect(argsOf(late.statements[0])[P.horizonSec]).toBe(-120);
  });

  it('tolerates a prediction with no arrival time', () => {
    const { statements } = runPredictions([prediction({ arrival: null })], [], state, T0);
    const a = argsOf(statements[0]);
    expect(a[P.predictedArrival]).toBeNull();
    expect(a[P.horizonSec]).toBeNull();
  });

  it('picks up scheduled_arrival from the included schedule, and null without one', () => {
    const schedule: Resource = {
      id: 'sched-1',
      type: 'schedule',
      attributes: { arrival_time: '2026-08-01T12:04:00-04:00' },
    };
    const withSchedule = runPredictions(
      [prediction({ schedule: 'sched-1' })],
      [],
      state,
      T0,
      [schedule],
    );
    expect(argsOf(withSchedule.statements[0])[P.scheduledArrival]).toBe(
      at('2026-08-01T12:04:00-04:00'),
    );

    const without = runPredictions([prediction({ trip: 'trip9' })], [], state, T0);
    expect(argsOf(without.statements[0])[P.scheduledArrival]).toBeNull();
  });
});

describe('collectVehicles', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('ignores vehicles that are nowhere near a watched stop', () => {
    const { seen, statements } = runVehicles([vehicle({ stop: '70279' })], state, T0);
    expect(seen).toBe(1); // counted, because it is on a watched route
    expect(statements).toHaveLength(0);
  });

  it('records a vehicle approaching a watched stop, using MBTA’s own timestamp', () => {
    const { statements } = runVehicles(
      [vehicle({ status: 'INCOMING_AT', updatedAt: '2026-08-01T12:00:17-04:00' })],
      state,
      T0,
    );
    const a = argsOf(statements[0]);
    expect(a[V.currentStatus]).toBe('INCOMING_AT');
    expect(a[V.stopId]).toBe('place-rugg');
    // Not our poll time: MBTA timestamps its own state change far more tightly
    // than 60-second polling can.
    expect(a[V.vehicleUpdatedAt]).toBe(at('2026-08-01T12:00:17-04:00'));
    expect(a[V.observedAt]).toBe(T0);
  });

  it('writes one row per state change, not one per poll', () => {
    runVehicles([vehicle({ status: 'IN_TRANSIT_TO' })], state, T0);
    expect(runVehicles([vehicle({ status: 'IN_TRANSIT_TO' })], state, T0 + 60).statements).toHaveLength(
      0,
    );
    expect(runVehicles([vehicle({ status: 'STOPPED_AT' })], state, T0 + 120).statements).toHaveLength(
      1,
    );
  });

  it('lingers after departure so a missed STOPPED_AT still leaves evidence', () => {
    // Dwell is often shorter than the poll interval, so we can go straight from
    // approaching Ruggles to in-transit to the next stop. That next observation
    // is the only proof the train served the stop — the sequence_advanced source.
    runVehicles([vehicle({ status: 'INCOMING_AT', stopSequence: 140 })], state, T0);
    const departed = runVehicles(
      [vehicle({ status: 'IN_TRANSIT_TO', stopSequence: 150, stop: '70279' })],
      state,
      T0 + 60,
    );
    expect(departed.statements).toHaveLength(1);
    expect(argsOf(departed.statements[0])[V.currentStopSequence]).toBe(150);
  });

  it('stops recording once the linger window expires', () => {
    runVehicles([vehicle({ status: 'INCOMING_AT' })], state, T0);
    const late = runVehicles(
      [vehicle({ status: 'IN_TRANSIT_TO', stopSequence: 200, stop: '70279' })],
      state,
      T0 + 301,
    );
    expect(late.statements).toHaveLength(0);
  });

  it('skips vehicles with no reported status', () => {
    const v = vehicle({});
    delete v.attributes!.current_status;
    expect(runVehicles([v], state, T0).statements).toHaveLength(0);
  });
});
