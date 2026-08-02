# MBTA Reliability Tracker

Measures how wrong MBTA's own arrival predictions are, broken down by stop, hour of day,
and day of week.

MBTA predictions are ephemeral — once a prediction is overwritten, the previous value is
gone forever. This records every prediction as it is made, records what actually happened,
and grades one against the other. The output is a labelled dataset of **raw signed error
per individual prediction, tagged with the horizon at which it was made** — not a summary
statistic.

Design rationale lives in [CLAUDE.md](CLAUDE.md). This file covers running it.

## Status

| Stage | State |
|-------|-------|
| 1. Schema | done — `migrations/0001*`, `0002*`, `0003*` |
| 2. Collector (this) | done, deployed, collecting |
| 3. Status page | next |
| 4. Matching logic | not started |
| 5. Rollups + dashboard | not started |

## What the collector does

Once a minute:

1. `GET /predictions` for the watched stops, with `include=stop,schedule`.
2. `GET /vehicles` for the watched routes, with `include=stop`.
3. `GET /alerts` for the watched routes. Failure here is non-fatal.
4. Appends a `prediction_snapshots` row for every prediction **whose value changed**.
5. Appends a `vehicle_observations` row for every vehicle state change near a watched stop.
6. Appends an `alert_snapshots` row for every alert whose content changed.
7. Writes dedup state and a `collector_runs` row carrying per-slice prediction counts.

The prediction and vehicle feeds are fetched in the same tick, so the vehicle state
attached to a prediction describes where the train actually was when that prediction was
made.

### Watched slices

Ten, seeded across two migrations:

| stop | route | mode | role |
|------|-------|------|------|
| Ruggles | Orange (both directions) | subway | mid_line |
| Massachusetts Ave | Orange (both directions) | subway | mid_line |
| Forest Hills | Orange (both directions) | subway | terminus |
| Northeastern University | Green-E (both directions) | subway | mid_line |
| Huntington Ave @ Opera Pl (`41391`) | 39 outbound | bus | mid_line |
| 360 Huntington Ave (`81317`) | 39 inbound | bus | mid_line |

Adding a slice is an `INSERT INTO watched_stops` with no redeploy — the watched set is
config in the database, not in code.

## Setup

```bash
npm install
npx wrangler d1 create mbta          # paste the returned database_id into wrangler.toml
npm run migrate:remote
npx wrangler secret put MBTA_API_KEY   # optional, see below
npm run deploy
```

Verify:

```bash
curl https://<your-worker>.workers.dev/status
```

Returns **200** while healthy and **503** when it is not, so uptime monitoring can watch
the status code alone without parsing the body. See the guardrails section below.

### Local

```bash
npm run migrate:local
echo 'COLLECT_TOKEN=localdev' > .dev.vars
npx wrangler dev --test-scheduled
curl -X POST 'http://127.0.0.1:8787/collect?token=localdev'
```

### The API key

Optional. Anonymous callers get 20 req/min shared across a bucket; a key gives 1000/min.
We use 2/min, so the key is insurance against a noisy-neighbour 429, not a requirement.
Free from https://api-v3.mbta.com/register.

## Measured behaviour, not estimated

Numbers below are from live ticks against the real API on 2026-08-01, at low-service hours
(~00:20 local) with the four seeded slices.

| Metric | 4 slices | 10 slices |
|--------|---------:|----------:|
| Predictions per tick at watched stops | 17–18 | 61–66 |
| Snapshots written per tick after dedup | 11–13 | 43–55 |
| Vehicle rows written per tick | 0–4 | 3–7 |
| Alerts seen / written per tick | — | 7 / 0 after the first |
| CPU per invocation (10 ms cap) | 3–4 ms | see below |
| Wall time per invocation | 1.3–2.3 s | 1.3–2.5 s |
| Gap between MBTA's `updated_at` and our poll | 4–33 s | 4–33 s |

