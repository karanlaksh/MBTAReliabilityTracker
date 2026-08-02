import { describe, expect, it } from 'vitest';
import { CONFIDENCE, __test } from '../src/matcher';

const { resolveArrival, isSkipped, groupCandidates } = __test;

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T = (iso: string) => at(`2026-08-01T${iso}-04:00`);

function snapshot(o: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    service_date: '2026-08-01',
    trip_id: 'trip1',
    stop_sequence: 140,
    stop_id: 'place-rugg',
    route_id: 'Orange',
    direction_id: 0,
    observed_at: T('12:00:00'),
    predicted_arrival: T('12:05:00'),
    predicted_departure: T('12:05:30'),
    schedule_relationship: null,
    status: null,
    vehicle_id: 'O-1',
    ...o,
  } as never;
}

function candidate(o: Partial<Record<string, unknown>> = {}) {
  const last = snapshot(o);
  return {
    minRowId: 1,
    service_date: '2026-08-01',
    trip_id: 'trip1',
    stop_sequence: 140,
    stop_id: 'place-rugg',
    route_id: 'Orange',
    direction_id: 0,
    lastPredictedArrival: T('12:05:00'),
    lastSnapshot: last,
    vehicleIds: new Set(['O-1']),
    ...o,
  } as never;
}

function obs(o: Partial<Record<string, unknown>> = {}) {
  return {
    service_date: '2026-08-01',
    trip_id: 'trip1',
    vehicle_id: 'O-1',
    stop_id: 'place-rugg',
    current_status: 'STOPPED_AT',
    current_stop_sequence: 140,
    vehicle_updated_at: T('12:05:10'),
    ...o,
  } as never;
}

describe('resolveArrival — stopped_at', () => {
  it('uses the EARLIEST STOPPED_AT, not the latest', () => {
    // A vehicle reports STOPPED_AT for the whole dwell. Taking the last one would
    // push arrival to the end of the dwell and make every long stop look late —
    // which at a terminus is several minutes of manufactured lateness.
    const r = resolveArrival(
      candidate(),
      [
        obs({ vehicle_updated_at: T('12:05:10') }),
        obs({ vehicle_updated_at: T('12:06:40') }),
        obs({ vehicle_updated_at: T('12:07:55') }),
      ],
      false,
    );
    expect(r.source).toBe('stopped_at');
    expect(r.actual).toBe(T('12:05:10'));
    expect(r.uncertainty).toBe(30);
  });

  it('prefers stop_sequence over stop_id and records which was used', () => {
    const r = resolveArrival(candidate(), [obs()], false);
    expect(r.matchKey).toBe('stop_sequence');
  });

  it('falls back to stop_id when the sequence does not line up', () => {
    const r = resolveArrival(candidate(), [obs({ current_stop_sequence: 999 })], false);
    expect(r.source).toBe('stopped_at');
    expect(r.matchKey).toBe('stop_id');
  });

  it('ignores observations belonging to a different trip', () => {
    const r = resolveArrival(candidate(), [obs({ trip_id: 'other' })], false);
    expect(r.source).toBe('unresolved_dropout');
  });
});

describe('resolveArrival — sequence_advanced', () => {
  it('takes the bracket midpoint and computes uncertainty from its width', () => {
    // Never seen stopped; observations straddle the target. Half the bracket
    // width, computed — not a hardcoded 90s.
    const r = resolveArrival(
      candidate(),
      [
        obs({ current_status: 'IN_TRANSIT_TO', current_stop_sequence: 140, vehicle_updated_at: T('12:04:00') }),
        obs({ current_status: 'IN_TRANSIT_TO', current_stop_sequence: 150, vehicle_updated_at: T('12:06:00') }),
      ],
      false,
    );
    expect(r.source).toBe('sequence_advanced');
    expect(r.actual).toBe(T('12:05:00'));
    expect(r.uncertainty).toBe(60); // half of a 120s bracket
    expect(r.spanSec).toBe(120);
  });

  it('reports a wide bracket as genuinely imprecise', () => {
    const r = resolveArrival(
      candidate(),
      [
        obs({ current_status: 'IN_TRANSIT_TO', current_stop_sequence: 130, vehicle_updated_at: T('12:00:00') }),
        obs({ current_status: 'IN_TRANSIT_TO', current_stop_sequence: 150, vehicle_updated_at: T('12:10:00') }),
      ],
      false,
    );
    expect(r.uncertainty).toBe(300);
  });

  it('does not fire with only one side of the bracket', () => {
    const r = resolveArrival(
      candidate(),
      [obs({ current_status: 'IN_TRANSIT_TO', current_stop_sequence: 130, vehicle_updated_at: T('12:00:00') })],
      false,
    );
    expect(r.source).toBe('unresolved_dropout');
  });
});

