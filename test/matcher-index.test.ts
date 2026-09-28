import { describe, expect, it } from 'vitest';
import migration0009 from '../migrations/0009_read_budget.sql?raw';
import { INDEX_FLOOR, __test } from '../src/matcher';

const { observationQueries } = __test;

describe('partial index floor', () => {
  it('matches the literal in migration 0009 character for character', () => {
    // SQLite uses a partial index only when the query repeats the index WHERE
    // term textually. If these drift, the matcher silently goes back to scanning
    // the whole table — the failure that cost four weeks of rush hours.
    expect(migration0009).toContain(`WHERE service_date >= '${INDEX_FLOOR}'`);
  });
});

describe('observationQueries', () => {
  it('uses only the indexed query when every date is at or after the floor', () => {
    const qs = observationQueries(['2026-09-28', '2026-09-29']);
    expect(qs).toHaveLength(1);
    expect(qs[0].sql).toContain(`service_date >= '${INDEX_FLOOR}'`);
    expect(qs[0].binds).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('includes the floor date itself in the indexed query', () => {
    const qs = observationQueries([INDEX_FLOOR]);
    expect(qs).toHaveLength(1);
    expect(qs[0].sql).toContain(`service_date >= '${INDEX_FLOOR}'`);
  });

  it('splits pre-floor dates into a separate unindexed query, losing none', () => {
    const qs = observationQueries(['2026-09-20', '2026-09-28']);
    expect(qs).toHaveLength(2);
    expect(qs.flatMap((q) => q.binds).sort()).toEqual(['2026-09-20', '2026-09-28']);
    const unindexed = qs.find((q) => q.binds.includes('2026-09-20'))!;
    // Must NOT carry the floor term, or it would return zero rows for the date.
    expect(unindexed.sql).not.toContain(INDEX_FLOOR);
  });

  it('emits a placeholder per bound date', () => {
    for (const q of observationQueries(['2026-09-01', '2026-09-02', '2026-09-28'])) {
      expect(q.sql.match(/\?/g)).toHaveLength(q.binds.length);
    }
  });
});