Green-E contributes 0 of the 10-slice numbers above — it is suspended (see below), so
expect roughly 14 more predictions per tick once it returns.

## Guardrails

On the free tier the daily write cap is the thing most likely to take this down, and it
fails silently: writes start being rejected, and the minutes lost while nobody notices are
unrecoverable. Three mechanisms cover it.

### 1. The write counter on `/status`

Every tick records `collector_runs.rows_written` — the exact number of D1 rows it spent,
including the dedup-state upsert, the run row itself, and any rows the daily prune deleted
(deletes count against the quota too). `/status` sums that for the current day and projects
forward:

```json
"write_budget": {
  "limit": 100000,
  "used_today": 69,
  "remaining": 99931,
  "pct_used": 0.1,
  "pct_projected": 2.7,
  "projected_eod": 2671,
  "projected_by_recent_rate": 2671,
  "projected_by_flat_rate": 2671,
  "level": "ok",
  "writes_last_hour": 69,
  "seconds_until_reset": 84168
}
```

Two projections, because neither is trustworthy alone. `recent_rate` extrapolates the last
hour and reacts immediately but overshoots at rush hour; `flat_rate` extrapolates today's
average and is steadier but slow. **`level` uses the higher of the two** — a guardrail that
under-reports is worse than none, given what it guards against is silent.

`level` is `ok` below 70%, `warn` at 70–90%, `critical` at 90%+.

**The reset boundary is 00:00 UTC, not the 03:00 service date.** Cloudflare's quota day and
this project's service date are different things; conflating them would misreport the
budget by 4–5 hours of writes daily. `src/status.ts` works in UTC deliberately, and there is
a test asserting exactly that.

### 2. D1 limit failures are classified apart from everything else

`collector_runs.error_kind` separates the failure that destroys data from the ones that do
not:

| kind | meaning |
|------|---------|
| `d1_limit` | D1 refused the write — quota, rate, or storage. **Data is being lost.** |
| `d1_other` | D1 ran and refused — syntax, constraint, missing column. |
| `mbta_api` | MBTA returned non-2xx. The next tick re-reads the same predictions. |
| `timeout` | Our own 10s fetch timeout tripped. |
| `other` | Unclassified; read the raw `error` column. |

`/status` exposes `failures.d1_limit_hits_today` and a `by_kind` breakdown, so a budget
failure is never buried under a pile of unrelated MBTA 503s.

Classification is a heuristic over message text — D1 exposes no stable machine-readable
code through the Workers binding. The marker lists live in `src/collector.ts` and are
checked in that order, so a message matching both a limit marker and a generic D1 marker is
filed as the limit. Verified against real D1 error text, which turns out not to carry a
`D1_ERROR` prefix at all: a bad column surfaces as `table X has no column named Y:
SQLITE_ERROR`. An earlier version of the classifier missed all of those.

### 3. Staleness, because a total write outage cannot record itself

If D1 is refusing writes outright, the `collector_runs` INSERT that would record
`error_kind = 'd1_limit'` is itself refused. So `error_kind` catches *partial* failures
(batch rejected, run row accepted) but cannot catch a total one.

A total outage instead shows up as an absence of rows. `/status` reports `stale` when the
last run is more than 150s old — a tick is due every 60s — and returns 503. The collector
also `console.error`s every failure with its classification, so Workers observability sees
it without touching D1 at all.

Verified end-to-end: with the collector stopped, `/status` flipped to 503 with
`collecting: false` at 158s.

### What is deliberately not here

There is **no automatic load-shedding**. The collector will not start dropping slices to
stay under budget, because silently collecting less is a worse failure than collecting
nothing and saying so. If `level` reaches `warn`, the levers are manual and listed below.

### The write budget is the binding constraint

**Dedup is much weaker than the write budget in CLAUDE.md assumes**, and this is a property
of the feed rather than a bug. Two polls 20 seconds apart showed 21 of 30 shared
predictions changed, almost all by 1–5 seconds. MBTA re-estimates continuously, so most
predictions genuinely differ on every tick.