describe('resolveArrival — terminus turnaround', () => {
  // At Forest Hills the vehicle is reassigned to its next outbound trip on
  // arrival, so the STOPPED_AT is filed under a different trip_id at sequence 1.
  const terminus = () =>
    candidate({ stop_id: 'place-forhl', stop_sequence: 190, lastPredictedArrival: T('12:05:00') });

  const approach = obs({
    stop_id: 'place-forhl',
    current_status: 'INCOMING_AT',
    current_stop_sequence: 190,
    vehicle_updated_at: T('12:04:30'),
  });
  const reassigned = obs({
    stop_id: 'place-forhl',
    trip_id: 'next-trip',
    current_status: 'STOPPED_AT',
    current_stop_sequence: 1,
    vehicle_updated_at: T('12:05:30'),
  });

  it('brackets between last approach and first reassignment', () => {
    const r = resolveArrival(terminus(), [approach, reassigned], true);
    expect(r.source).toBe('stopped_at_turnaround');
    expect(r.actual).toBe(T('12:05:00')); // midpoint of 12:04:30 and 12:05:30
    expect(r.uncertainty).toBe(30); // half of a 60s bracket
    expect(r.spanSec).toBe(60);
  });

  it('does NOT inherit the flat 30s point-estimate uncertainty', () => {
    // The reassignment timestamp is at or after physical arrival — a
    // one-directional lag, not symmetric noise. A wide bracket must report wide
    // uncertainty, or Forest Hills reads as MBTA systematically under-predicting.
    const late = obs({
      stop_id: 'place-forhl',
      trip_id: 'next-trip',
      current_status: 'STOPPED_AT',
      current_stop_sequence: 1,
      vehicle_updated_at: T('12:09:30'),
    });
    const r = resolveArrival(terminus(), [approach, late], true);
    expect(r.spanSec).toBe(300);
    expect(r.uncertainty).toBe(150);
    expect(r.uncertainty).not.toBe(30);
  });

  it('falls back to the reassignment time alone with inflated uncertainty', () => {
    const r = resolveArrival(terminus(), [reassigned], true);
    expect(r.source).toBe('stopped_at_turnaround');
    expect(r.actual).toBe(T('12:05:30'));
    expect(r.uncertainty).toBe(300);
    expect(r.spanSec).toBeNull(); // counted separately as unbracketed
  });

  it('is not attempted at a mid-line stop', () => {
    // sequence_advanced is the right tool mid-line; turnaround inference there
    // would be matching on a coincidence of vehicle and stop.
    const r = resolveArrival(candidate(), [obs({ trip_id: 'next-trip', current_stop_sequence: 1 })], false);
    expect(r.source).not.toBe('stopped_at_turnaround');
  });

  it('requires the same vehicle, not merely the same stop', () => {
    const otherVehicle = obs({
      stop_id: 'place-forhl',
      trip_id: 'next-trip',
      vehicle_id: 'O-99',
      current_status: 'STOPPED_AT',
      current_stop_sequence: 1,
      vehicle_updated_at: T('12:05:30'),
    });
    const r = resolveArrival(terminus(), [otherVehicle], true);
    expect(r.source).toBe('unresolved_dropout');
  });
});

