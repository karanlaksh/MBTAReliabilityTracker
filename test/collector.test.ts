import { beforeEach, describe, expect, it } from 'vitest';
import { __test } from '../src/collector';
import { emptyState, type DedupState } from '../src/state';
import type { Document, Resource } from '../src/mbta';

const { collectPredictions, collectVehicles } = __test;

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T0 = at('2026-08-01T12:00:00-04:00');

/** Rows are plain value arrays in column order — no statement to unpack. */
const argsOf = (r: unknown) => r as unknown[];

// Column order matches the INSERT in collector.ts.
const P = {
  serviceDate: 1,
  firstSeenAt: 17,
  firstPredictedArrival: 18,
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
) => collectPredictions(doc(preds, included), doc(vehicles), PARENTS, SLICES, state, now);

const runVehicles = (
  vehicles: Resource[],
  state: DedupState,
  now: number,
  targetsByTrip: Map<string, number[]> = new Map(),
) => collectVehicles(doc(vehicles), PARENTS, SLICES, state, now, targetsByTrip);

describe('collectPredictions', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('normalises a platform stop id to its parent station', () => {
    const { rows } = runPredictions([prediction({})], [], state, T0);
    expect(argsOf(rows[0])[P.stopId]).toBe('place-rugg');
  });

  it('ignores predictions outside the watched slices', () => {
    const other = [
      prediction({ trip: 'a', direction: 1 }), // watched stop, unwatched direction
      prediction({ trip: 'b', route: 'Red' }), // unwatched route
      prediction({ trip: 'c', stop: '70279' }), // unwatched stop
    ];
    const { seen, rows } = runPredictions(other, [], state, T0);
    expect(seen).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('skips predictions missing part of the natural key', () => {
    const broken = prediction({});
    delete broken.attributes!.stop_sequence;
    expect(runPredictions([broken], [], state, T0).rows).toHaveLength(0);
  });

  it('records the first sighting as revision 1', () => {
    const { rows } = runPredictions([prediction({})], [], state, T0);
    expect(rows).toHaveLength(1);
    const a = argsOf(rows[0]);
    expect(a[P.revision]).toBe(1);
    expect(a[P.serviceDate]).toBe('2026-08-01');
    expect(a[P.tripId]).toBe('trip1');
    expect(a[P.stopSequence]).toBe(140);
  });

  it('writes nothing when the prediction is unchanged', () => {
    runPredictions([prediction({})], [], state, T0);
    const second = runPredictions([prediction({})], [], state, T0 + 60);
    expect(second.seen).toBe(1);
    expect(second.rows).toHaveLength(0);
  });

  it('increments revision when the promised time changes', () => {
    runPredictions([prediction({})], [], state, T0);
    const { rows } = runPredictions(
      [prediction({ arrival: '2026-08-01T12:07:00-04:00' })],
      [],
      state,
      T0 + 60,
    );
    expect(argsOf(rows[0])[P.revision]).toBe(2);
  });

  it('does NOT write a snapshot just because the vehicle moved', () => {
    // The budget depends on this: vehicle position changes nearly every tick, so
    // including it in the fingerprint would mean writing every prediction every
    // minute and dedup would buy nothing.
    runPredictions([prediction({})], [vehicle({ stopSequence: 130 })], state, T0);
    const { rows } = runPredictions(
      [prediction({})],
      [vehicle({ stopSequence: 138, status: 'INCOMING_AT' })],
      state,
      T0 + 60,
    );
    expect(rows).toHaveLength(0);
  });

  it('attaches the vehicle state present at the moment it does write', () => {
    const { rows } = runPredictions(
      [prediction({})],
      [vehicle({ id: 'O-1', stopSequence: 132 })],
      state,
      T0,
    );
    const a = argsOf(rows[0]);
    expect(a[P.vehicleId]).toBe('O-1');
    expect(a[P.vehicleStopSequence]).toBe(132);
  });

  it('computes a signed horizon against the observation time', () => {
    const ahead = runPredictions([prediction({})], [], state, T0);
    expect(argsOf(ahead.rows[0])[P.horizonSec]).toBe(300);

    // A prediction whose promised time has already passed keeps a negative
    // horizon rather than being clamped or dropped.
    const late = runPredictions([prediction({ trip: 'trip2' })], [], state, T0 + 420);
    expect(argsOf(late.rows[0])[P.horizonSec]).toBe(-120);
  });

  it('tolerates a prediction with no arrival time', () => {
    const { rows } = runPredictions([prediction({ arrival: null })], [], state, T0);
    const a = argsOf(rows[0]);
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
    expect(argsOf(withSchedule.rows[0])[P.scheduledArrival]).toBe(
      at('2026-08-01T12:04:00-04:00'),
    );

    const without = runPredictions([prediction({ trip: 'trip9' })], [], state, T0);
    expect(argsOf(without.rows[0])[P.scheduledArrival]).toBeNull();
  });
});

describe('collectVehicles', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('ignores vehicles that are nowhere near a watched stop', () => {
    const { seen, rows } = runVehicles([vehicle({ stop: '70279' })], state, T0);
    expect(seen).toBe(1); // counted, because it is on a watched route
    expect(rows).toHaveLength(0);
  });

  it('records a vehicle approaching a watched stop, using MBTA’s own timestamp', () => {
    const { rows } = runVehicles(
      [vehicle({ status: 'INCOMING_AT', updatedAt: '2026-08-01T12:00:17-04:00' })],
      state,
      T0,
    );
    const a = argsOf(rows[0]);
    expect(a[V.currentStatus]).toBe('INCOMING_AT');
    expect(a[V.stopId]).toBe('place-rugg');
    // Not our poll time: MBTA timestamps its own state change far more tightly
    // than 60-second polling can.
    expect(a[V.vehicleUpdatedAt]).toBe(at('2026-08-01T12:00:17-04:00'));
    expect(a[V.observedAt]).toBe(T0);
  });

  it('writes one row per state change, not one per poll', () => {
    runVehicles([vehicle({ status: 'IN_TRANSIT_TO' })], state, T0);
    expect(runVehicles([vehicle({ status: 'IN_TRANSIT_TO' })], state, T0 + 60).rows).toHaveLength(
      0,
    );
    expect(runVehicles([vehicle({ status: 'STOPPED_AT' })], state, T0 + 120).rows).toHaveLength(
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
    expect(departed.rows).toHaveLength(1);
    expect(argsOf(departed.rows[0])[V.currentStopSequence]).toBe(150);
  });

  it('stops recording once the linger window expires', () => {
    runVehicles([vehicle({ status: 'INCOMING_AT' })], state, T0);
    const late = runVehicles(
      [vehicle({ status: 'IN_TRANSIT_TO', stopSequence: 200, stop: '70279' })],
      state,
      T0 + 301,
    );
    expect(late.rows).toHaveLength(0);
  });

  it('skips vehicles with no reported status', () => {
    const v = vehicle({});
    delete v.attributes!.current_status;
    expect(runVehicles([v], state, T0).rows).toHaveLength(0);
  });
});

describe('horizon cap', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  // T0 is 12:00:00; the helper's default arrival is 12:05, so horizon = 300s.
  const farOut = (trip: string, arrival: string) => prediction({ trip, arrival });

  it('writes a prediction inside the 20-minute window', () => {
    const { rows } = runPredictions([prediction({})], [], state, T0); // horizon 300
    expect(rows).toHaveLength(1);
    expect(argsOf(rows[0])[P.horizonSec]).toBe(300);
  });

  it('suppresses the write beyond 20 minutes', () => {
    const { rows, horizonSuppressed } = runPredictions(
      [farOut('t1', '2026-08-01T12:40:00-04:00')], // horizon 2400
      [],
      state,
      T0,
    );
    expect(rows).toHaveLength(0);
    expect(horizonSuppressed).toBe(1);
  });

  it('treats exactly 1200s as inside and 1201s as outside', () => {
    const boundary = runPredictions(
      [farOut('t-in', '2026-08-01T12:20:00-04:00')], // exactly 1200
      [],
      state,
      T0,
    );
    expect(boundary.rows).toHaveLength(1);
    expect(argsOf(boundary.rows[0])[P.horizonSec]).toBe(1200);

    const past = runPredictions(
      [farOut('t-out', '2026-08-01T12:20:01-04:00')], // 1201
      [],
      state,
      T0,
    );
    expect(past.rows).toHaveLength(0);
  });

  it('always writes predictions with a NULL horizon', () => {
    // No arrival time at all: a skipped stop, a cancelled trip, a vehicle that
    // will not serve this stop. Rare, and the interesting failures — the cap must
    // never swallow them.
    const { rows, horizonSuppressed } = runPredictions(
      [prediction({ trip: 'no-arrival', arrival: null })],
      [],
      state,
      T0,
    );
    expect(rows).toHaveLength(1);
    expect(argsOf(rows[0])[P.predictedArrival]).toBeNull();
    expect(argsOf(rows[0])[P.horizonSec]).toBeNull();
    expect(horizonSuppressed).toBe(0);
  });

  it('keeps counting revisions while suppressed, so revision means total revisions', () => {
    // The load-bearing test for this feature. `revision` is an ML feature meaning
    // "how many times MBTA revised this arrival" — NOT "how many times since it
    // entered our window". Those differ, and only the former is useful.
    const trip = 'long-runner';

    // Three revisions, all far outside the window. Nothing is written.
    expect(runPredictions([farOut(trip, '2026-08-01T12:40:00-04:00')], [], state, T0).rows).toHaveLength(0);
    expect(runPredictions([farOut(trip, '2026-08-01T12:41:00-04:00')], [], state, T0 + 60).rows).toHaveLength(0);
    expect(runPredictions([farOut(trip, '2026-08-01T12:42:00-04:00')], [], state, T0 + 120).rows).toHaveLength(0);

    // Now it enters the window and is revised a fourth time.
    const inWindow = at('2026-08-01T12:25:00-04:00');
    const { rows } = runPredictions([farOut(trip, '2026-08-01T12:43:00-04:00')], [], state, inWindow);

    expect(rows).toHaveLength(1);
    // 4, not 1 — the three suppressed revisions were still counted.
    expect(argsOf(rows[0])[P.revision]).toBe(4);
    expect(argsOf(rows[0])[P.horizonSec]).toBe(1080);
  });

  it('still dedups an unchanged prediction once it enters the window', () => {
    const trip = 'steady';
    runPredictions([farOut(trip, '2026-08-01T12:40:00-04:00')], [], state, T0);
    // Same value, now inside the window. Unchanged is unchanged: no write.
    const inWindow = at('2026-08-01T12:25:00-04:00');
    expect(runPredictions([farOut(trip, '2026-08-01T12:40:00-04:00')], [], state, inWindow).rows).toHaveLength(0);
  });

  it('counts suppressed predictions as seen, so per-slice counts stay truthful', () => {
    // per_slice_counts answers "is this slice running trains", not "did we write
    // rows". A suppressed far-out prediction is still evidence of service.
    const { seen, perSlice, rows } = runPredictions(
      [farOut('a', '2026-08-01T12:40:00-04:00'), farOut('b', '2026-08-01T12:45:00-04:00')],
      [],
      state,
      T0,
    );
    expect(seen).toBe(2);
    expect(perSlice['place-rugg|Orange|0']).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it('keeps a negative horizon, which is inside the window by definition', () => {
    const late = runPredictions([prediction({ trip: 'overdue' })], [], state, T0 + 420);
    expect(late.rows).toHaveLength(1);
    expect(argsOf(late.rows[0])[P.horizonSec]).toBe(-120);
  });
});

describe('first_seen_at / first_predicted_arrival', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('stamps the first observation on a brand-new prediction', () => {
    const { rows } = runPredictions([prediction({})], [], state, T0);
    const a = argsOf(rows[0]);
    expect(a[P.firstSeenAt]).toBe(T0);
    expect(a[P.firstPredictedArrival]).toBe(at('2026-08-01T12:05:00-04:00'));
  });

  it('keeps the ORIGINAL values as the prediction is revised', () => {
    runPredictions([prediction({})], [], state, T0);
    const { rows } = runPredictions(
      [prediction({ arrival: '2026-08-01T12:09:00-04:00' })],
      [],
      state,
      T0 + 60,
    );
    const a = argsOf(rows[0]);
    // Still the first sighting and the first estimate, not this tick's.
    expect(a[P.firstSeenAt]).toBe(T0);
    expect(a[P.firstPredictedArrival]).toBe(at('2026-08-01T12:05:00-04:00'));
    expect(a[P.predictedArrival]).toBe(at('2026-08-01T12:09:00-04:00'));
  });

  it('survives writes suppressed by the horizon cap — the reason it exists', () => {
    // Reproduces trip 78493012: revised repeatedly far outside the window, so the
    // first row ever STORED must still carry what MBTA originally said.
    const trip = 'origin-carrier';
    const original = '2026-08-01T12:40:00-04:00';
    runPredictions([prediction({ trip, arrival: original })], [], state, T0); // suppressed
    runPredictions([prediction({ trip, arrival: '2026-08-01T12:41:00-04:00' })], [], state, T0 + 60);
    runPredictions([prediction({ trip, arrival: '2026-08-01T12:42:00-04:00' })], [], state, T0 + 120);

    const inWindow = at('2026-08-01T12:25:00-04:00');
    const { rows } = runPredictions(
      [prediction({ trip, arrival: '2026-08-01T12:43:00-04:00' })],
      [],
      state,
      inWindow,
    );

    expect(rows).toHaveLength(1);
    const a = argsOf(rows[0]);
    expect(a[P.firstSeenAt]).toBe(T0); // 25 minutes before this row was written
    expect(a[P.firstPredictedArrival]).toBe(at(original));
    expect(a[P.revision]).toBe(4);
    // The whole point: original estimate 12:40, now saying 12:43 — 3 minutes of
    // drift that would have been invisible.
    expect((a[P.predictedArrival] as number) - (a[P.firstPredictedArrival] as number)).toBe(180);
  });

  it('records a NULL first estimate when the prediction never had an arrival time', () => {
    const { rows } = runPredictions(
      [prediction({ trip: 'no-arrival', arrival: null })],
      [],
      state,
      T0,
    );
    const a = argsOf(rows[0]);
    expect(a[P.firstSeenAt]).toBe(T0);
    expect(a[P.firstPredictedArrival]).toBeNull();
  });

  it('stamps NULL rather than guessing for pre-migration state entries', () => {
    // A 3-element entry predates this feature and cannot say when it was first
    // seen. Inventing the current tick would be worse than admitting the gap.
    state.p['trip1|140'] = ['stale-fingerprint', 7, T0 - 600];
    const { rows } = runPredictions([prediction({})], [], state, T0);
    const a = argsOf(rows[0]);
    expect(a[P.firstSeenAt]).toBeNull();
    expect(a[P.firstPredictedArrival]).toBeNull();
    expect(a[P.revision]).toBe(8); // revision continuity is unaffected
  });
});

describe('near-target sequence rule (the bus fix)', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  // Route 39 numbers its stops 1 apart, so a target at seq 6 has real neighbours
  // at 3,4,5,7,8,9. The vehicle's own stop is NOT a watched stop in these cases —
  // that is the whole point, since a bus routinely passes ours between polls.
  const busTargets = new Map([['bus-trip', [6]]]);
  const bus = (seq: number, status = 'IN_TRANSIT_TO') =>
    vehicle({ id: 'B-1', trip: 'bus-trip', route: '39', stop: '70279', stopSequence: seq, status });

  it('records a bus approaching within 3 stops of its target', () => {
    const { rows } = runVehicles([bus(4)], state, T0, busTargets);
    expect(rows).toHaveLength(1);
    expect(argsOf(rows[0])[V.currentStopSequence]).toBe(4);
  });

  it('records it on the far side too, so the target is bracketed', () => {
    runVehicles([bus(4)], state, T0, busTargets);
    const after = runVehicles([bus(8)], state, T0 + 60, busTargets);
    expect(after.rows).toHaveLength(1);
  });

  it('ignores a bus further away than the window', () => {
    expect(runVehicles([bus(2)], state, T0, busTargets).rows).toHaveLength(0);
    expect(runVehicles([bus(10)], state, T0, busTargets).rows).toHaveLength(0);
  });

  it('is a no-op at subway sequence spacing', () => {
    // Orange numbers stops 10 apart, so +/-3 around a target of 140 contains only
    // 140 itself. The neighbouring stop at 130 must not be recorded, or the bus
    // fix would silently add subway writes.
    const subwayTargets = new Map([['trip1', [140]]]);
    const neighbour = vehicle({ stopSequence: 130, stop: '70279' });
    expect(runVehicles([neighbour], state, T0, subwayTargets).rows).toHaveLength(0);
  });

  it('ignores a vehicle whose trip holds no prediction at a watched stop', () => {
    const stranger = vehicle({ id: 'B-9', trip: 'other-trip', route: '39', stop: '70279', stopSequence: 6 });
    expect(runVehicles([stranger], state, T0, busTargets).rows).toHaveLength(0);
  });

  it('starts the linger, so evidence continues past the window', () => {
    runVehicles([bus(6, 'STOPPED_AT')], state, T0, busTargets);
    // Now 4 stops past the target — outside +/-3, but inside the linger.
    const past = runVehicles([bus(10)], state, T0 + 60, busTargets);
    expect(past.rows).toHaveLength(1);
  });
});
