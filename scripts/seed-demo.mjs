#!/usr/bin/env node
// DEMO ONLY — seeds the mbta-demo database. Never point this at mbta.
//
// Generates three months (2026-07-01 .. 2026-09-30) of SYNTHETIC rollup rows for
// the recorded demo. Nothing here is measured. It is anchored on the measured
// Aug 1-19 per-route, per-bucket p10 / median / p90 (from /api/error-by-horizon
// on the real database) and on real August volumes and day-to-day spread; the
// rest is modelled. See README "Demo mode".
//
// Method: draw individual prediction errors in memory, then compute every table
// FROM THE SAME DRAWS — rollup_error_by_day (median / p10 / p90 by date) and
// rollup_grid_totals (sums and counts by weekday x hour) — so the two agree the
// way real rollups agree. Only aggregates are written; no per-prediction rows.
//
// Output: SQL files in three parts, because D1's 100,000 writes/day limit is
// ACCOUNT-WIDE and shared with the live collector (~55-65k/day), so no single
// day may take the whole seed:
//   part 1a  demo_seed, watched_stops, rollup_error_by_day, rollup_grid_folded,
//            arrival_counts                                    (~10.4k writes)
//   part 1b  rollup_grid_totals                                (~12.3k writes)
//   part 2   collector_runs for the 7 days before generation   (~10.1k writes)
// Generation is deterministic from SEED, so 1a and 1b come from the SAME draws
// even when generated on different days; only timestamps differ. Part 2 is
// relative to the time it is generated: generate it right before importing it.
//
// Usage: node scripts/seed-demo.mjs <out-dir> [--part 1a|1b|2] [--stats]

import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? '.';
const PART = process.argv.includes('--part') ? process.argv[process.argv.indexOf('--part') + 1] : '1a';
if (!['1a', '1b', '2'].includes(PART)) throw new Error(`--part must be 1a, 1b or 2, not ${PART}`);
const STATS = process.argv.includes('--stats');
const SEED = 20261001;
const VERSION = 'seed-demo v1';
const FROM = '2026-07-01';
const TO = '2026-09-30';
const NOW = Math.floor(Date.now() / 1000);

