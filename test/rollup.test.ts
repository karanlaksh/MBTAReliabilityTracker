import { describe, expect, it } from 'vitest';
import { GRID_BACKFILL, ROLLUP_FLOOR, __test, runRollup } from '../src/rollup';

const { BUCKETS, shouldRecompute, gradedSql, statsSql } = __test;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const R = { from: '2026-09-27', to: '2026-09-27', loId: 1000, hiId: 2000 };

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
    // MIN over horizon_sec * PACK + predicted_arrival: the smallest qualifying
    // horizon wins, and carries that row's predicted_arrival out of the group.
    const sql = gradedSql(R);
    expect(sql).toContain(
      'MIN(CASE WHEN p.horizon_sec >= 540 THEN p.horizon_sec * 10000000000 + p.predicted_arrival END) AS k540',
    );
    expect(sql).toContain('% 10000000000');
  });

  it('defines eligibility by horizon reach, not by trip type', () => {
    // One rule. It covers ADDED trips (structurally unable to have a 16-min-out
    // prediction) and late-entering scheduled trips alike.
    const sql = gradedSql(R);
    expect(sql).toContain('p.horizon_sec >= 960');
    expect(sql).toMatch(/WHERE CASE b\.h [\s\S]* END IS NOT NULL/);
    expect(sql).not.toMatch(/WHERE[\s\S]*NOT LIKE 'ADDED/);
  });

  it('keeps is_added as a dimension rather than a filter', () => {
    expect(gradedSql(R)).toContain("LIKE 'ADDED%' THEN 1 ELSE 0 END AS is_added");
  });

  it('recovers the local offset from service_date rather than hardcoding EDT', () => {
    // -14400 (EDT) or -18000 (EST), chosen by which one reproduces the
    // service_date the collector already computed with real timezone rules.
    const sql = gradedSql(R);
    expect(sql).toContain('-14400');
    expect(sql).toContain('-18000');
  });
});

