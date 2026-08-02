// Dedup state for the collector.
//
// Stored as ONE JSON row in `collector_state`. Not a row per prediction (that
// would roughly double the daily write count) and not Workers KV (free tier =
// 1,000 writes/day; this cron fires 1,440 times/day).
//
// DEVIATION FROM THE SCHEMA COMMENT: migrations/0001_init.sql names two keys,
// 'prediction_state' and 'vehicle_state'. We use a single key, 'dedup', holding
// both. Two rows would be two writes per tick = 2,880/day, but the write budget
// in CLAUDE.md allocates 1,440/day to collector_state. The budget is the harder
// constraint, so one row it is.
//
// CONCURRENCY: read-modify-write of this row is not atomic, so it is guarded by
// compare-and-set. loadState returns the row's `updated_at`; claimState writes
// only if that value is unchanged. A tick that loses the claim writes nothing
// and records concurrent_tick = 1.
//
// This replaced a bare single-writer assumption, which production disproved:
// on 2026-08-02, one pair of invocations arrived 2 seconds apart in 324
// intervals, at a deploy boundary. That instance happened to be harmless — the
// second tick saw 8 changed predictions where the first saw 49, so it had
// already read the first's committed state and they ran sequentially. But
// "usually sequential" is not a guarantee, and a genuinely overlapping pair
// would last-write-wins the blob: lost revision increments and duplicate
// snapshot rows, in exactly the feature the horizon cap exists to protect.

/** Entries untouched for this long are dropped, to bound the row's size. */
const STALE_SEC = 3_600;

export const DEDUP_KEY = 'dedup';
const STATE_VERSION = 1;

/**
 * [fingerprint, revision, lastSeenAt, firstSeenAt, firstPredictedArrival]
 *
 * The last two are captured on the FIRST observation at any horizon and never
 * change afterwards. They exist because the horizon cap means the first row we
 * store is usually not the first time we saw the prediction, and MBTA's original
 * estimate would otherwise be lost.
 *
 * Entries written before this field existed have length 3. `firstSeenAt` is then
 * undefined and the row is stamped NULL rather than guessing — those entries age
 * out within STALE_SEC, so the gap is bounded to roughly an hour after deploy.
 */
export type PredictionEntry =
  | [string, number, number]
  | [string, number, number, number | null, number | null];
/** [fingerprint, lastSeenAt, lingerUntil] */
export type VehicleEntry = [string, number, number];
/** [fingerprint, lastSeenAt] */
export type AlertEntry = [string, number];

export interface DedupState {
  v: number;
  /** Service date this state describes. A change resets prediction revisions. */
  d: string;
  /** '<trip_id>|<stop_sequence>' -> entry */
  p: Record<string, PredictionEntry>;
  /** '<vehicle_id>' -> entry */
  h: Record<string, VehicleEntry>;
  /**
   * '<alert_id>' -> entry. Added after v1 without bumping STATE_VERSION: the
   * field is purely additive, so an existing row parses fine and defaults to
   * empty. Bumping the version would have discarded live prediction revision
   * counters for no benefit.
   */
  a: Record<string, AlertEntry>;
}

export function emptyState(serviceDate: string): DedupState {
  return { v: STATE_VERSION, d: serviceDate, p: {}, h: {}, a: {} };
}

/**
 * The state plus the `updated_at` it was read at. That timestamp is the
 * compare-and-set token used by claimStatement — see the concurrency note above.
 * `updatedAt` is null when no row existed yet.
 */
export interface LoadedState {
  state: DedupState;
  updatedAt: number | null;
}