Measured over 60 consecutive production ticks (Saturday evening, Green-E suspended):
**50.9 snapshots written per tick on average**, peak 63.

| Source | Writes/day |
|--------|-----------:|
| prediction_snapshots (before the horizon cap) | ~70,000–85,000 |
| prediction_snapshots (after) | ~28,000–34,000 |
| vehicle_observations | ~5,000 |
| collector_state | 1,440 |
| collector_runs | 1,440 |
| daily prune of collector_runs | 1,440 |
| alert_snapshots | ~100 |
| **Total before cap** | **~80,000–95,000** |
| **Total after cap** | **~38,000–44,000** |

Against a **100,000/day** hard limit. The range accounts for overnight lulls, rush-hour
peaks, and roughly +14 predictions/tick when Green-E returns. Before the horizon cap this
was uncomfortably tight; after it there is roughly 2.4x headroom, which is enough to absorb
Green-E's return and several more slices. Confirm against a full weekday in the Cloudflare
dashboard under D1 > Metrics > Row Metrics before adding any.

### Scoping vs. sampling: the horizon cap, and the jitter threshold that was rejected

Two ways to cut the dominant write source were considered. They are not the same kind of
decision, and only one was taken.

**Taken — a horizon cap (`MAX_STORED_HORIZON_SEC = 1200`).** No `prediction_snapshots` row
is written for a prediction more than 20 minutes from its arrival. Measured across 14,806
collected rows, those accounted for 8,813 — **63.2% of rows carrying a horizon**, or 59.5%
of all rows once the 868 NULL-horizon rows are counted. They dominate the budget while
carrying the least information: a 45-minute-out estimate is close to a restatement of the
timetable and will be revised many times before it means anything.

This is a **scoping** decision. It declares a range of interest — the last 20 minutes
before arrival — and keeps *complete* fidelity inside it: every revision, full resolution,
unbroken revision count. Nothing within the range is thinned or approximated. A prediction
outside the range is out of scope, not sampled away.

Three properties make that true, and each is enforced by a test:

- **The cap gates the write, not the tracking.** Dedup state and `revision` are updated for
  every observed change at every horizon. `revision` keeps meaning "total times MBTA revised
  this arrival", not "times since it entered the window" — different features, and the
  November model needs the former. A prediction revised three times at 40 minutes out and
  once at 18 minutes out is stored once, with `revision = 4`.
- **NULL horizons are always written.** No arrival time means a skipped stop, a cancelled
  trip, or a vehicle that will not serve the stop. Rare, and the interesting failures.
- **Negative horizons are inside the window** by definition — an overdue prediction MBTA is
  still publishing is exactly the case worth having.

**Rejected — a jitter tolerance.** Treating a predicted-arrival change under N seconds as
no change would suppress ~62% of revisions at 10s and ~68% at 15s: a comparable saving. But
it is a **sampling** decision. It degrades fidelity *within* the range of interest, leaves
the stored value up to N seconds stale, and redefines `revision` to count only revisions
large enough to notice. The horizon cap costs none of that, so it was preferred.

The existing ~8,800 rows above the cap were **not deleted**. They are the reference sample
that justifies the cutoff, and the cap applies going forward only.

#### ⚠️ Rollups spanning the cap must filter on horizon

Because the cap applies going forward only, the dataset has two eras. Rows before the
activation instant include predictions at every horizon; rows after it are capped at 1200s.

**Any rollup, chart, or model that spans the boundary must filter
`horizon_sec <= 1200 OR horizon_sec IS NULL`.** Without it, the pre-cap era will appear to
have systematically worse accuracy purely because it contains long-horizon predictions the
post-cap era does not — a pure artefact of the collection change, and one that looks exactly
like a real finding.

The activation instant is recorded in the database rather than in a comment, so the filter
can be derived rather than remembered:

