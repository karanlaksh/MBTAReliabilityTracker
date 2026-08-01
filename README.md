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
| 1. Schema | done — `migrations/0001_init.sql` |
| 2. Collector (this) | done |
| 3. Status page | next |
| 4. Matching logic | not started |
| 5. Rollups + dashboard | not started |

## What the collector does

Once a minute:

1. `GET /predictions` for the watched stops, with `include=stop,schedule`.
2. `GET /vehicles` for the watched routes, with `include=stop`.
3. Appends a `prediction_snapshots` row for every prediction **whose value changed**.
4. Appends a `vehicle_observations` row for every vehicle state change near a watched stop.
5. Writes dedup state and a `collector_runs` row.

Both feeds are fetched in the same tick, so the vehicle state attached to a prediction
describes where the train actually was when that prediction was made.

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

| Metric | Observed |
|--------|---------:|
| Predictions per tick at watched stops | 31–32 |
| Snapshots written per tick after dedup | 24–28 |
| Vehicles on watched routes | 26 |
| Vehicle rows written per tick | 0–4 |
| Tick duration | 185–470 ms |
| Gap between MBTA's `updated_at` and our poll | 4–33 s |

**Dedup is much weaker than the write budget in CLAUDE.md assumes**, and this is a property
of the feed rather than a bug. Two polls 20 seconds apart showed 21 of 30 shared
predictions changed, almost all by 1–5 seconds. MBTA re-estimates continuously, so most
predictions genuinely differ on every tick.

Extrapolated daily writes: ~48,000 snapshots (assuming ~40/tick averaged over ~20 service
hours), ~4,000 vehicle rows, and 1,440 each for state, runs, and the daily prune —
**roughly 56,000 of the 100,000/day free-tier limit.**

That fits, but headroom is ~1.7×, so there is room for perhaps 2–3 more slices — not the
6–8 stops CLAUDE.md estimates. Measure a full weekday in the Cloudflare dashboard
(D1 > Metrics > Row Metrics) before adding any.

If it ever needs to come down, the cheapest lever is a jitter tolerance: treat a
predicted-arrival change smaller than N seconds as no change. A 1-second revision is model
noise, not new information, and the signal being measured is 30–300 seconds wide. That is
deliberately *not* implemented, because it changes what a `revision` means and that is a
data-semantics decision worth making on real data.

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

## Tests

```bash
npm test        # 24 tests
npm run typecheck
```

Coverage is concentrated on the two things that fail silently: the 03:00 service-date
rollover (including both DST transitions and the ambiguous 01:30 that happens twice in
November), and the dedup rules that the write budget depends on.

## Layout

```
migrations/0001_init.sql   schema + seeded watched stops
src/index.ts               cron entrypoint, /health, /collect
src/collector.ts           one tick: fetch, filter, dedup, write
src/mbta.ts                V3 API client and JSON:API helpers
src/service-date.ts        the 03:00 rollover
src/state.ts               dedup state as one JSON row
```