export async function loadState(db: D1Database, serviceDate: string): Promise<LoadedState> {
  const row = await db
    .prepare('SELECT value, updated_at FROM collector_state WHERE key = ?')
    .bind(DEDUP_KEY)
    .first<{ value: string; updated_at: number }>();

  if (!row) return { state: emptyState(serviceDate), updatedAt: null };

  let parsed: DedupState;
  try {
    parsed = JSON.parse(row.value) as DedupState;
  } catch {
    // Corrupt state is recoverable: we lose revision continuity for in-flight
    // predictions and re-write one snapshot each. Better than failing the tick.
    return { state: emptyState(serviceDate), updatedAt: row.updated_at };
  }

  if (parsed.v !== STATE_VERSION || parsed.d !== serviceDate) {
    // New service date: revision counters restart. Prediction identity includes
    // service_date, so carrying them over would be wrong.
    return { state: emptyState(serviceDate), updatedAt: row.updated_at };
  }
  parsed.p ??= {};
  parsed.h ??= {};
  parsed.a ??= {};
  return { state: parsed, updatedAt: row.updated_at };
}

/** Drop entries not seen recently, so the row cannot grow across a whole day. */
export function pruneState(state: DedupState, now: number): void {
  const cutoff = now - STALE_SEC;
  for (const [key, entry] of Object.entries(state.p)) {
    if (entry[2] < cutoff) delete state.p[key];
  }
  for (const [key, entry] of Object.entries(state.h)) {
    if (entry[1] < cutoff) delete state.h[key];
  }
  for (const [key, entry] of Object.entries(state.a)) {
    if (entry[1] < cutoff) delete state.a[key];
  }
}

/**
 * The next `updated_at` to write.
 *
 * Must be STRICTLY GREATER than the value it replaces, or the compare-and-set
 * token does not change and a second tick arriving within the same second would
 * see a token that still matches. Two ticks 2 seconds apart have been observed
 * in production, so same-second arrival is not hypothetical enough to ignore.
 */
export function nextUpdatedAt(now: number, previous: number | null): number {
  return previous === null ? now : Math.max(now, previous + 1);
}

/**
 * Claim the state row by compare-and-set, returning true if we won.
 *
 * This runs BEFORE the data batch and on its own, not inside it. The ordering is
 * deliberate and it is a trade:
 *
 *   - Claiming first means a tick that loses the race writes nothing at all,
 *     which is the point — it must not clobber the winner's revision increments.
 *   - The cost is that state is committed before the rows it describes. If the
 *     data batch then fails, state claims snapshots that were never written, and
 *     those predictions will not be re-written until they next change.
 *
 * The second case is mitigated by releaseStatement below, and is in any case a
 * far smaller loss than duplicated rows with silently dropped revision counts.
 */
export async function claimState(
  db: D1Database,
  state: DedupState,
  now: number,
  previousUpdatedAt: number | null,
): Promise<{ won: boolean; updatedAt: number }> {
  const updatedAt = nextUpdatedAt(now, previousUpdatedAt);
  const value = JSON.stringify(state);

  if (previousUpdatedAt === null) {
    // No row yet. DO NOTHING rather than DO UPDATE: if a concurrent tick created
    // it between our read and this write, that tick owns it and we must not win.
    const created = await db
      .prepare(
        `INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .bind(DEDUP_KEY, value, updatedAt)
      .run();
    return { won: (created.meta?.changes ?? 0) > 0, updatedAt };
  }

  const claimed = await db
    .prepare(
      `UPDATE collector_state SET value = ?, updated_at = ?
        WHERE key = ? AND updated_at = ?`,
    )
    .bind(value, updatedAt, DEDUP_KEY, previousUpdatedAt)
    .run();

  return { won: (claimed.meta?.changes ?? 0) > 0, updatedAt };
}

/**
 * Undo a claim after the data batch failed, so the next tick recomputes from the
 * state we actually left the database in rather than from a claim we could not
 * honour. Best-effort: if this write fails too, D1 is refusing writes and the
 * tick was lost regardless.
 */
export async function releaseState(
  db: D1Database,
  previousValue: string,
  previousUpdatedAt: number | null,
  claimedUpdatedAt: number,
): Promise<void> {
  if (previousUpdatedAt === null) {
    await db.prepare('DELETE FROM collector_state WHERE key = ? AND updated_at = ?')
      .bind(DEDUP_KEY, claimedUpdatedAt)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE collector_state SET value = ?, updated_at = ?
        WHERE key = ? AND updated_at = ?`,
    )
    .bind(previousValue, previousUpdatedAt, DEDUP_KEY, claimedUpdatedAt)
    .run();
}
