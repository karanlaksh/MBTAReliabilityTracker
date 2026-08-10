import { describe, expect, it } from 'vitest';
import { __test } from '../src/rollup';

const { BUCKETS, shouldRecompute, gradedSql, statsSql } = __test;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('buckets', () => {
  it('are single evaluation horizons, labelled by that horizon', () => {
    // Not bands. A band label invited a "row inside the band" rule that graded
    // the old '0-3' bucket at a 40-second mean horizon — the last prediction
    // before arrival, the measure explicitly rejected as converging to zero.
    expect(BUCKETS.map((b) => b.h)).toEqual([90, 270, 540, 960]);
    expect(BUCKETS.map((b) => b.label)).toEqual(['~1.5 min', '~4.5 min', '~9 min', '~16 min']);
  });

  it('places every evaluation point strictly inside its former band', () => {
    const bands = [[0, 180], [180, 360], [360, 720], [720, 1200]];
    BUCKETS.forEach((b, i) => {
      expect(b.h).toBeGreaterThan(bands[i][0]);
      expect(b.h).toBeLessThan(bands[i][1]);
    });
  });
});

describe('carry-forward selection', () => {
  it('selects the smallest horizon at or above the evaluation point', () => {
    // Smallest qualifying horizon = most recently written row that was still in
    // effect at H, because horizon decreases as rows are appended.
    const sql = gradedSql(540);
    expect(sql).toContain('p.horizon_sec >= 540');
    expect(sql).toContain('ORDER BY p.horizon_sec ASC');
  });

  it('defines eligibility by horizon reach, not by trip type', () => {
    // One rule. It covers ADDED trips (structurally unable to have a 16-min-out
    // prediction) and late-entering scheduled trips alike.
    const sql = gradedSql(960);
    expect(sql).toContain('p.horizon_sec >= 960');
    expect(sql).not.toMatch(/WHERE[\s\S]*NOT LIKE 'ADDED/);
  });

  it('keeps is_added as a dimension rather than a filter', () => {
    expect(gradedSql(90)).toContain("LIKE 'ADDED%' THEN 1 ELSE 0 END AS is_added");
  });

  it('recovers the local offset from service_date rather than hardcoding EDT', () => {
    // -14400 (EDT) or -18000 (EST), chosen by which one reproduces the
    // service_date the collector already computed with real timezone rules.
    const sql = gradedSql(90);
    expect(sql).toContain('-14400');
    expect(sql).toContain('-18000');
  });
});

describe('aggregate shape', () => {
  it('always emits n alongside every percentile', () => {
    const sql = statsSql(['stop_id'], 540, '~9 min');
    for (const f of ['n', 'median_error_sec', 'p10_error_sec', 'p90_error_sec', 'pct_within_60s']) {
      expect(sql).toContain(f);
    }
  });

  it('derives weekday from service_date, which is timezone-free', () => {
    expect(statsSql(['weekday'], 90, '~1.5 min')).toContain("strftime('%w', a.service_date)");
  });
});

describe('shouldRecompute', () => {
  const t = (iso: string) => at(iso);
  it('fires at 04:xx local, after the service date has closed', () => {
    // Service dates roll at 03:00 and settlement waits 30 min past last predicted
    // arrival, so the previous day is not fully graded before ~04:00.
    expect(shouldRecompute(t('2026-08-11T04:05:00-04:00'), 5)).toBe(true);
  });

  it('does not fire at midnight, when the previous day is still being graded', () => {
    expect(shouldRecompute(t('2026-08-11T00:05:00-04:00'), 5)).toBe(false);
  });

  it('does not fire at 03:xx, the rollover boundary itself', () => {
    expect(shouldRecompute(t('2026-08-11T03:05:00-04:00'), 5)).toBe(false);
  });

  it('fires once per day, not on all four quarter-hour ticks', () => {
    const fires = [0, 15, 30, 45].map((m) =>
      shouldRecompute(t('2026-08-11T04:00:00-04:00') + m * 60, m),
    );
    expect(fires).toEqual([true, false, false, false]);
  });

  it('still fires at 04:00 local in winter, when the UTC offset changes', () => {
    // A fixed UTC cron would drift by an hour across DST and land on 03:00 local.
    expect(shouldRecompute(t('2026-12-11T04:05:00-05:00'), 5)).toBe(true);
    expect(shouldRecompute(t('2026-12-11T03:05:00-05:00'), 5)).toBe(false);
  });
});
