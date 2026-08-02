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
| 1. Schema | done — `migrations/0001_init.sql`, `0002_alerts_and_stops.sql` |
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
curl https://<your-worker>.workers.dev/health
```

`seconds_since_last_run` should stay under ~90. Anything larger means ticks are being
missed, which means data is being lost that cannot be backfilled.

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

### The write budget is the binding constraint

**Dedup is much weaker than the write budget in CLAUDE.md assumes**, and this is a property
of the feed rather than a bug. Two polls 20 seconds apart showed 21 of 30 shared
predictions changed, almost all by 1–5 seconds. MBTA re-estimates continuously, so most
predictions genuinely differ on every tick.

Measured over 60 consecutive production ticks (Saturday evening, Green-E suspended):
**50.9 snapshots written per tick on average**, peak 63.

| Source | Writes/day |
|--------|-----------:|
| prediction_snapshots | ~70,000–85,000 |
| vehicle_observations | ~5,000 |
| collector_state | 1,440 |
| collector_runs | 1,440 |
| daily prune of collector_runs | 1,440 |
| alert_snapshots | ~100 |
| **Total** | **~80,000–95,000** |

Against a **100,000/day** hard limit. The range accounts for overnight lulls, rush-hour
peaks, and roughly +14 predictions/tick when Green-E returns. **This is tight, and it is
the thing to watch first** in the Cloudflare dashboard under D1 > Metrics > Row Metrics.

The lever, if it needs to come down: a **jitter tolerance** — treat a predicted-arrival
change smaller than N seconds as no change. Measured against real collected data, ignoring
changes under 10s would suppress ~62% of revisions, and under 15s ~68%. That is a 2–3x
reduction in the dominant write source.

It is deliberately **not implemented**. A 1-second revision is model noise rather than new
information, and the signal being measured is 30–300 seconds wide, so the cost to accuracy
is small — but it changes what `revision` means and slightly stales the stored prediction,
and that is a data-semantics decision worth making deliberately rather than by default.

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
npm test        # 49 tests
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

## Layout

```
migrations/0001_init.sql              schema + first four watched stops
migrations/0002_alerts_and_stops.sql  alerts, per-slice counts, six more slices
src/index.ts                          cron entrypoint, /health, /collect
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
