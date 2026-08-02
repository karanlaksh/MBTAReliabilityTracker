import { beforeEach, describe, expect, it } from 'vitest';
import { __test } from '../src/collector';
import { emptyState, type DedupState } from '../src/state';
import type { Document, Resource } from '../src/mbta';

const { collectAlerts, selectPeriod, alertAffectsWatched } = __test;

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T0 = at('2026-08-01T12:00:00-04:00');

/** Rows are plain value arrays in column order — no statement to unpack. */
const argsOf = (r: unknown) => r as unknown[];

// Column order matches the INSERT in collector.ts.
const A = {
  alertId: 2,
  mbtaUpdatedAt: 3,
  effect: 4,
  severity: 6,
  lifecycle: 7,
  periodStart: 9,
  periodEnd: 10,
  affectedRoutes: 12,
  affectedStops: 13,
  affectsWatched: 14,
} as const;

const WATCHED = [
  { stop_id: 'place-rugg', route_id: 'Orange', direction_id: 0 },
  { stop_id: 'place-rugg', route_id: 'Orange', direction_id: 1 },
  { stop_id: 'place-nuniv', route_id: 'Green-E', direction_id: 0 },
  { stop_id: '41391', route_id: '39', direction_id: 0 },
];
const SLICES = new Set(WATCHED.map((w) => `${w.stop_id}|${w.route_id}|${w.direction_id}`));
const ROUTES = new Set(WATCHED.map((w) => w.route_id));
const STOPS = new Set(WATCHED.map((w) => w.stop_id));

function alert(o: {
  id?: string;
  effect?: string;
  lifecycle?: string;
  updatedAt?: string;
  periods?: { start?: string | null; end?: string | null }[];
  entities?: { route?: string; stop?: string; direction_id?: number }[];
}): Resource {
  return {
    id: o.id ?? 'alert-1',
    type: 'alert',
    attributes: {
      effect: o.effect ?? 'SUSPENSION',
      cause: 'UNKNOWN_CAUSE',
      severity: 7,
      lifecycle: o.lifecycle ?? 'ONGOING',
      header: 'Green Line: No trains between North Station & Heath St.',
      updated_at: o.updatedAt ?? '2026-07-27T15:52:17-04:00',
      active_period: o.periods ?? [
        { start: '2026-08-01T03:00:00-04:00', end: '2026-08-03T03:00:00-04:00' },
      ],
      informed_entity: o.entities ?? [
        { route: 'Green-E', stop: 'place-nuniv', direction_id: 0, route_type: 0 },
      ],
    },
  };
}

const run = (alerts: Resource[], state: DedupState, now: number) =>
  collectAlerts({ data: alerts } as Document, WATCHED, SLICES, state, now);

describe('selectPeriod', () => {
  const P = (start: string, end: string | null) => ({ start, end });

  it('prefers the period covering now', () => {
    const r = selectPeriod(
      [P('2026-07-01T03:00:00-04:00', '2026-07-02T03:00:00-04:00'), P('2026-08-01T03:00:00-04:00', '2026-08-03T03:00:00-04:00')],
      T0,
    );
    expect(r.start).toBe(at('2026-08-01T03:00:00-04:00'));
    expect(r.end).toBe(at('2026-08-03T03:00:00-04:00'));
  });

  it('treats a null end as open-ended and still covering', () => {
    const r = selectPeriod([P('2026-08-01T03:00:00-04:00', null)], T0);
    expect(r.start).toBe(at('2026-08-01T03:00:00-04:00'));
    expect(r.end).toBeNull();
  });

  it('falls back to the soonest upcoming period', () => {
    const r = selectPeriod(
      [P('2026-08-20T03:00:00-04:00', '2026-08-31T03:00:00-04:00'), P('2026-08-08T03:00:00-04:00', '2026-08-17T03:00:00-04:00')],
      T0,
    );
    expect(r.start).toBe(at('2026-08-08T03:00:00-04:00')); // the nearer one, not first in the array
  });

  it('falls back to the most recent past period when nothing is upcoming', () => {
    const r = selectPeriod(
      [P('2026-07-01T03:00:00-04:00', '2026-07-02T03:00:00-04:00'), P('2026-07-20T03:00:00-04:00', '2026-07-21T03:00:00-04:00')],
      T0,
    );
    expect(r.start).toBe(at('2026-07-20T03:00:00-04:00'));
  });

  it('survives an empty or malformed period list', () => {
    expect(selectPeriod([], T0)).toEqual({ start: null, end: null });
    expect(selectPeriod([{ start: null, end: null }], T0)).toEqual({ start: null, end: null });
  });
});

