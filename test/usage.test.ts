import { describe, expect, it } from 'vitest';
import { parseAccountUsage } from '../src/usage';

describe('parseAccountUsage', () => {
  // Shape as returned by the live API on 2026-09-28.
  const live = {
    data: {
      viewer: {
        accounts: [
          {
            hour: [{ sum: { rowsRead: 2_564_016, rowsWritten: 1_245 } }],
            today: [{ sum: { rowsRead: 6_065_626, rowsWritten: 6_236 } }],
          },
        ],
      },
    },
    errors: null,
  };

  it('reads today and last-hour totals', () => {
    expect(parseAccountUsage(live)).toEqual({
      rows_read_today: 6_065_626,
      rows_read_last_hour: 2_564_016,
      rows_written_today: 6_236,
    });
  });

  it('treats an empty window as a genuine zero', () => {
    const empty = { data: { viewer: { accounts: [{ today: [], hour: [] }] } }, errors: null };
    expect(parseAccountUsage(empty).rows_read_today).toBe(0);
  });

  it('throws on API errors rather than reporting zero', () => {
    expect(() => parseAccountUsage({ errors: [{ message: 'not authorized' }] })).toThrow(
      /not authorized/,
    );
  });

  it('throws when the account is missing rather than reporting zero', () => {
    expect(() => parseAccountUsage({ data: { viewer: { accounts: [] } } })).toThrow(/account/);
  });
});