```sql
SELECT json_extract(value, '$.activated_at'), json_extract(value, '$.max_horizon_sec')
  FROM collector_state WHERE key = 'horizon_cap_activated_at';
```

It is stored as JSON so the threshold travels with the timestamp. Changing
`MAX_STORED_HORIZON_SEC` later needs a new marker, not a silent reinterpretation of this one.

### What a prediction's origin looks like

The cap created a second problem it also had to solve. The first row *stored* for a
prediction is usually not the first time it was *seen* — production showed trip 78493012
first stored at `revision: 67`, having been revised 66 times outside the window. The
revision count survived, but MBTA's original estimate did not, and "what did they first say
and how far did it move" is the question this project exists to answer.

`first_seen_at` and `first_predicted_arrival` are captured on the first observation at any
horizon, held in the dedup state, and stamped on every row the prediction produces. They
repeat across a prediction's rows deliberately — D1 bills rows written, not columns, so
denormalising them is free. That makes drift a subtraction:

```sql
SELECT trip_id, revision,
       predicted_arrival - first_predicted_arrival AS drift_sec,
       observed_at - first_seen_at                 AS tracked_for_sec
  FROM prediction_snapshots WHERE first_predicted_arrival IS NOT NULL;
```

Rows written before migration 0004 have NULL for both, as do predictions whose dedup entry
predates it (they age out within about an hour of deploy). Not backfilled: the information
was never captured, and inventing it would be worse than admitting the gap.

## Design decisions in this code

**Stop ids are normalised to parent stations.** Predictions and vehicles reference platform
stops (`70010`); `watched_stops` is keyed on stations (`place-rugg`). Normalising via the
`parent_station` backlink is what makes prediction stop ids and vehicle stop ids comparable
to each other, which the matcher depends on.

**Vehicle position is excluded from the prediction fingerprint.** It changes on nearly every
tick. Including it would mean writing every prediction every minute and dedup would buy
nothing. Vehicle state is context attached to snapshots we write anyway, not a trigger.

**Vehicle observations are recorded only near watched stops, plus a 5-minute linger.**
Recording every state change on the Orange and Green-E lines would cost ~86,000 writes/day
on its own. The linger exists because subway dwell time is often shorter than the poll
interval: when we miss `STOPPED_AT`, the only evidence the train served the stop is the
*next* observation, where `current_stop_sequence` has advanced past it. That is the
`sequence_advanced` arrival source.

**The dedup state row is claimed by compare-and-set, not just overwritten.** Production
disproved the original single-writer assumption: two invocations arrived 2 seconds apart in
324 intervals, at a deploy boundary. `loadState` returns the row's `updated_at`;
`claimState` writes only if it is unchanged. A tick that loses the claim writes nothing and
records `concurrent_tick = 1`, visible on `/status` under `concurrency` so a deploy-boundary
cluster can be told apart from an ongoing overlap.

The claim runs *before* the data batch rather than inside it, which is a deliberate trade.
Claiming first means a losing tick writes nothing at all — the point, since it must not
duplicate the winner's rows or overwrite its revision increments. The cost is that state
commits before the rows it describes, so `releaseState` rolls the claim back if the batch
then fails. That is a smaller loss than silently dropped revision counts.

**One dedup row, not two.** `migrations/0001_init.sql` names `prediction_state` and
`vehicle_state`; this uses a single `dedup` key holding both, because two rows is two writes
per tick (2,880/day) against a budget line of 1,440. Read-modify-write of that row is safe
only under a single writer — true for a cron Worker, and stated out loud in `src/state.ts`.

**The batch is one transaction.** Snapshots and the dedup state that describes them land
together or not at all, so state can never claim we recorded something we did not.

**A `collector_runs` row is written even when the tick fails.** A failed tick that left no
trace is indistinguishable from one that never fired.