describe('resolveArrival — unfulfilled outcomes', () => {
  it('detects SKIPPED and CANCELLED', () => {
    expect(isSkipped(snapshot({ schedule_relationship: 'SKIPPED' }))).toBe(true);
    expect(isSkipped(snapshot({ schedule_relationship: 'CANCELLED' }))).toBe(true);
  });

  it('detects the all-null case that means the vehicle will not serve the stop', () => {
    expect(
      isSkipped(snapshot({ predicted_arrival: null, predicted_departure: null, status: null })),
    ).toBe(true);
  });

  it('does not treat an ordinary prediction as skipped', () => {
    expect(isSkipped(snapshot())).toBe(false);
  });

  it('lets observed evidence outrank a stale skip flag', () => {
    // If a vehicle was actually seen stopping there, it was served, whatever the
    // last schedule_relationship said.
    const r = resolveArrival(candidate({ schedule_relationship: 'SKIPPED' }), [obs()], false);
    expect(r.source).toBe('stopped_at');
  });

  it('returns unresolved_dropout with a null arrival when nothing explains it', () => {
    const r = resolveArrival(candidate(), [], false);
    expect(r.source).toBe('unresolved_dropout');
    expect(r.actual).toBeNull();
    expect(r.uncertainty).toBeNull();
  });
});

describe('confidence ordering', () => {
  it('ranks sources so a re-run can only improve a row', () => {
    expect(CONFIDENCE['stopped_at']).toBeGreaterThan(CONFIDENCE['stopped_at_turnaround']);
    expect(CONFIDENCE['stopped_at_turnaround']).toBeGreaterThan(CONFIDENCE['sequence_advanced']);
    expect(CONFIDENCE['sequence_advanced']).toBeGreaterThan(CONFIDENCE['skipped']);
    expect(CONFIDENCE['skipped']).toBeGreaterThan(CONFIDENCE['unresolved_dropout']);
  });

  it('never lets a dropout displace real evidence', () => {
    for (const better of ['stopped_at', 'stopped_at_turnaround', 'sequence_advanced', 'skipped']) {
      expect(CONFIDENCE['unresolved_dropout']).toBeLessThan(CONFIDENCE[better]);
    }
  });
});

describe('groupCandidates', () => {
  it('keys on (service_date, trip_id, stop_sequence), not stop_id', () => {
    // stop_id is mutable on the V3 API; the natural key must not include it.
    const grouped = groupCandidates([
      snapshot({ id: 1, stop_id: 'platform-a' }),
      snapshot({ id: 2, stop_id: 'platform-b' }),
    ] as never);
    expect(grouped.size).toBe(1);
  });

  it('keeps the newest snapshot and the earliest rowid', () => {
    const grouped = groupCandidates([
      snapshot({ id: 5, predicted_arrival: T('12:05:00') }),
      snapshot({ id: 9, predicted_arrival: T('12:08:00') }),
    ] as never);
    const c = [...grouped.values()][0];
    expect(c.minRowId).toBe(5);
    expect(c.lastPredictedArrival).toBe(T('12:08:00'));
  });

  it('collects every vehicle a prediction was ever associated with', () => {
    // The turnaround lookup needs these: the arrival is filed under a different
    // trip but the same vehicle.
    const grouped = groupCandidates([
      snapshot({ id: 1, vehicle_id: 'O-1' }),
      snapshot({ id: 2, vehicle_id: 'O-2' }),
    ] as never);
    expect([...[...grouped.values()][0].vehicleIds].sort()).toEqual(['O-1', 'O-2']);
  });

  it('separates different stop_sequences on the same trip', () => {
    const grouped = groupCandidates([
      snapshot({ id: 1, stop_sequence: 130 }),
      snapshot({ id: 2, stop_sequence: 140 }),
    ] as never);
    expect(grouped.size).toBe(2);
  });
});

