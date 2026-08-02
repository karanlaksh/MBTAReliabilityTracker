import { describe, expect, it } from 'vitest';
import { __test } from '../src/collector';

const { chunkedInserts, PREDICTION_COLUMNS } = __test;

/**
 * Captures the SQL and bound values that would reach D1. Multi-row inserts are a
 * CPU optimisation on the unrecoverable write path, so a bug here would corrupt
 * data silently rather than throw — hence testing the generated SQL directly.
 */
interface Captured {
  sql: string;
  args: unknown[];
}
const captured: Captured[] = [];
const fakeDb = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => {
      const c = { sql, args };
      captured.push(c);
      return c;
    },
  }),
} as unknown as D1Database;

const reset = () => {
  captured.length = 0;
};
const row = (n: number, width: number) => Array.from({ length: width }, (_, i) => `r${n}c${i}`);

describe('chunkedInserts', () => {
  it('emits nothing for no rows', () => {
    reset();
    expect(chunkedInserts(fakeDb, 't', ['a', 'b'], [])).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('packs multiple rows into one statement', () => {
    reset();
    chunkedInserts(fakeDb, 't', ['a', 'b'], [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toBe('INSERT INTO t (a, b) VALUES (?, ?), (?, ?), (?, ?)');
    expect(captured[0].args).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('never exceeds the bound-parameter ceiling', () => {
    reset();
    const width = PREDICTION_COLUMNS.length; // 17
    const rows = Array.from({ length: 50 }, (_, i) => row(i, width));
    chunkedInserts(fakeDb, 'prediction_snapshots', PREDICTION_COLUMNS, rows);

    for (const c of captured) {
      expect(c.args.length).toBeLessThanOrEqual(80);
      // Placeholder count must match bound-value count exactly, or D1 rejects it.
      expect((c.sql.match(/\?/g) ?? []).length).toBe(c.args.length);
    }
    // 17 columns -> floor(80/17) = 4 rows per statement -> 13 statements for 50 rows.
    expect(captured).toHaveLength(13);
  });

  it('preserves row order and column order across chunk boundaries', () => {
    reset();
    const width = PREDICTION_COLUMNS.length;
    const rows = Array.from({ length: 9 }, (_, i) => row(i, width));
    chunkedInserts(fakeDb, 'prediction_snapshots', PREDICTION_COLUMNS, rows);

    const flat = captured.flatMap((c) => c.args);
    expect(flat).toEqual(rows.flat());
    // Every row survives exactly once — no drops at the chunk seam.
    expect(flat).toHaveLength(9 * width);
    expect(flat[0]).toBe('r0c0');
    expect(flat[flat.length - 1]).toBe(`r8c${width - 1}`);
  });

  it('still emits one row per statement when a table is very wide', () => {
    reset();
    const wide = Array.from({ length: 100 }, (_, i) => `c${i}`);
    chunkedInserts(fakeDb, 'wide', wide, [row(0, 100), row(1, 100)]);
    expect(captured).toHaveLength(2);
  });
});