// --- deterministic randomness ----------------------------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(SEED);
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function poisson(lambda) {
  // Knuth; lambda here is at most ~12.
  let k = 0, p = 1; const L = Math.exp(-lambda);
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

// --- anchors: MEASURED, Aug 1-19, real database ------------------------------
// [p10, median, p90] seconds, signed (positive = arrived later than predicted).
const BUCKETS = ['~1.5 min', '~4.5 min', '~9 min', '~16 min'];
const ANCHOR = {
  Orange:    [[-8.2, 4.4, 25.5], [-12.3, 11.4, 53.1], [-19.1, 32.4, 136.6], [-23.3, 46.0, 192.5]],
  '39':      [[-26.9, 29.4, 97.0], [-51.0, 50.7, 160.3], [-77.1, 70.5, 243.3], [-87.1, 115.5, 369.3]],
  'Green-E': [[-43.1, -9.3, 38.1], [-64.4, 12.4, 127.1], [-87.6, 41.4, 200.1], [-107.0, 110.3, 352.8]],
};
// Measured SD of the DAILY median across Aug 1-19, per route and bucket. A day
// effect of ~0.75x this reproduces the observed spread once sampling noise is
// added back; clipped at 2.5 SD so no day is an implausible spike.
const DAY_SD = {
  Orange: [0.7, 1.4, 9.2, 13.6],
  '39': [6.8, 12.8, 23.9, 28.9],
  'Green-E': [8.7, 12.1, 7.5, 11.5],
};
// Graded predictions per stop-direction per service hour at a weekday rush
// peak, from real August volumes (Orange ~138/day, 39 ~95/day, Green-E ~129/day
// per stop-direction).
const PEAK_PER_HOUR = { Orange: 10, '39': 7, 'Green-E': 9 };
// Share of predictions that reach each evaluation point (late-entering trips).
const ELIGIBLE = [1.0, 0.995, 0.99, 0.95];

// --- stops: 12, in both directions where the route serves both --------------
// The six Green-E downtown and Orange downtown stops are NOT collected by the
// real system; they exist only in this demo database.
const STOPS = [
  ['place-nuniv', 'Green-E', 'Northeastern University', 'mid_line', 1.0],
  ['place-symcl', 'Green-E', 'Symphony', 'mid_line', 1.0],
  ['place-prmnl', 'Green-E', 'Prudential', 'mid_line', 1.05],
  ['place-coecl', 'Green-E', 'Copley', 'mid_line', 1.1],
  ['place-pktrm', 'Green-E', 'Park Street', 'mid_line', 1.1],
  ['place-rugg', 'Orange', 'Ruggles', 'mid_line', 1.0],
  ['place-masta', 'Orange', 'Massachusetts Ave', 'mid_line', 1.0],
  ['place-bbsta', 'Orange', 'Back Bay', 'mid_line', 1.05],
  ['place-dwnxg', 'Orange', 'Downtown Crossing', 'mid_line', 1.1],
  ['place-forhl', 'Orange', 'Forest Hills', 'terminus', 0.75],
];
const DIRS = {
  'Green-E': ['Green E outbound', 'Green E inbound'],
  Orange: ['Orange southbound', 'Orange northbound'],
};
const SLICES = [];
for (const [stop, route, name, role, f] of STOPS) {
  for (const dir of [0, 1]) {
    SLICES.push({ stop, route, dir, mode: 'subway', role, f,
      label: `${name} — ${DIRS[route][dir]}${role === 'terminus' ? ' (terminus)' : ''}` });
  }
}
// The two real Route 39 stops, one direction each, with their real ids.
SLICES.push({ stop: '41391', route: '39', dir: 0, mode: 'bus', role: 'mid_line', f: 1.0,
  label: 'Huntington Ave @ Opera Pl — Route 39 outbound' });
SLICES.push({ stop: '81317', route: '39', dir: 1, mode: 'bus', role: 'mid_line', f: 1.0,
  label: '360 Huntington Ave — Route 39 inbound' });

// --- time-of-day and day-of-week shape --------------------------------------
const HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0];
// Error spread multiplier: rush worse than midday, early/late calmer.
const HOUR_ERR = { 5: 0.85, 6: 1.1, 7: 1.35, 8: 1.4, 9: 1.25, 10: 1.05, 11: 0.9, 12: 0.9, 13: 0.9,
  14: 0.95, 15: 1.1, 16: 1.3, 17: 1.4, 18: 1.25, 19: 1.05, 20: 0.95, 21: 0.95, 22: 0.9, 23: 0.85, 0: 0.85 };
// Volume relative to the peak hour.
const HOUR_VOL = { 5: 0.3, 6: 0.65, 7: 1.0, 8: 1.0, 9: 0.85, 10: 0.65, 11: 0.6, 12: 0.6, 13: 0.6,
  14: 0.65, 15: 0.8, 16: 1.0, 17: 1.0, 18: 0.85, 19: 0.65, 20: 0.55, 21: 0.5, 22: 0.45, 23: 0.4, 0: 0.3 };
const WEEKDAY_ERR = [0.75, 1, 1, 1, 1, 1, 0.8]; // Sun..Sat: weekends better
const WEEKDAY_VOL = [0.65, 1, 1, 1, 1, 1, 0.75];

// Normalise the error multipliers so that, volume-weighted over a week, they
// average 1: the pooled figures then land on the measured anchors rather than
// being inflated by the rush-hour multiplier.
let wsum = 0, fsum = 0;
for (let w = 0; w < 7; w++) for (const h of HOURS) {
  const v = HOUR_VOL[h] * WEEKDAY_VOL[w];
  wsum += v; fsum += v * HOUR_ERR[h] * WEEKDAY_ERR[w];
}
const SHAPE_NORM = wsum / fsum;

// --- the error distribution: piecewise-linear quantile through the anchors ---
function quantileFn([p10, med, p90]) {
  const p01 = p10 - 1.6 * (med - p10);
  const p99 = p90 + 1.8 * (p90 - med);
  const pmax = p99 + 0.6 * (p99 - p90);
  const pts = [[0, p01 - 0.3 * (p10 - p01)], [0.01, p01], [0.1, p10], [0.5, med], [0.9, p90], [0.99, p99], [1, pmax]];
  return (u) => {
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i][0]) {
        const [u0, x0] = pts[i - 1], [u1, x1] = pts[i];
        return x0 + ((u - u0) / (u1 - u0)) * (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  };
}
let Q = Object.fromEntries(Object.entries(ANCHOR).map(([r, bs]) => [r, bs.map(quantileFn)]));

