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
// SINGLE-WRITER ASSUMPTION: read-modify-write of this row is not atomic. It is
// safe only because a cron-triggered Worker is the sole writer and Cloudflare
// does not overlap scheduled invocations of the same trigger. If a second writer
// ever appears — a manual backfill, a second Worker — this row will silently
// lose updates. Named here so nobody has to discover it.
//
// OBSERVED, 2026-08-02: one pair of invocations 2 seconds apart in 324 intervals,
// at the exact moment of a deploy. Cron delivery is therefore not strictly
// once-per-minute across a version rollover. That instance was harmless — the
// second tick saw only 8 changed predictions where the first saw 49, proving it
// had already read the first's committed state, so they ran sequentially rather
// than concurrently. Worth knowing that the assumption is "almost always true"
// rather than "guaranteed". A genuinely concurrent pair would cost one tick's
// revision increments and a few duplicate snapshots; it would not corrupt
// anything, because every table here is append-only.

/** Entries untouched for this long are dropped, to bound the row's size. */
const STALE_SEC = 3_600;

export const DEDUP_KEY = 'dedup';
const STATE_VERSION = 1;

/** [fingerprint, revision, lastSeenAt] */
export type PredictionEntry = [string, number, number];
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

export async function loadState(db: D1Database, serviceDate: string): Promise<DedupState> {
  const row = await db
    .prepare('SELECT value FROM collector_state WHERE key = ?')
    .bind(DEDUP_KEY)
    .first<{ value: string }>();

  if (!row) return emptyState(serviceDate);

  let parsed: DedupState;
  try {
    parsed = JSON.parse(row.value) as DedupState;
  } catch {
    // Corrupt state is recoverable: we lose revision continuity for in-flight
    // predictions and re-write one snapshot each. Better than failing the tick.
    return emptyState(serviceDate);
  }

  if (parsed.v !== STATE_VERSION || parsed.d !== serviceDate) {
    // New service date: revision counters restart. Prediction identity includes
    // service_date, so carrying them over would be wrong.
    return emptyState(serviceDate);
  }
  parsed.p ??= {};
  parsed.h ??= {};
  parsed.a ??= {};
  return parsed;
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

export function saveStatement(db: D1Database, state: DedupState, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(DEDUP_KEY, JSON.stringify(state), now);
}