**Alerts are captured, and their failure is non-fatal.** A suspended line returns zero
predictions, which looks exactly like a broken collector. `alert_snapshots` plus
`collector_runs.per_slice_counts` (which records an explicit `0` for every watched slice)
together make a gap self-explanatory. The alerts fetch is wrapped so that an alerts outage
cannot cost a tick of predictions, which are the unrecoverable half.

**Whether an alert applied to a prediction is derived at rollup time, not stored.** Same
principle as prediction error: `alert_snapshots` carries the active period and the affected
routes/stops, and the join happens later. `affects_watched` is the one exception — a
precomputed flag, because it needs the watched set that the rollup would otherwise re-derive.

**Rows are batched into multi-row inserts.** Not for write cost — D1 bills rows, so it is
identical — but for CPU. Each prepared statement costs measurable CPU to bind, and the free
plan is CPU-limited per invocation. See the CPU section below.

**Prediction-snapshot writes go out as ~13 statements instead of ~50.** `MAX_BOUND_PARAMS`
is held at 80 rather than D1's documented 100 so that adding a column later cannot silently
push a statement over the limit.

## Tests

```bash
npm test        # 87 tests
npm run typecheck
```

Coverage is concentrated on what fails silently rather than loudly:

- the 03:00 service-date rollover, including both DST transitions and the ambiguous 01:30
  that happens twice in November
- the dedup rules the write budget depends on
- multi-row insert chunking — parameter ceiling, ordering across chunk seams, column
  alignment — because a bug there corrupts data without throwing
- alert period selection and the `affects_watched` matching rules, including the line-wide
  alert that names a route but no stop
- the write-budget projection and its UTC-vs-service-date boundary, and error
  classification against error text captured from real D1 failures
- the horizon cap: the 1200s boundary on both sides, NULL and negative horizons, and
  above all that `revision` keeps incrementing while writes are suppressed
- `first_seen_at` / `first_predicted_arrival` surviving suppressed writes, and stamping
  NULL rather than guessing for pre-migration state entries
- the compare-and-set claim, including two ticks arriving in the same second and rollback
  not clobbering a newer writer

## Layout

```
migrations/0001_init.sql              schema + first four watched stops
migrations/0002_alerts_and_stops.sql  alerts, per-slice counts, six more slices
migrations/0003_write_budget_guardrails.sql  write accounting + error classification
migrations/0004_first_seen_and_concurrency.sql  prediction origin, CAS, cap marker
src/index.ts                          cron entrypoint, /status, /collect
src/status.ts                         write-budget counter, projection, staleness
src/collector.ts                      one tick: fetch, filter, dedup, write
src/mbta.ts                           V3 API client and JSON:API helpers
src/service-date.ts                   the 03:00 rollover
src/state.ts                          dedup state as one JSON row
```

## CPU, and a correction to the assumed limit

The Workers free plan is documented at **10 ms CPU per invocation**, and a cron trigger has
no automatic retry — an invocation killed for exceeding CPU is a permanently lost tick.

Measured across 57 consecutive production invocations at 10 slices: **median 6 ms, max
11 ms**, zero non-`ok` outcomes.

The 11 ms sample matters: it **completed successfully**. So whatever limit applies to this
cron worker, it is not a hard 10 ms kill. That is worth knowing but not worth relying on —
treat 10 ms as the working budget.

Where the CPU actually goes is only partly understood. Batching statements dropped the
median from 7 ms to 6 ms — a real improvement, but far less than the ~3 ms predicted from
the statement-count difference, so per-statement binding is *not* the dominant cost. The
remainder is isolate startup, three JSON payload parses (~105 KB combined), and binding
overhead, and has not been profiled further.

One thing that is understood, and worth not breaking: `Intl.DateTimeFormat` costs ~9 ms to
construct — more than the entire budget — and `serviceDate()` runs once per prediction row.
It is hoisted to module scope in `src/service-date.ts` so it is paid once per isolate. Do
not move it inside the function.