// --- statistics, computed exactly as the rollup SQL computes them ------------
function stats(errs) {
  const s = [...errs].sort((a, b) => a - b), c = s.length;
  const at = (r) => s[Math.max(1, r) - 1];
  return {
    n: c,
    mean: s.reduce((t, x) => t + x, 0) / c,
    median: at(Math.floor((c + 1) / 2)),
    p10: at(Math.floor(c * 0.1)),
    p90: at(Math.floor(c * 0.9)),
    within60: s.filter((x) => Math.abs(x) <= 60).length / c,
  };
}

// --- generate -----------------------------------------------------------------
const dates = [];
for (let t = Date.parse(`${FROM}T12:00:00Z`); t <= Date.parse(`${TO}T12:00:00Z`); t += 86_400_000) {
  dates.push(new Date(t).toISOString().slice(0, 10));
}
let byDay, grid, arrivals, pooled;
function generate() {
rand = mulberry32(SEED);
byDay = [];        // rollup_error_by_day rows
grid = new Map();  // cell key -> {n, sum, abs, w60}
arrivals = [];     // per (date, slice): totals for arrival_counts
pooled = {};       // route|bucket -> all errors, for calibration and verification

for (const date of dates) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  // One day effect per route and bucket, shared by that route's stops.
  const dayShift = {};
  for (const route of Object.keys(ANCHOR)) {
    dayShift[route] = DAY_SD[route].map((sd) => Math.max(-2.5, Math.min(2.5, normal())) * sd * 0.75);
  }
  for (const sl of SLICES) {
    const perBucket = BUCKETS.map(() => []);
    let trips = 0;
    for (const h of HOURS) {
      const k = poisson(PEAK_PER_HOUR[sl.route] * HOUR_VOL[h] * WEEKDAY_VOL[weekday]);
      trips += k;
      const f = HOUR_ERR[h] * WEEKDAY_ERR[weekday] * SHAPE_NORM * sl.f;
      for (let i = 0; i < k; i++) {
        for (let b = 0; b < 4; b++) {
          if (rand() > ELIGIBLE[b]) continue;
          const med = ANCHOR[sl.route][b][1];
          const raw = Q[sl.route][b](rand());
          const err = Math.round(med * f + (raw - med) * f + dayShift[sl.route][b]);
          perBucket[b].push(err);
          const key = [sl.stop, sl.route, sl.dir, weekday, h, BUCKETS[b]].join('|');
          const cell = grid.get(key) ?? { n: 0, sum: 0, abs: 0, w60: 0 };
          cell.n++; cell.sum += err; cell.abs += Math.abs(err); if (Math.abs(err) <= 60) cell.w60++;
          grid.set(key, cell);
          (pooled[`${sl.route}|${BUCKETS[b]}`] ??= []).push(err);
        }
      }
    }
    // Arrival outcomes: realistic shares, termini publish more departure-only.
    const noArrival = Math.round(trips * (sl.role === 'terminus' ? 0.3 : 0.02));
    const unfulfilled = Math.round(trips * (0.015 + rand() * 0.02));
    arrivals.push({ date, sl, trips, noArrival, unfulfilled });
    for (let b = 0; b < 4; b++) {
      if (perBucket[b].length === 0) continue;
      const st = stats(perBucket[b]);
      byDay.push({ date, sl, bucket: BUCKETS[b], ...st,
        arrivals_total: trips + unfulfilled, unfulfilled, no_arrival_predicted: noArrival });
    }
  }
}
}

// CALIBRATION. Mixing rush, midday and weekend multipliers over one distribution
// widens the pooled tails beyond the measured ones (~12-20% on p90 in pass one).
// So: generate once, measure each route/bucket's pooled lower and upper spread,
// shrink the anchor tails by measured/pooled, shift by the median residual, and
// generate again from the same seed.
generate();
const CORRECTED = {};
for (const [route, bs] of Object.entries(ANCHOR)) {
  CORRECTED[route] = bs.map(([p10, med, p90], i) => {
    const s = stats(pooled[`${route}|${BUCKETS[i]}`]);
    const lo = (med - p10) / Math.max(1, s.median - s.p10);
    const hi = (p90 - med) / Math.max(1, s.p90 - s.median);
    // The mixture also nudges the median; shift by the measured residual.
    const shift = med - s.median;
    return [med - (med - p10) * lo + shift, med + shift, med + (p90 - med) * hi + shift];
  });
}
Q = Object.fromEntries(Object.entries(CORRECTED).map(([r, bs]) => [r, bs.map(quantileFn)]));
generate();