describe('alertAffectsWatched', () => {
  const check = (entities: { route?: string; stop?: string; direction_id?: number }[]) =>
    alertAffectsWatched(entities, SLICES, ROUTES, STOPS);

  it('matches an exact route + stop + direction slice', () => {
    expect(check([{ route: 'Green-E', stop: 'place-nuniv', direction_id: 0 }])).toBe(true);
  });

  it('does not match a watched stop in an unwatched direction', () => {
    expect(check([{ route: 'Green-E', stop: 'place-nuniv', direction_id: 1 }])).toBe(false);
  });

  it('matches route + stop with no direction as either direction', () => {
    expect(check([{ route: 'Green-E', stop: 'place-nuniv' }])).toBe(true);
  });

  it('matches a line-wide alert that names only a route', () => {
    // The important case: a full-line suspension often names no stop at all, and
    // it is exactly the kind that produces zero-prediction periods.
    expect(check([{ route: 'Orange' }])).toBe(true);
  });

  it('matches a station closure that names only a stop', () => {
    expect(check([{ stop: 'place-rugg' }])).toBe(true);
  });

  it('matches a watched bus stop', () => {
    expect(check([{ route: '39', stop: '41391', direction_id: 0 }])).toBe(true);
  });

  it('ignores alerts elsewhere on the system', () => {
    expect(check([{ route: 'Red', stop: 'place-portr', direction_id: 0 }])).toBe(false);
    expect(check([{ route: 'Blue' }])).toBe(false);
    expect(check([{ stop: 'place-astao' }])).toBe(false);
  });

  it('matches when any one of many entities matches', () => {
    expect(
      check([
        { route: 'Red', stop: 'place-portr' },
        { route: 'Blue', stop: 'place-aqucl' },
        { route: 'Orange', stop: 'place-rugg', direction_id: 1 },
      ]),
    ).toBe(true);
  });
});

describe('collectAlerts', () => {
  let state: DedupState;
  beforeEach(() => {
    state = emptyState('2026-08-01');
  });

  it('records an alert with its provenance and selected period', () => {
    const { seen, rows } = run([alert({})], state, T0);
    expect(seen).toBe(1);
    const a = argsOf(rows[0]);
    expect(a[A.alertId]).toBe('alert-1');
    expect(a[A.effect]).toBe('SUSPENSION');
    expect(a[A.severity]).toBe(7);
    expect(a[A.mbtaUpdatedAt]).toBe(at('2026-07-27T15:52:17-04:00'));
    expect(a[A.periodStart]).toBe(at('2026-08-01T03:00:00-04:00'));
    expect(a[A.affectsWatched]).toBe(1);
    expect(JSON.parse(a[A.affectedRoutes] as string)).toEqual(['Green-E']);
    expect(JSON.parse(a[A.affectedStops] as string)).toEqual(['place-nuniv']);
  });

  it('writes one row for a standing alert, not one per tick', () => {
    // A suspension lasting nine days must not cost 13,000 rows.
    run([alert({})], state, T0);
    expect(run([alert({})], state, T0 + 60).rows).toHaveLength(0);
    expect(run([alert({})], state, T0 + 3600).rows).toHaveLength(0);
  });

  it('writes a new row when MBTA revises the alert', () => {
    run([alert({})], state, T0);
    const revised = run([alert({ updatedAt: '2026-08-01T09:00:00-04:00' })], state, T0 + 60);
    expect(revised.rows).toHaveLength(1);
  });

  it('writes a new row when lifecycle transitions, even if updated_at has not moved', () => {
    // UPCOMING -> ONGOING is a real state change and the thing a status page
    // needs, but MBTA does not necessarily bump updated_at for it.
    run([alert({ lifecycle: 'UPCOMING' })], state, T0);
    const now = run([alert({ lifecycle: 'ONGOING' })], state, T0 + 60);
    expect(now.rows).toHaveLength(1);
    expect(argsOf(now.rows[0])[A.lifecycle]).toBe('ONGOING');
  });

  it('writes a new row when the selected active period rolls over to the next one', () => {
    const twoPeriods = [
      { start: '2026-08-01T03:00:00-04:00', end: '2026-08-03T03:00:00-04:00' },
      { start: '2026-08-08T03:00:00-04:00', end: '2026-08-17T03:00:00-04:00' },
    ];
    run([alert({ periods: twoPeriods })], state, T0);
    // After the first window closes, the same unmodified alert now describes the
    // second window. That transition is worth a row.
    const later = run([alert({ periods: twoPeriods })], state, at('2026-08-05T12:00:00-04:00'));
    expect(later.rows).toHaveLength(1);
    expect(argsOf(later.rows[0])[A.periodStart]).toBe(at('2026-08-08T03:00:00-04:00'));
  });

  it('still records alerts that do not touch us, flagged affects_watched = 0', () => {
    const { rows } = run(
      [alert({ id: 'a-red', entities: [{ route: 'Red', stop: 'place-portr', direction_id: 0 }] })],
      state,
      T0,
    );
    expect(rows).toHaveLength(1);
    expect(argsOf(rows[0])[A.affectsWatched]).toBe(0);
  });

  it('tolerates an alert with no informed_entity and no active_period', () => {
    const bare: Resource = { id: 'bare', type: 'alert', attributes: { effect: 'DELAY' } };
    const { rows } = run([bare], state, T0);
    const a = argsOf(rows[0]);
    expect(a[A.periodStart]).toBeNull();
    expect(a[A.affectsWatched]).toBe(0);
    expect(JSON.parse(a[A.affectedRoutes] as string)).toEqual([]);
  });
});
