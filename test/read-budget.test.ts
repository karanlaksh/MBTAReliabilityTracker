import { describe, expect, it } from 'vitest';
import { DAILY_READ_LIMIT, project, READ_PROJECTION_MIN_ELAPSED_SEC, readBudget } from '../src/status';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('read budget projection', () => {
  const t = at('2026-09-27T05:00:00Z');

  it('uses the read limit, not the write limit', () => {
    // 4.75M read by 05:00 UTC at ~950k/hour: the measured pre-fix pattern.
    const p = project(4_750_000, 950_000, t, DAILY_READ_LIMIT);
    expect(p.level).toBe('critical');
    expect(p.projected_eod).toBeGreaterThan(DAILY_READ_LIMIT);
  });

  it('still defaults to the write limit for existing callers', () => {
    // 4.75M against a 100k limit would be critical either way; 40k is the test.
    expect(project(40_000, 40_000 / 12, at('2026-08-01T12:00:00Z')).level).toBe('warn');
  });

  it('reports ok at the expected post-fix rate', () => {
    // ~1.5M/day spread evenly: ~62.5k/hour.
    const p = project(312_500, 62_500, t, DAILY_READ_LIMIT);
    expect(p.level).toBe('ok');
  });
});

describe('readBudget', () => {
  const t = at('2026-09-28T04:25:00Z');

  it("is 'unknown', never 'ok', when usage could not be fetched", () => {
    const r = readBudget(null, 'CF_API_TOKEN / CF_ACCOUNT_ID not configured', t);
    expect(r.level).toBe('unknown');
    expect(r.error).toContain('CF_API_TOKEN');
  });

  it('flags exhaustion at the limit', () => {
    const r = readBudget(
      { rows_read_today: 6_065_626, rows_read_last_hour: 2_564_016, rows_written_today: 6_236 },
      null,
      t,
    );
    expect(r.exhausted).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.level).toBe('critical');
  });
});

describe('readBudget before 4h of the UTC day', () => {
  const usage = (read: number, lastHour: number) => ({ rows_read_today: read, rows_read_last_hour: lastHour, rows_written_today: 0 });

  it('does not project the 2026-11-16 false alarm', () => {
    // 212,474 rows at 00:43:51 UTC projected to 139% and read 'critical'.
    const r = readBudget(usage(212_474, 212_474), null, at('2026-11-16T00:43:51Z'));
    expect(r.level).toBe('not_projected');
    expect(r.projected_eod).toBeNull();
    expect(r.pct_projected).toBeNull();
    expect(r.used_today).toBe(212_474);
  });

  it("never reports 'ok' before a projection exists", () => {
    expect(readBudget(usage(1_000, 1_000), null, at('2026-11-16T02:00:00Z')).level).toBe('not_projected');
  });

  it('still escalates on rows actually read', () => {
    // The September runaway at ~950k/hour, 3.75h in: 3.56M already spent.
    expect(readBudget(usage(3_562_500, 950_000), null, at('2026-09-27T03:45:00Z')).level).toBe('warn');
    expect(readBudget(usage(5_000_000, 950_000), null, at('2026-09-27T03:45:00Z'))).toMatchObject({
      level: 'critical',
      exhausted: true,
    });
  });

  it('projects normally from 4h', () => {
    const t = at('2026-11-16T00:00:00Z') + READ_PROJECTION_MIN_ELAPSED_SEC;
    const r = readBudget(usage(1_000_000, 250_000), null, t);
    expect(r.projected_eod).not.toBeNull();
    expect(r.level).toBe('critical'); // 1M + 250k/h x 20h = 6M
  });
});
