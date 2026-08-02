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
| 3. Status page | next — `/status` already serves what it needs |
| 4. Matching logic | done, deployed, running on `*/15` |
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

## The matcher (step 4)

Joining a stored prediction to the arrival that fulfilled it. Two record streams,
no fully trustworthy shared id, timestamps that do not line up, orphans on both sides.

### The grading unit is HORIZON, not revision

A rider sees one prediction: whichever was on screen when they looked. So each
(trip, stop) contributes exactly **one** data point per horizon bucket — the snapshot with
the largest `horizon_sec` inside that bucket, i.e. the prediction displayed as the trip
first entered the band. Buckets are 0-3, 3-6, 6-12, 12-20 minutes.

The alternatives were rejected for specific reasons, recorded here so nobody drifts back:

- **Last prediction** converges to zero error. It measures MBTA at its easiest.
- **First prediction** is an artefact of our own horizon cap, not of MBTA, and is not
  comparable across the cap boundary.
- **Every revision** lets a trip MBTA fidgeted about 40 times outvote a stable trip 40:1.
  Fidgeting correlates with delay, so that weights the average toward chaotic trips — a
  sampling artefact of our own making.

Horizon is the horizon MBTA **displayed** (`predicted_arrival - observed_at`), not true
time remaining. A train running 10 minutes late has its "5 minute" snapshot graded at
+10 minutes. That is what the rider experienced, and it is intended.

### Establishing actual arrival

| source | rule | uncertainty |
|---|---|---|
| `stopped_at` | **earliest** `vehicle_updated_at` with `STOPPED_AT` at the target | 30s |
| `stopped_at_turnaround` | terminus; bracketed between last approach and first reassignment | half the bracket |
| `sequence_advanced` | never seen stopped; observations bracket the target sequence | half the bracket |
| `skipped` | `SKIPPED`/`CANCELLED`, or arrival+departure+status all null | n/a |
| `unresolved_dropout` | predictions existed, then vanished, no evidence | n/a |
| `no_arrival_predicted` | MBTA published a departure but never an arrival | n/a |

**Earliest, not latest.** A vehicle reports `STOPPED_AT` for its whole dwell. Taking the
last would push arrival to the end of the dwell, which at Forest Hills is several minutes
of manufactured lateness.

**Uncertainty is computed, never assumed.** Every bracketed source reports half its own
bracket width, so a wide bracket honestly declares itself imprecise.

**Joins prefer `stop_sequence` over `stop_id`**, because `stop_id` is the mutable field.
`arrivals.match_key` records which was used. Measured: they agreed on 596 of 596 cases, so
the preference is currently insurance rather than a fix for an observed fault.

### The terminus turnaround

Measured before designing: Forest Hills dir 0 has **zero** `STOPPED_AT` observations across
169 settled arrivals. Not missing data — on arrival MBTA immediately reassigns the vehicle
to its next outbound trip, so the stop event is filed under a **different trip_id** at
direction 1, sequence 1. Linking on `trip_id` can never find it. Bridging on `vehicle_id`
recovers 166 of 169.

It is **bracketed, not point-estimated**. The reassignment timestamp is at or after physical
arrival — a one-directional lag, not symmetric noise — so using it directly would bias every
terminus arrival late and read as MBTA under-predicting at Forest Hills. A finding
manufactured entirely by our own method.

Measured reassignment lag (T2−T1) over 212 bracketed cases:

| min | p25 | median | p75 | p90 | max |
|---:|---:|---:|---:|---:|---:|
| 14s | 53s | **64s** | 66s | 109s | 312s |

Worth reading carefully: the median of 64s is essentially our own **60-second poll
interval**. T1 is our last observation, not the true moment of arrival, so this distribution
is dominated by our polling resolution rather than by MBTA's reassignment lag. The real lag
is smaller than we can resolve, and the bracket is honest about that.

9 of 221 cases had no approach sighting to bracket against and fall back to the
reassignment timestamp with a deliberately inflated 300s uncertainty.

### Unfulfilled predictions are never dropped

`skipped` and `unresolved_dropout` stay in the denominator and are reported as a separate
rate. A median that quietly excludes the trains that never came is systematically
optimistic, in exactly the cases that matter most.

`no_arrival_predicted` is reported **beside** that rate, not inside it. 302 of 1,366
prediction-stops are departure-only — MBTA never promised an arrival, so there was nothing
to fulfil. Counting them as unfulfilled would inflate the rate by ~22 points with cases that
are not failures.

**Departure grading is SCOPED OUT, not unmeasurable.** MBTA does predict departures at
origin termini, `predicted_departure` is stored for all of them, and grading those against
actual departure is a real capability being deliberately deferred — it needs different
detection machinery than arrival does.

### Plausibility: flagged, never filtered

