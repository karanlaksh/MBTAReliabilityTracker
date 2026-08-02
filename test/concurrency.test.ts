import { describe, expect, it } from 'vitest';
import { claimState, emptyState, nextUpdatedAt, releaseState } from '../src/state';

const T0 = 1_785_600_000;

/**
 * D1 stand-in that models the one behaviour the compare-and-set depends on:
 * an UPDATE ... WHERE updated_at = ? affects a row only if the value still
 * matches, and reports that through meta.changes.
 */
function fakeDb(initial: { value: string; updated_at: number } | null) {
  const store = { row: initial ? { ...initial } : null as null | { value: string; updated_at: number } };
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes('INSERT INTO collector_state')) {
            if (store.row) return { meta: { changes: 0 } }; // ON CONFLICT DO NOTHING
            store.row = { value: args[1] as string, updated_at: args[2] as number };
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM collector_state')) {
            if (store.row && store.row.updated_at === args[1]) {
              store.row = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          // UPDATE ... SET value=?, updated_at=? WHERE key=? AND updated_at=?
          if (store.row && store.row.updated_at === args[3]) {
            store.row = { value: args[0] as string, updated_at: args[1] as number };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, store };
}

describe('nextUpdatedAt', () => {
  it('always advances, even when two ticks land in the same second', () => {
    // If the token did not change, a second tick reading the same value would
    // find it still matching and would wrongly win the claim.
    expect(nextUpdatedAt(T0, T0)).toBe(T0 + 1);
    expect(nextUpdatedAt(T0, T0 + 5)).toBe(T0 + 6);
    expect(nextUpdatedAt(T0 + 60, T0)).toBe(T0 + 60);
  });

  it('uses now when there is no previous row', () => {
    expect(nextUpdatedAt(T0, null)).toBe(T0);
  });
});

describe('claimState', () => {
  it('wins when the token is unchanged', async () => {
    const { db, store } = fakeDb({ value: '{"old":true}', updated_at: T0 });
    const result = await claimState(db, emptyState('2026-08-01'), T0 + 60, T0);
    expect(result.won).toBe(true);
    expect(store.row?.updated_at).toBe(T0 + 60);
  });

  it('loses when another invocation moved the row first', async () => {
    const { db, store } = fakeDb({ value: '{"old":true}', updated_at: T0 });
    // Winner commits.
    const first = await claimState(db, emptyState('2026-08-01'), T0 + 60, T0);
    expect(first.won).toBe(true);

    // Loser read the same pre-race token and must stand down.
    const second = await claimState(db, emptyState('2026-08-01'), T0 + 62, T0);
    expect(second.won).toBe(false);
    // The winner's state is intact — not clobbered.
    expect(store.row?.updated_at).toBe(T0 + 60);
  });

  it('detects the race even when both ticks arrive in the same second', async () => {
    const { db } = fakeDb({ value: '{"old":true}', updated_at: T0 });
    expect((await claimState(db, emptyState('2026-08-01'), T0, T0)).won).toBe(true);
    // Without nextUpdatedAt forcing the token forward, this would wrongly win.
    expect((await claimState(db, emptyState('2026-08-01'), T0, T0)).won).toBe(false);
  });

  it('creates the row when none exists, and a second creator loses', async () => {
    const { db } = fakeDb(null);
    expect((await claimState(db, emptyState('2026-08-01'), T0, null)).won).toBe(true);
    expect((await claimState(db, emptyState('2026-08-01'), T0, null)).won).toBe(false);
  });
});

describe('releaseState', () => {
  it('restores the previous value after a failed batch', async () => {
    const before = '{"before":true}';
    const { db, store } = fakeDb({ value: before, updated_at: T0 });

    const claim = await claimState(db, emptyState('2026-08-01'), T0 + 60, T0);
    expect(claim.won).toBe(true);
    expect(store.row?.value).not.toBe(before);

    await releaseState(db, before, T0, claim.updatedAt);
    // Back to exactly what the database held when we read it, so the next tick
    // recomputes the snapshots this tick failed to write.
    expect(store.row?.value).toBe(before);
    expect(store.row?.updated_at).toBe(T0);
  });

  it('does not clobber a newer writer when releasing', async () => {
    const { db, store } = fakeDb({ value: '{"before":true}', updated_at: T0 });
    const claim = await claimState(db, emptyState('2026-08-01'), T0 + 60, T0);

    // Someone else moved on after our claim; our rollback must not undo theirs.
    await claimState(db, emptyState('2026-08-02'), T0 + 120, claim.updatedAt);
    await releaseState(db, '{"before":true}', T0, claim.updatedAt);

    expect(store.row?.updated_at).toBe(T0 + 120);
  });

  it('removes a row it created when there was no previous state', async () => {
    const { db, store } = fakeDb(null);
    const claim = await claimState(db, emptyState('2026-08-01'), T0, null);
    await releaseState(db, '', null, claim.updatedAt);
    expect(store.row).toBeNull();
  });
});