describe('aggregate shape', () => {
  it('grades all four buckets in one statement, partitioned by bucket', () => {
    const sql = statsSql(['stop_id'], R);
    for (const b of BUCKETS) expect(sql).toContain(`'${b.label}' AS horizon_bucket`);
    expect(sql).toContain('PARTITION BY stop_id, horizon_bucket');
    // The single pass is the point: no per-row window pick over the join.
    expect(sql).not.toContain('ORDER BY p.horizon_sec');
  });

  it('always emits n alongside every percentile', () => {
    const sql = statsSql(['stop_id'], R);
    for (const f of ['n', 'median_error_sec', 'p10_error_sec', 'p90_error_sec', 'pct_within_60s']) {
      expect(sql).toContain(f);
    }
  });

  it('derives weekday from service_date, which is timezone-free', () => {
    expect(statsSql(['weekday'], R)).toContain("strftime('%w', a.service_date)");
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

describe('bounded read', () => {
  const { findDateStartId, addDays } = __test;

  // Ids with gaps (deleted rows), service dates non-decreasing in id order.
  const rows = [
    { id: 3, service_date: '2026-09-25' },
    { id: 4, service_date: '2026-09-25' },
    { id: 9, service_date: '2026-09-26' },
    { id: 10, service_date: '2026-09-26' },
    { id: 11, service_date: '2026-09-26' },
    { id: 20, service_date: '2026-09-28' },
    { id: 21, service_date: '2026-09-28' },
  ];
  const probe = async (id: number) => rows.find((r) => r.id >= id) ?? null;
  const bounds = { minId: 3, maxId: 21 };
  const brute = (t: string) => rows.find((r) => r.service_date >= t)?.id ?? null;

  it('finds the first id of each date, matching a linear scan', async () => {
    for (const t of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']) {
      expect(await findDateStartId(probe, bounds, t)).toBe(brute(t));
    }
  });

  it('lands on the next date when the target has no rows (a collection gap)', async () => {
    expect(await findDateStartId(probe, bounds, '2026-09-27')).toBe(20);
  });

  it('returns null when nothing is that recent', async () => {
    expect(await findDateStartId(probe, bounds, '2026-10-01')).toBeNull();
  });

  it('costs logarithmic probes, not a scan', async () => {
    let probes = 0;
    const big = { minId: 1, maxId: 1_000_000 };
    const counting = async (id: number) => {
      probes++;
      return { id, service_date: id >= 700_000 ? '2026-09-28' : '2026-09-01' };
    };
    expect(await findDateStartId(counting, big, '2026-09-28')).toBe(700_000);
    expect(probes).toBeLessThanOrEqual(21);
  });

  it('bounds the snapshot side by id and service date, and fixes join order', () => {
    const sql = gradedSql(R);
    expect(sql).toContain('p.id >= 1000');
    expect(sql).toContain('p.id < 2000');
    expect(sql).toContain("p.service_date >= '2026-09-27' AND p.service_date <= '2026-09-27'");
    expect(sql).toContain('CROSS JOIN arrivals a');
  });

  it('omits the upper bound for a range open to the newest row', () => {
    expect(gradedSql({ ...R, hiId: null })).not.toContain('p.id <');
  });

  it('refuses values that are not the expected shape before interpolating them', () => {
    expect(() => gradedSql({ ...R, from: "2026-09-27' OR 1=1 --" })).toThrow(/not a date/);
    expect(() => gradedSql({ ...R, loId: 1.5 })).toThrow(/not an integer/);
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -3)).toBe('2026-09-28');
  });
});

/**
 * A stand-in for D1 that records how statements reach it and answers the rowid
 * probes from a fixed list of (id, service_date) rows — one per date given.
 */
function fakeDb(opts: { dates: string[]; folded?: string[]; failBatch?: boolean }) {
  const rows = opts.dates.map((d, i) => ({ id: (i + 1) * 10, service_date: d }));
  const calls: { kind: 'run' | 'batch'; sql: string[] }[] = [];
  const stmt = (sql: string) => {
    let bound: unknown[] = [];
    const s = {
      sql,
      bind: (...b: unknown[]) => {
        bound = b;
        return s;
      },
      first: async () => {
        if (sql.includes('ORDER BY id ASC LIMIT 1')) return rows[0] ?? null;
        if (sql.includes('ORDER BY id DESC LIMIT 1')) return rows[rows.length - 1] ?? null;
        if (sql.includes('WHERE id >= ?')) return rows.find((r) => r.id >= Number(bound[0])) ?? null;
        return null;
      },
      all: async () => ({
        results: sql.includes('FROM rollup_grid_folded')
          ? (opts.folded ?? []).map((d) => ({ service_date: d }))
          : [],
      }),
      run: async () => {
        calls.push({ kind: 'run', sql: [sql] });
        return { meta: { changes: 0 } };
      },
    };
    return s;
  };
  const db = {
    prepare: stmt,
    batch: async (stmts: { sql: string }[]) => {
      calls.push({ kind: 'batch', sql: stmts.map((x) => x.sql) });
      if (opts.failBatch) throw new Error('D1_ERROR: exceeded daily row read limit');
      return stmts.map(() => ({ meta: { changes: 1, rows_read: 100_000 } }));
    },
  };
  return { env: { DB: db } as unknown as Parameters<typeof runRollup>[0], calls };
}

const AUG = Array.from({ length: 19 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
const LATE_SEPT = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];
// 04:00 EDT on 2026-10-01: open date 2026-10-01, newest final date 2026-09-29.
const OCT1 = Date.parse('2026-10-01T08:00:00Z');

describe('runRollup atomicity', () => {
  it('never runs a DELETE outside a batch', async () => {
    const { env, calls } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    await runRollup(env, OCT1);
    expect(calls.filter((c) => c.kind === 'run' && /DELETE/.test(c.sql[0]))).toEqual([]);
  });

  it("puts each by_day DELETE first in the same batch as that date's INSERT", async () => {
    const { env, calls } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    await runRollup(env, OCT1, { fold: false });
    const batches = calls.filter((c) => c.kind === 'batch');
    expect(batches).toHaveLength(3); // 09-29, 09-30, 10-01
    for (const b of batches) {
      expect(b.sql).toHaveLength(2);
      expect(b.sql[0]).toContain('DELETE FROM rollup_error_by_day WHERE service_date = ?');
      expect(b.sql[1]).toContain('INSERT INTO rollup_error_by_day');
    }
  });

  it('reports the failure and stops, rather than moving on', async () => {
    const { env, calls } = fakeDb({ dates: [...AUG, ...LATE_SEPT], failBatch: true });
    const stats = await runRollup(env, OCT1);
    expect(stats.error).toMatch(/read limit/);
    expect(calls.filter((c) => c.kind === 'batch')).toHaveLength(1);
  });
});

describe('ROLLUP_FLOOR', () => {
  it('is 2026-09-28', () => {
    expect(ROLLUP_FLOOR).toBe('2026-09-28');
  });

  it('never recomputes a by_day date before the floor, even when asked', async () => {
    const { env, calls } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    const stats = await runRollup(env, OCT1, { byDayDates: ['2026-09-08', '2026-09-27'], fold: false });
    expect(stats.skipped_dates).toEqual(['2026-09-08', '2026-09-27']);
    expect(stats.by_day_dates).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('grid fold eligibility', () => {
  const { eligibleFoldDates } = __test;

  it('is the August backfill, then the floor up to two days before the open date', () => {
    const d = eligibleFoldDates('2026-10-01', new Set());
    expect(d.slice(0, 19)).toEqual(AUG);
    expect(d.slice(19)).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('never includes the degraded dates between the backfill and the floor', () => {
    const d = eligibleFoldDates('2026-12-01', new Set());
    expect(d.filter((x) => x > GRID_BACKFILL.to && x < ROLLUP_FLOOR)).toEqual([]);
  });

  it('never includes a date that is not yet final', () => {
    expect(eligibleFoldDates('2026-10-01', new Set())).not.toContain('2026-09-30');
  });

  it('skips dates already folded', () => {
    const d = eligibleFoldDates('2026-10-01', new Set(AUG.slice(0, 10)));
    expect(d[0]).toBe('2026-08-11');
  });
});

describe('grid fold', () => {
  const { foldSql } = __test;

  it('adds to existing cells rather than replacing them — sums and counts merge exactly', () => {
    const sql = foldSql(R, '2026-09-27', 1);
    expect(sql).toContain('n           = n + excluded.n');
    expect(sql).toContain('sum_err     = sum_err + excluded.sum_err');
    expect(sql).toContain('sum_abs_err = sum_abs_err + excluded.sum_abs_err');
    expect(sql).toContain('n_within_60 = n_within_60 + excluded.n_within_60');
  });

  it('refuses a date that is already marked folded, inside the statement itself', () => {
    expect(foldSql(R, '2026-09-27', 1)).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM rollup_grid_folded WHERE service_date = '2026-09-27')",
    );
  });

  it('writes the marker in the same batch as the fold', async () => {
    const { env, calls } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    await runRollup(env, OCT1, { byDayDates: [], foldDates: ['2026-08-01'] });
    const foldBatch = calls.find((c) => c.kind === 'batch' && c.sql[0].includes('INSERT INTO rollup_grid_totals'))!;
    expect(foldBatch.sql[1]).toContain('INSERT OR IGNORE INTO rollup_grid_folded');
  });

  it('folds at most ten dates per run, oldest first, and reports the rest as pending', async () => {
    const { env } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    const stats = await runRollup(env, OCT1, { byDayDates: [] });
    expect(stats.grid_folded).toEqual(AUG.slice(0, 10));
    expect(stats.grid_pending).toBe(11); // Aug 11-19, 09-28, 09-29
  });

  it('stops for the night once the account read total reaches the guard', async () => {
    const { env } = fakeDb({ dates: [...AUG, ...LATE_SEPT] });
    // Each fake fold reads 100k; starting at 1.75M, the guard (2.0M) trips after three.
    const stats = await runRollup(env, OCT1, { byDayDates: [], readsBefore: 1_750_000 });
    expect(stats.grid_folded).toHaveLength(3);
    expect(stats.grid_stopped_by_budget).toBe(true);
  });

  it('folds nothing already folded', async () => {
    const { env } = fakeDb({ dates: [...AUG, ...LATE_SEPT], folded: [...AUG, '2026-09-28', '2026-09-29'] });
    const stats = await runRollup(env, OCT1, { byDayDates: [] });
    expect(stats.grid_folded).toEqual([]);
    expect(stats.grid_pending).toBe(0);
  });
});
