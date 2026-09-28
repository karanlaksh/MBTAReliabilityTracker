// Account-wide D1 usage, from Cloudflare's own analytics rather than our counts.
//
// Used to gate the scheduled rollup: it runs only if the account has room left
// in today's 5M-row read budget. /status uses it too.

import type { Env } from './collector';
import { utcDayStart } from './status';

export interface AccountUsage {
  rows_read_today: number;
  rows_read_last_hour: number;
  rows_written_today: number;
}

/**
 * Account-wide D1 usage from Cloudflare's GraphQL analytics API.
 *
 * WHY NOT COUNT OUR OWN READS. A self-reported counter only sees the code that
 * reports it. The reads that exhausted the budget came from the matcher; others
 * come from the rollup, the frontend API, and ad-hoc `wrangler d1 execute`
 * queries (one of which, a MAX() over prediction_snapshots, cost 962k rows). The
 * quota is enforced on the account total, so that is the number to watch.
 *
 * It also keeps working when D1 is refusing queries, which is exactly when the
 * number matters most. Analytics lag real time by a few minutes.
 *
 * Needs CF_ACCOUNT_ID and a CF_API_TOKEN with Account Analytics: Read.
 */
export async function fetchAccountUsage(env: Env, now: number): Promise<AccountUsage> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID not configured');
  }
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `query ($a: String!, $d: Date!, $h: Time!) {
        viewer { accounts(filter: { accountTag: $a }) {
          today: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date: $d }) {
            sum { rowsRead rowsWritten } }
          hour: d1AnalyticsAdaptiveGroups(limit: 1, filter: { datetime_geq: $h }) {
            sum { rowsRead } }
        } } }`,
      variables: {
        a: env.CF_ACCOUNT_ID,
        d: new Date(utcDayStart(now) * 1000).toISOString().slice(0, 10),
        h: new Date(Math.max(utcDayStart(now), now - 3600) * 1000).toISOString(),
      },
    }),
  });
  if (!res.ok) throw new Error(`analytics HTTP ${res.status}`);
  return parseAccountUsage(await res.json());
}

/** Split out so the response shape is testable without a network. */
export function parseAccountUsage(body: unknown): AccountUsage {
  const b = body as {
    errors?: { message: string }[] | null;
    data?: {
      viewer?: {
        accounts?: {
          today?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
          hour?: { sum?: { rowsRead?: number } }[];
        }[];
      };
    };
  };
  if (b.errors && b.errors.length > 0) {
    throw new Error(`analytics: ${b.errors.map((e) => e.message).join('; ')}`);
  }
  const account = b.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('analytics: account not found');
  // No rows means no D1 activity in the window, which is a genuine zero.
  return {
    rows_read_today: Number(account.today?.[0]?.sum?.rowsRead ?? 0),
    rows_written_today: Number(account.today?.[0]?.sum?.rowsWritten ?? 0),
    rows_read_last_hour: Number(account.hour?.[0]?.sum?.rowsRead ?? 0),
  };
}
