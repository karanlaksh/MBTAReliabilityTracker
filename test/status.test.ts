import { describe, expect, it } from 'vitest';
import { DAILY_WRITE_LIMIT, project, utcDayStart } from '../src/status';
import { classifyError } from '../src/collector';
import { MbtaError } from '../src/mbta';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('utcDayStart', () => {
  it('snaps to 00:00 UTC, not to the 03:00 Boston service-date boundary', () => {
    // 2026-08-01 01:00 EDT is 05:00 UTC. The service date is 2026-07-31, but the
    // D1 quota day is 2026-08-01. Conflating them would misreport the budget by
    // hours of writes every day.
    const t = at('2026-08-01T01:00:00-04:00');
    expect(utcDayStart(t)).toBe(at('2026-08-01T00:00:00Z'));
  });

  it('is idempotent and exactly a day apart', () => {
    const t = at('2026-08-01T17:43:11Z');
    expect(utcDayStart(utcDayStart(t))).toBe(utcDayStart(t));
    expect(utcDayStart(t + 86_400) - utcDayStart(t)).toBe(86_400);
  });
});

describe('project', () => {
  const noon = at('2026-08-01T12:00:00Z'); // exactly half the UTC day elapsed

  it('doubles a steady half-day rate to reach end of day', () => {
    // 40,000 written in 12h at a matching recent rate -> 80,000 projected.
    const p = project(40_000, 40_000 / 12, noon);
    expect(p.projected_by_flat_rate).toBe(80_000);
    // 80% of the cap is already past the 70% warn threshold — which is the point
    // of warning at 70 rather than at 100.
    expect(p.level).toBe('warn');
  });

  it('stays ok well below the warn threshold', () => {
    const p = project(20_000, 20_000 / 12, noon); // -> 40,000, 40% of cap
    expect(p.projected_by_flat_rate).toBe(40_000);
    expect(p.level).toBe('ok');
  });

  it('reports the HIGHER of the two estimates', () => {
    // Flat rate says 80,000; the last hour has spiked well above that.
    const p = project(40_000, 6_000, noon);
    expect(p.projected_by_recent_rate).toBeGreaterThan(p.projected_by_flat_rate);
    expect(p.projected_eod).toBe(p.projected_by_recent_rate);
  });

  it('escalates to warn then critical as the projection approaches the cap', () => {
    expect(project(30_000, 2_500, noon).level).toBe('ok'); // ~60k
    expect(project(37_500, 3_125, noon).level).toBe('warn'); // ~75k, >=70%
    expect(project(47_500, 3_960, noon).level).toBe('critical'); // ~95k, >=90%
  });

  it('projects essentially nothing further once the day is nearly over', () => {
    // One second of headroom remains, so the projection may exceed the actual by
    // a single second's worth of writes — but not more.
    const endOfDay = at('2026-08-01T23:59:59Z');
    const p = project(88_000, 3_000, endOfDay);
    expect(p.projected_eod).toBeGreaterThanOrEqual(88_000);
    expect(p.projected_eod).toBeLessThan(88_010);
  });

  it('does not divide by zero at the instant the day resets', () => {
    const p = project(0, 0, at('2026-08-01T00:00:00Z'));
    expect(Number.isFinite(p.projected_eod)).toBe(true);
    expect(p.projected_eod).toBe(0);
  });

  it('flags a projection over the limit as critical', () => {
    const p = project(60_000, 5_000, noon);
    expect(p.projected_eod).toBeGreaterThan(DAILY_WRITE_LIMIT);
    expect(p.level).toBe('critical');
  });
});

describe('classifyError', () => {
  it('identifies D1 limit refusals, which are the data-losing failure', () => {
    for (const message of [
      'D1_ERROR: daily limit exceeded',
      'Too many requests, please try again later',
      'storage limit reached for this database',
      'D1 quota exhausted',
      'Request failed with 429',
    ]) {
      expect(classifyError(new Error(message))).toBe('d1_limit');
    }
  });

  it('separates ordinary D1 failures from limit failures', () => {
    expect(classifyError(new Error('D1_ERROR: no such column: foo'))).toBe('d1_other');
  });

  it('recognises real D1 error text, which carries no D1_ERROR prefix', () => {
    // Captured verbatim from live D1 failures. An earlier version of this
    // classifier filed all three as 'other' because it only looked for 'D1_ERROR'.
    for (const message of [
      'table collector_runs has no column named nope: SQLITE_ERROR',
      'no such table: does_not_exist: SQLITE_ERROR',
      'too many terms in compound SELECT: SQLITE_ERROR',
    ]) {
      expect(classifyError(new Error(message))).toBe('d1_other');
    }
  });

  it('classifies MBTA API failures by type, not message text', () => {
    expect(classifyError(new MbtaError('/predictions returned 503', 503))).toBe('mbta_api');
  });

  it('classifies our own fetch timeout', () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    expect(classifyError(err)).toBe('timeout');
  });

  it('falls back to other, and never throws on a non-Error', () => {
    expect(classifyError(new Error('something odd happened'))).toBe('other');
    expect(classifyError('a bare string')).toBe('other');
    expect(classifyError(null)).toBe('other');
  });

  it('prefers the limit label when a message could match either', () => {
    // 'D1_ERROR' plus a limit marker must not be filed as a generic D1 error —
    // the limit label is the actionable one.
    expect(classifyError(new Error('D1_ERROR: quota exceeded'))).toBe('d1_limit');
  });
});