// --- verification output ------------------------------------------------------
if (STATS) {
  console.log('pooled vs measured anchors (Jul-Sep synthetic vs Aug 1-19 real):');
  for (const route of Object.keys(ANCHOR)) BUCKETS.forEach((b, i) => {
    const s = stats(pooled[`${route}|${b}`]);
    const [p10, med, p90] = ANCHOR[route][i];
    console.log(`  ${route.padEnd(8)} ${b.padEnd(9)} median ${s.median.toFixed(0).padStart(4)} (anchor ${med})  ` +
      `p10 ${s.p10.toFixed(0).padStart(4)} (${p10})  p90 ${s.p90.toFixed(0).padStart(4)} (${p90})  within60 ${s.within60.toFixed(2)}`);
  });
  const cells = [...grid.values()];
  const passing = cells.filter((c) => c.n >= 20).length;
  console.log(`grid: ${cells.length} cells, ${passing} at n>=20 (${(100 * passing / cells.length).toFixed(1)}% coverage), ` +
    `mean n ${(cells.reduce((t, c) => t + c.n, 0) / cells.length).toFixed(1)}  [gate: 60% and mean 20]`);
}

// --- SQL --------------------------------------------------------------------------
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(4));
function inserts(table, cols, rows, chunk = 200) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES\n` +
      rows.slice(i, i + chunk).map((r) => `(${r.join(', ')})`).join(',\n') + ';');
  }
  return out.join('\n');
}
mkdirSync(OUT, { recursive: true });

if (PART === '1a' || PART === '1b') {
  const sql = [];
  const A = PART === '1a';
  sql.push(`-- ${VERSION}, seed ${SEED}, part ${PART}, generated ${new Date(NOW * 1000).toISOString()}. SYNTHETIC DEMO DATA.`);
  if (A) sql.push(`CREATE TABLE IF NOT EXISTS demo_seed (
  seed_id    TEXT PRIMARY KEY,
  generator  TEXT NOT NULL,
  seed       INTEGER NOT NULL,
  date_from  TEXT NOT NULL,
  date_to    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note       TEXT NOT NULL
);`);
  if (A) sql.push(`INSERT INTO demo_seed (seed_id, generator, seed, date_from, date_to, created_at, note) VALUES (` +
    `${q(`demo-${SEED}`)}, ${q(VERSION)}, ${SEED}, ${q(FROM)}, ${q(TO)}, ${NOW}, ` +
    `${q('SYNTHETIC. Every row in this database except schema migrations is generated by scripts/seed-demo.mjs, anchored on measured Aug 1-19 figures. Not collected data. computed_at / updated_at / folded_at on seeded rows are the import time of their part (1a, 1b or 2).')});`);
  if (A) sql.push('DELETE FROM watched_stops;');
  if (A) sql.push(inserts('watched_stops', ['stop_id', 'route_id', 'direction_id', 'label', 'active', 'added_at', 'mode', 'stop_role'],
    SLICES.map((s) => [q(s.stop), q(s.route), s.dir, q(s.label), 1, NOW, q(s.mode), q(s.role)])));
  if (A) sql.push(inserts('rollup_error_by_day',
    ['service_date', 'stop_id', 'route_id', 'direction_id', 'horizon_bucket', 'is_added', 'n', 'mean_error_sec',
      'median_error_sec', 'p10_error_sec', 'p90_error_sec', 'pct_within_60s', 'arrivals_total', 'unfulfilled',
      'no_arrival_predicted', 'is_partial', 'computed_at'],
    byDay.map((r) => [q(r.date), q(r.sl.stop), q(r.sl.route), r.sl.dir, q(r.bucket), 0, r.n, num(r.mean),
      r.median, r.p10, r.p90, num(r.within60), r.arrivals_total, r.unfulfilled, r.no_arrival_predicted, 0, NOW])));
  if (!A) sql.push(inserts('rollup_grid_totals',
    ['stop_id', 'route_id', 'direction_id', 'weekday', 'hour', 'horizon_bucket', 'is_added', 'n', 'sum_err',
      'sum_abs_err', 'n_within_60', 'updated_at'],
    [...grid.entries()].map(([k, c]) => {
      const [stop, route, dir, wd, h, b] = k.split('|');
      return [q(stop), q(route), dir, wd, h, q(b), 0, c.n, c.sum, c.abs, c.w60, NOW];
    })));
  // Markers go in with the TOTALS they describe (part 1b), never before them: a
  // marker without its totals would tell the fold that a date is done when it
  // is not.
  if (!A) sql.push(inserts('rollup_grid_folded', ['service_date', 'folded_at', 'rows_read'], dates.map((d) => [q(d), NOW, 'NULL'])));
  // arrival_counts at WEEKLY grain for history (dated each week's first day) and
  // DAILY for the last 7 days, which /api/summary reads as "last 7 days". Same
  // totals per slice and source, a fifth of the writes.
  const SRC = (sl, a) => {
    const withTime = a.trips;
    const turnaround = sl.role === 'terminus' ? Math.round(withTime * 0.5) : 0;
    const stoppedAt = Math.round((withTime - turnaround) * 0.78);
    return { stopped_at: stoppedAt, stopped_at_turnaround: turnaround,
      sequence_advanced: withTime - turnaround - stoppedAt,
      skipped: Math.round(a.unfulfilled * 0.6), unresolved_dropout: a.unfulfilled - Math.round(a.unfulfilled * 0.6),
      no_arrival_predicted: a.noArrival };
  };
  const counts = new Map();
  const lastWeekFrom = dates[dates.length - 7];
  for (const a of arrivals) {
    const bucketDate = a.date >= lastWeekFrom ? a.date
      : dates[Math.floor(dates.indexOf(a.date) / 7) * 7];
    for (const [src, n] of Object.entries(SRC(a.sl, a))) {
      if (n <= 0) continue;
      const k = [bucketDate, a.sl.stop, a.sl.route, a.sl.dir, src].join('|');
      counts.set(k, (counts.get(k) ?? 0) + n);
    }
  }
  if (A) sql.push(inserts('arrival_counts', ['service_date', 'stop_id', 'route_id', 'direction_id', 'source', 'n'],
    [...counts.entries()].map(([k, n]) => { const [d, s, r, dir, src] = k.split('|'); return [q(d), q(s), q(r), dir, q(src), n]; })));
  writeFileSync(`${OUT}/seed-demo-part${PART}.sql`, sql.join('\n\n') + '\n');
  console.log(A
    ? `part 1a: demo_seed 1, watched_stops ${SLICES.length} (+ deletes), rollup_error_by_day ${byDay.length}, ` +
      `arrival_counts ${counts.size} -> ~${1 + SLICES.length + 10 + byDay.length + counts.size} writes`
    : `part 1b: rollup_grid_totals ${grid.size}, rollup_grid_folded ${dates.length} -> ~${grid.size + dates.length} writes`);
}

if (PART === '2') {
  // collector_runs for the 7 days before NOW, one per minute, all successful.
  const rows = [];
  for (let t = NOW - 7 * 86_400 + 60; t <= NOW; t += 60) {
    const snaps = 10 + Math.floor(rand() * 12), veh = 3 + Math.floor(rand() * 4);
    rows.push([t, 600 + Math.floor(rand() * 900), 40 + Math.floor(rand() * 30), snaps, 30 + Math.floor(rand() * 20), veh,
      200, 'NULL', snaps + veh + 2, 0]);
  }
  const sql = `-- ${VERSION}, part 2: collector_runs, generated ${new Date(NOW * 1000).toISOString()}. SYNTHETIC.\n` +
    inserts('collector_runs', ['started_at', 'duration_ms', 'predictions_seen', 'snapshots_written', 'vehicles_seen',
      'vehicle_rows_written', 'api_status', 'error', 'rows_written', 'concurrent_tick'], rows) + '\n';
  writeFileSync(`${OUT}/seed-demo-part2.sql`, sql);
  console.log(`part 2: collector_runs ${rows.length} -> ~${rows.length} writes`);
}
