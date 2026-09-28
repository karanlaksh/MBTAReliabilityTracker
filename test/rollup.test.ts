import { describe, expect, it } from 'vitest';
import { ROLLUP_FLOOR, __test, runRollup } from '../src/rollup';

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

describe('runRollup atomicity', () => {
  // A stand-in for D1 that records how statements reach it. The property under
  // test is structural: no DELETE may ever execute on its own, outside the batch
  // that also holds the INSERTs, because a standalone DELETE commits even when
  // the INSERTs after it fail — which is how rollup_error_by_slice was emptied.
  function fakeDb(failBatch: boolean) {
    const calls: { kind: 'run' | 'batch'; sql: string[] }[] = [];
    const stmt = (sql: string) => {
      const s = {
        sql,
        bind: () => s,
        // Every rowid probe sees one row dated 2026-09-29, so the open date has
        // snapshots and every earlier date has none.
        first: async () => ({ id: 1, service_date: '2026-09-29' }),
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
        calls.push({ kind: 'batch', sql: stmts.map((s) => s.sql) });
        if (failBatch) throw new Error('D1_ERROR: exceeded daily row read limit');
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    };
    return { env: { DB: db } as unknown as Parameters<typeof runRollup>[0], calls };
  }

  it('never runs a DELETE outside a batch', async () => {
    const { env, calls } = fakeDb(false);
    await runRollup(env, Date.parse('2026-09-29T08:00:00Z'));
    expect(calls.filter((c) => c.kind === 'run' && /DELETE/.test(c.sql[0]))).toEqual([]);
  });

  it("puts each DELETE first in the same batch as its table's INSERT", async () => {
    const { env, calls } = fakeDb(false);
    await runRollup(env, Date.parse('2026-09-29T08:00:00Z'));
    const batches = calls.filter((c) => c.kind === 'batch');
    // One per recomputed by_day date (only 2026-09-29 has rows here), then the grid.
    expect(batches).toHaveLength(2);
    expect(batches[0].sql[0]).toContain('DELETE FROM rollup_error_by_day WHERE service_date = ?');
    expect(batches[0].sql[1]).toContain('INSERT INTO rollup_error_by_day');
    expect(batches[1].sql[0]).toContain('DELETE FROM rollup_error_by_slice');
    expect(batches[1].sql[1]).toContain('INSERT INTO rollup_error_by_slice');
    for (const b of batches) expect(b.sql).toHaveLength(2);
  });

  it('reports the failure and stops, rather than moving on to the next table', async () => {
    const { env, calls } = fakeDb(true);
    const stats = await runRollup(env, Date.parse('2026-09-29T08:00:00Z'));
    expect(stats.error).toMatch(/read limit/);
    expect(calls.filter((c) => c.kind === 'batch')).toHaveLength(1);
  });
});

describe('ROLLUP_FLOOR', () => {
  it('is 2026-09-28', () => {
    expect(ROLLUP_FLOOR).toBe('2026-09-28');
  });

  it('never recomputes a date before the floor, even when asked', async () => {
    const calls: string[] = [];
    const stmt = (sql: string) => {
      const s = { sql, bind: () => s, first: async () => ({ id: 1, service_date: '2026-09-29' }) };
      return s;
    };
    const db = {
      prepare: stmt,
      batch: async (stmts: { sql: string }[]) => {
        calls.push(...stmts.map((x) => x.sql));
        return stmts.map(() => ({ meta: { changes: 0 } }));
      },
    };
    const env = { DB: db } as unknown as Parameters<typeof runRollup>[0];
    const stats = await runRollup(env, Date.parse('2026-09-29T08:00:00Z'), {
      byDayDates: ['2026-09-08', '2026-09-27'],
      slice: false,
    });
    expect(stats.skipped_dates).toEqual(['2026-09-08', '2026-09-27']);
    expect(stats.by_day_dates).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('starts the grid window at the floor until 7 days have accumulated', async () => {
    const db = {
      prepare: (sql: string) => {
        const s = { sql, bind: () => s, first: async () => ({ id: 1, service_date: '2026-09-28' }) };
        return s;
      },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 0 } })),
    };
    const env = { DB: db } as unknown as Parameters<typeof runRollup>[0];
    const stats = await runRollup(env, Date.parse('2026-09-30T08:00:00Z'), { byDayDates: [] });
    expect(stats.slice_window).toEqual({ from: '2026-09-28', to: '2026-09-30' });
  });
});