`arrivals.implausible` marks a match more than an hour from the last predicted arrival.
Surfaced on `/status`; the rows stay, and stay in every aggregate.

The threshold is generous on purpose. A filter that discarded implausible matches would
preferentially discard the **largest errors**, and the largest errors are mostly real
delays — the exact tail this project exists to measure. Removing them would truncate the
distribution and flatter MBTA, producing a headline number that looks better precisely
because the worst outcomes were deleted. That is the same failure as dropping unfulfilled
predictions, wearing a different hat.

So the flag catches *matcher faults*, not transit events. A non-zero count means go and
read the matcher, not clean the data.

### Idempotency

Re-running must improve, never degrade. Upsert on `(service_date, trip_id, stop_id)`, and
the `DO UPDATE` carries a guard: it fires only when the new source ranks strictly higher
than the stored one, or ranks equal with a tighter uncertainty.

Verified against real data: back-to-back runs over 220 arrivals changed nothing — not the
source, the arrival time, the uncertainty, nor even `matched_at`, which proves the UPDATE
never fired rather than rewriting identical values. Degrading a row to
`unresolved_dropout` by hand and re-running restored it to `stopped_at`.

### Scheduling and cost

A second cron at `*/15`. Cloudflare delivers **each cron expression as its own event**, so
the handler branches on `event.cron`; running the collector in both would double-collect
every fifteenth minute.

The scan is bounded by a rowid watermark in `collector_state`. `prediction_snapshots` has no
secondary index, and snapshots are appended in id order, so a rowid range is an efficient
proxy for a time window. The watermark advances only past fully settled candidates — it
stops just short of the earliest unsettled row, so in-flight trips are re-read next run
rather than written off.

A (trip, stop) is judged only once its last predicted arrival is 30 minutes past.

Measured cost per run: ~11 arrivals written plus 1 watermark, ~1,150 writes/day against the
collector's ~33,000. Reads are the larger share at roughly 400k/day against 5M.

`POST /backfill?token=` runs a full pass over all collected data, separate from the cron.
Safe at any time: every write is confidence-guarded.

### A bug this shipped with, and how it was caught

The first deployed version searched for the turnaround `STOPPED_AT` without bounding the
time window. A vehicle turns around at the same terminus many times a day, so "earliest
`STOPPED_AT` at this stop by this vehicle" found the first of the *day*. Production check:
**167 of 182 turnaround arrivals were wrong by over an hour**, the worst by 16 hours.

The search is now anchored to the trip's own last sighting. Bracketing went from 7% to 96%
and no arrival is off by more than an hour. Five regression tests pin it.

It was caught by checking `actual_arrival_at` against `predicted_arrival` for plausibility
rather than by trusting that the run reported no errors — the run reported none, because
nothing threw.

## Limitations

Things that are true of the current dataset and would mislead anyone reading a headline
number without them.

**All collected data so far is weekend data, with the Green Line E branch suspended.**
Collection began 2026-08-01, a Saturday, during the Aug 1–2 Green-E shutdown. Every figure
in this README is therefore weekend service on Orange and bus 39 only, with two of the ten
watched slices contributing nothing. Weekday rush hour has denser headways, more crowding,
and different failure modes. **Do not generalise these numbers to weekday service.** The
second Green-E suspension runs Aug 8–16, so the first genuinely representative window is
narrow — roughly Aug 3–7 — until after Aug 17.

**The 0–3 minute bucket is not really a forecast.** At short horizons MBTA's prediction is
derived from live vehicle position: the train is already visible, approaching, and often
`INCOMING_AT` the stop. The prediction is closer to an observation than a forecast, which is
why median error there is +4s rather than anything interesting. The bucket is worth keeping
— it is what a rider on the platform sees — but it should not be read as evidence that MBTA
forecasts well. The 6–12 and 12–20 buckets are where forecasting actually happens, and error
there is 6–9x larger.

**`stopped_at` carries a small positive bias.** Actual arrival is taken as the *first*
observation with `current_status = STOPPED_AT`, which is at or after the moment the train
physically arrived — never before. With 60-second polling and MBTA's own `updated_at`
timestamps, that lag is bounded by roughly our poll interval and is one-directional. So
measured error skews slightly late, and the true median error is a little smaller than
reported. `uncertainty_sec = 30` on those rows is an estimate of the magnitude, not a
measurement of it. The bias applies to every bucket roughly equally, so comparisons
*between* buckets and *between* stops remain sound; only the absolute level is affected.

Related and already handled elsewhere: `stopped_at_turnaround` brackets rather than
point-estimates precisely to avoid a much larger version of this same bias at termini.

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
npm test        # 126 tests
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
migrations/0005_matcher.sql           match_key, evidence span
migrations/0006_plausibility.sql      implausible flag
src/matcher.ts                        step 4: prediction -> actual arrival
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
