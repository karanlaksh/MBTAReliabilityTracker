import { describe, expect, it } from 'vitest';
import { __test } from '../src/api';

const { readFilters, whereClause, BUCKET_ORDER, BUCKET_HORIZON, round1, safeParse, estimateGateOpen } = __test;
const url = (qs: string) => new URL(`https://x.dev/api/error-by-horizon${qs}`);

describe('filter defaults', () => {
  it('excludes ADDED trips and partial days unless opted in', () => {
    // Both are opt-IN so a caller cannot accidentally mix a partial day into a
    // comparison, or pool unscheduled service with scheduled.
    const f = readFilters(url(''));
    expect(f.includeAdded).toBe(false);
    expect(f.includePartial).toBe(false);
  });

  it('honours explicit opt-in', () => {
    const f = readFilters(url('?include_added=1&include_partial=1'));
    expect(f.includeAdded).toBe(true);
    expect(f.includePartial).toBe(true);
  });

  it('reads date range, mode and route filters', () => {
    const f = readFilters(url('?from=2026-08-03&to=2026-08-07&mode=bus&route=39'));
    expect(f).toMatchObject({ from: '2026-08-03', to: '2026-08-07', mode: 'bus', route: '39' });
  });
});

describe('whereClause', () => {
  it('applies the conservative defaults as SQL', () => {
    const { sql, binds } = whereClause(readFilters(url('')));
    expect(sql).toContain('d.is_added = 0');
    expect(sql).toContain('d.is_partial = 0');
    expect(binds).toEqual([]);
  });

  it('drops the guards when opted in', () => {
    const { sql } = whereClause(readFilters(url('?include_added=1&include_partial=1')));
    expect(sql).not.toContain('is_added = 0');
    expect(sql).not.toContain('is_partial = 0');
  });

  it('binds filter values rather than interpolating them', () => {
    // Parameterised, so a route id can never be injected into the SQL text.
    const { sql, binds } = whereClause(readFilters(url('?route=39&from=2026-08-03')));
    expect(sql).toContain('d.route_id = ?');
    expect(sql).toContain('d.service_date >= ?');
    expect(binds).toEqual(['2026-08-03', '39']);
    expect(sql).not.toContain('39');
  });

  it('filters mode via the watched_stops join, not the rollup table', () => {
    const { sql } = whereClause(readFilters(url('?mode=subway')));
    expect(sql).toContain('w.mode = ?');
  });
});

describe('bucket vocabulary', () => {
  it('labels by evaluation point and never by band', () => {
    expect(BUCKET_ORDER).toEqual(['~1.5 min', '~4.5 min', '~9 min', '~16 min']);
    expect(BUCKET_ORDER.join(' ')).not.toMatch(/0-3|3-6|6-12|12\+/);
  });

  it('maps each label to the horizon it is graded at', () => {
    expect(BUCKET_HORIZON).toEqual({ '~1.5 min': 90, '~4.5 min': 270, '~9 min': 540, '~16 min': 960 });
  });
});

describe('helpers', () => {
  it('rounds to one decimal and passes through nulls', () => {
    expect(round1(12.345)).toBe(12.3);
    expect(round1(null)).toBeNull();
    expect(round1('nonsense')).toBeNull();
  });

  it('survives MBTA sending malformed affected_routes', () => {
    expect(safeParse('["Orange","39"]')).toEqual(['Orange', '39']);
    expect(safeParse('not json')).toEqual([]);
    expect(safeParse(null)).toEqual([]);
  });
});

describe('estimateGateOpen', () => {
  const gate = { minN: 20, minCoverage: 0.6, minMeanN: 20 };
  // One folded date per weekday, 2026-09-28 (Mon) .. 2026-10-04 (Sun).
  const week = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];

  it('declines to estimate until every weekday has a folded date', () => {
    const r = estimateGateOpen([{ weekday: 1, n: 5 }], week.slice(0, 6), gate);
    expect(r.date).toBeNull();
    expect(r.basis).toMatch(/every weekday/);
  });

  it('extrapolates each cell at its own weekday rate', () => {
    // n = 5 per cell after one week each: 3 more weeks to reach 20.
    const cells = Array.from({ length: 7 }, (_, w) => ({ weekday: w, n: 5 }));
    const r = estimateGateOpen(cells, week, gate);
    expect(r.weeks).toBe(3);
    // Newest folded date + 3 weeks + the two-day fold lag.
    expect(r.date).toBe('2026-10-27');
  });

  it('waits for the slower of the coverage gate and the mean gate', () => {
    // 60% of cells already pass, but the mean is dragged down by quiet cells.
    const cells = [
      ...Array.from({ length: 6 }, () => ({ weekday: 1, n: 30 })),
      ...Array.from({ length: 4 }, () => ({ weekday: 1, n: 1 })),
    ];
    const r = estimateGateOpen(cells, week, gate);
    expect(r.weeks).toBeGreaterThan(0); // coverage met now; mean (18.4) is not
  });

  it('reports no date once the gate is already met', () => {
    const cells = Array.from({ length: 7 }, (_, w) => ({ weekday: w, n: 25 }));
    expect(estimateGateOpen(cells, week, gate)).toMatchObject({ date: null, weeks: 0 });
  });
});
