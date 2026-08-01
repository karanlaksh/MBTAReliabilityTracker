# MBTA Reliability Tracker

Measures how wrong MBTA's own arrival predictions are, broken down by stop, hour of
day, and day of week. Records predictions as they are made (they are ephemeral — once
overwritten, the old value is gone forever), then records what actually happened, and
grades each prediction.

The core of the project is the **matching logic**: joining a stored prediction to the
arrival that actually fulfilled it. Not the cron job.

## Working agreement

- Explain the reasoning behind design decisions. Do not just produce working code.
- Incremental steps. Small, reviewable diffs.
- Every design choice must be defensible in an interview.
- Every claim made about this project must be literally true and verifiable.
- If a decision below looks wrong, say so and explain why — do not silently deviate.

## Stack (decided — do not re-open)

| Layer     | Choice                                      |
|-----------|---------------------------------------------|
| Collector | Cloudflare Worker, cron-triggered, 1 min    |
| Storage   | Cloudflare D1                               |
| Frontend  | Next.js + TypeScript on Vercel              |
| Charts    | Recharts                                    |
| Source    | MBTA V3 API (`https://api-v3.mbta.com`)     |

**Hard constraint: $0. Everything stays on free tiers, permanently.**

## Build order

1. Schema — done, see `migrations/0001_init.sql`
2. Cron Worker writing to D1 with dedup  ← current
3. Status page deployed (ship before any charts — it proves the system runs)
4. Matching logic (scheduled pass over collected data)
5. Rollups + dashboard, once ~10 days have accumulated

Data starts accumulating the day the collector goes live and **lost days are not
recoverable**. Prioritise getting it running over getting it polished.

## The free-tier budget (this drives the schema)

D1 free tier: 5,000,000 rows read/day, 100,000 rows **written**/day, 5 GB storage.
Every index adds an extra written row whenever an indexed column is written.

**Reads are ~50x cheaper than writes here.** Therefore:

- `prediction_snapshots` has **no secondary index**. Deliberate. Matching and rollups
  scan. Do not add an index to it without recalculating the write budget.
- The prediction error is **never stored**. It is a pure function of a snapshot and an
  arrival, computed at rollup time.
- Dedup state is **one JSON row** in `collector_state`, not a table of rows and not
  Workers KV (KV free tier allows 1,000 writes/day; the cron runs 1,440 times/day).

Rough budget at 3–4 watched stops:

| Table                 | Writes/day |
|-----------------------|-----------:|
| prediction_snapshots  |    ~36,000 |
| collector_state       |      1,440 |
| collector_runs        |      1,440 |
| vehicle_observations  |     ~5,000 |
| arrivals (+ 1 index)  |     ~1,600 |
| rollups               |     ~2,000 |
| **Total**             | **~48,000** |

Headroom for roughly 6–8 stops. Before adding stops, check actual usage in the
Cloudflare dashboard under D1 > Metrics > Row Metrics.

## Key data-model decisions

### Prediction identity is (service_date, trip_id, stop_sequence)

Not `stop_id`. Per the MBTA V3 changelog, `stop_id` on a prediction is **mutable** —
it changes for Commuter Rail track assignments at Back Bay, South Station, and North
Station. `stop_sequence` is stable within a trip. Key on the stable field; store
`stop_id` as an ordinary column.

**Consequence: do not watch Commuter Rail stops.** Subway and bus only.

### service_date is not calendar date

MBTA service dates roll over at approximately 03:00 local, not midnight. A trip at
01:30 belongs to the previous service date. Compute it as: take the current time in
`America/New_York`; if the local hour is < 3, subtract one day.

Getting this wrong silently splits late-night trips across two service dates and
breaks matching for exactly the trips where delays are worst.

### Actual arrival comes from the vehicle feed, with a stated error bar

Poll `/vehicles` in the same cron tick as `/predictions`. Actual arrival for a
(trip, stop) is the vehicle's own `updated_at` at the observation where
`current_status` becomes `STOPPED_AT` at that stop.

Use MBTA's `updated_at`, **not** our poll timestamp — the vehicle feed timestamps its
own state change, which is far tighter than 60-second polling resolution.

Every `arrivals` row carries `source` and `uncertainty_sec`. Sources, in descending
order of confidence:

| source               | meaning                                              | uncertainty |
|----------------------|------------------------------------------------------|------------:|
| `stopped_at`         | observed STOPPED_AT the target stop                  |        ~30s |
| `sequence_advanced`  | vehicle's stop_sequence passed the target, never seen stopped | ~90s |
| `unresolved_dropout` | prediction vanished, no vehicle evidence             |      unknown |

Never present an aggregate without also being able to state its measurement
uncertainty. Quantifying our own error is the most credible part of this project.

### MBTA API edge cases the schema must tolerate

- A prediction may have an arrival time, a departure time, both, or **neither**.
- A prediction with no arrival time, no departure time, and no status means the
  vehicle **will not make that stop**. `predicted_arrival` is nullable and
  `schedule_relationship` is always captured.
- A prediction may have no associated schedule at all — MBTA knows a vehicle is
  running but cannot match it to a scheduled trip. `scheduled_arrival` is nullable.

### Not capturing weather — on purpose

A 2025 MBTA forecasting benchmark (arXiv 2512.02336) found day-of-week and season
data improved accuracy more than weather, and that weather data generally made models
*worse*. Day-of-week, hour, and service_date are captured; weather is out of scope.

## Fields captured now for the November ML extension

The model is not being built yet, but these must be captured from day one or August's
data is unusable for it:

- `horizon_sec` — how far ahead the prediction was made. Single most important feature.
- `revision` — how many times this prediction had already been revised.
- `schedule_relationship`, `status`
- `scheduled_arrival` — enables schedule-deviation as a feature
- `vehicle_id`, `vehicle_status`, `vehicle_stop_sequence` — proxies for how far away
  the vehicle was when the prediction was made
- `service_date`, and weekday/hour derived from it

## How to talk about this project

MBTA **does** publish arrival prediction accuracy, as a pass/fail rate against their
own tolerance bands, and their open-source `transit-performance` system exposes
accuracy in 30-minute slices by route/direction/stop. So the claim is **not** that
nobody measures this.

The claim is about the artifact: this stores the **raw signed error for every
individual prediction along with its horizon** — a labelled dataset, not a summary
statistic. You cannot train a model on somebody's published percentage.

Differentiator vs. a generic "cron job logs a number" project: this is a
**reconciliation problem**. Two record streams, no fully trustworthy shared ID,
timestamps that don't line up, orphans and duplicates on both sides. Same shape as
matching payments to invoices. Get the rule wrong and every downstream number is
quietly wrong with nothing throwing an error.