describe('turnaround search is anchored (regression)', () => {
  // A vehicle turns around at the same terminus many times a day. An unbounded
  // search for "earliest STOPPED_AT at this stop by this vehicle" therefore finds
  // the FIRST of the day, not the one belonging to this trip. Shipped once and
  // caught in production: 167 of 182 turnaround arrivals were wrong by over an
  // hour, the worst by 16 hours. These tests exist so it cannot come back.
  const terminus = () =>
    candidate({
      stop_id: 'place-forhl',
      stop_sequence: 190,
      lastPredictedArrival: T('18:05:00'),
    });

  const approachNow = obs({
    stop_id: 'place-forhl',
    current_status: 'INCOMING_AT',
    current_stop_sequence: 190,
    vehicle_updated_at: T('18:04:30'),
  });

  // The same vehicle turned around here at 06:00, twelve hours earlier.
  const turnaroundThisMorning = obs({
    stop_id: 'place-forhl',
    trip_id: 'morning-trip',
    current_status: 'STOPPED_AT',
    current_stop_sequence: 1,
    vehicle_updated_at: T('06:00:00'),
  });

  const turnaroundNow = obs({
    stop_id: 'place-forhl',
    trip_id: 'evening-trip',
    current_status: 'STOPPED_AT',
    current_stop_sequence: 1,
    vehicle_updated_at: T('18:05:30'),
  });

  it('ignores an earlier turnaround by the same vehicle on the same day', () => {
    const r = resolveArrival(terminus(), [turnaroundThisMorning, approachNow, turnaroundNow], true);
    expect(r.source).toBe('stopped_at_turnaround');
    expect(r.actual).toBe(T('18:05:00')); // midpoint of 18:04:30 and 18:05:30
    expect(r.actual).not.toBe(T('06:00:00'));
    expect(r.spanSec).toBe(60);
  });

  it('brackets whenever an approach sighting exists, rather than falling back', () => {
    const r = resolveArrival(terminus(), [approachNow, turnaroundNow], true);
    expect(r.spanSec).not.toBeNull();
    expect(r.uncertainty).toBeLessThan(100);
  });

  it('bounds the search even with no approach sighting at all', () => {
    // Only the stale morning turnaround is available. It is far outside the
    // window around the predicted arrival, so it must not be used.
    const r = resolveArrival(terminus(), [turnaroundThisMorning], true);
    expect(r.source).toBe('unresolved_dropout');
  });

  it('accepts a reassignment inside the fallback window when unanchored', () => {
    const r = resolveArrival(terminus(), [turnaroundNow], true);
    expect(r.source).toBe('stopped_at_turnaround');
    expect(r.actual).toBe(T('18:05:30'));
    expect(r.uncertainty).toBe(300);
    expect(r.spanSec).toBeNull();
  });

  it('rejects a reassignment implausibly long after arrival', () => {
    const muchLater = obs({
      stop_id: 'place-forhl',
      trip_id: 'later-trip',
      current_status: 'STOPPED_AT',
      current_stop_sequence: 1,
      vehicle_updated_at: T('19:30:00'), // 85 minutes after the approach
    });
    const r = resolveArrival(terminus(), [approachNow, muchLater], true);
    expect(r.source).toBe('unresolved_dropout');
  });
});

describe('plausibility flag', () => {
  const { isImplausible } = __test;

  it('accepts ordinary delays, however large', () => {
    // A 45-minute delay is a real transit event and must never be flagged away.
    expect(isImplausible(T('12:50:00'), T('12:05:00'))).toBe(false);
    expect(isImplausible(T('11:40:00'), T('12:05:00'))).toBe(false);
  });

  it('flags a match further than an hour from what was predicted', () => {
    expect(isImplausible(T('14:00:00'), T('12:05:00'))).toBe(true);
    expect(isImplausible(T('06:00:00'), T('18:05:00'))).toBe(true);
  });

  it('does not flag rows that have no arrival time to compare', () => {
    expect(isImplausible(null, T('12:05:00'))).toBe(false);
    expect(isImplausible(T('12:05:00'), null)).toBe(false);
  });
});

describe('skipped outranks the null-arrival shortcut (regression)', () => {
  // Shipped once: a CANCELLED stop carries no arrival time, so testing for a null
  // arrival first filed 22 of them as 'no_arrival_predicted' and dropped them out
  // of the unfulfilled denominator, understating it as 6.2% instead of 8.0%.
  it('classifies a cancelled stop with no arrival time as skipped, not un-promised', () => {
    const cancelled = snapshot({
      schedule_relationship: 'CANCELLED',
      predicted_arrival: null,
      predicted_departure: null,
      status: null,
    });
    expect(isSkipped(cancelled)).toBe(true);
  });

  it('still treats a departure-only prediction as un-promised, not skipped', () => {
    // Origin terminus: no arrival time, but a real departure time. Not a skip.
    const departureOnly = snapshot({
      predicted_arrival: null,
      predicted_departure: T('12:06:00'),
      status: null,
    });
    expect(isSkipped(departureOnly)).toBe(false);
  });
});
