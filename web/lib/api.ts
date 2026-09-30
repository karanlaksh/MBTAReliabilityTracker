// Typed client for the Worker's rollup API.
//
// The Worker is the only thing that touches D1. This module knows nothing about
// prediction_snapshots, arrivals or SQL — it reads three JSON endpoints.

export const WORKER_BASE =
  process.env.NEXT_PUBLIC_WORKER_BASE ?? 'https://mbta-collector.mbta-collector.workers.dev';

/**
 * The primary analysis window: the headline finding and the mode comparison are
 * graded over these dates only, not pooled across all time. A pooled figure
 * would average complete August days together with the partial days of the
 * September read-limit outage, which is not a like-for-like comparison.
 */
export const PRIMARY_WINDOW = { from: '2026-08-01', to: '2026-08-19', label: 'Aug 1–19, 2026' } as const;

/**
 * Service dates degraded by the September read-limit outage: collection ran only
 * from 20:00 ET until D1's daily read budget ran out. Shown on the day-by-day
 * chart as a labelled gap, never plotted as points — a partial day reads as a
 * change in accuracy when it is really missing data. See the README incident.
 * Sept 28 is included: collection was refused until the fix deployed at 20:24 ET.
 */
export const DEGRADED_WINDOW = { from: '2026-09-01', to: '2026-09-28', label: 'Sept 1–28' } as const;

/** Evaluation points, never bands. See BUCKETS in src/rollup.ts for why. */
export const BUCKETS = ['~1.5 min', '~4.5 min', '~9 min', '~16 min'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Full label used in prose and axis titles. */
export const BUCKET_AXIS_LABEL: Record<Bucket, string> = {
  '~1.5 min': '~1.5 min out',
  '~4.5 min': '~4.5 min',
  '~9 min': '~9 min',
  '~16 min': '~16 min',
};

/**
 * Series colour is keyed to the ROUTE, not to its rank in the response. A filter
 * that drops a route must not repaint the survivors.
 *
 * Validated with the dataviz palette checker (light surface #fcfcfb): lightness
 * band PASS, chroma floor PASS, adjacent CVD ΔE 24.7 protan / 7.6 tritan,
 * normal-vision ΔE 29.0, contrast PASS. Tritan lands in the 6–8 floor band, which
 * is legal ONLY with secondary encoding — hence the legend plus per-series direct
 * labels and distinct marker shapes, so identity is never colour alone.
 */
export const ROUTE_COLOR: Record<string, string> = {
  Orange: '#eb6834',
  '39': '#2a78d6',
  'Green-E': '#008300',
};

export interface HorizonPoint {
  bucket: Bucket;
  horizon_sec: number | null;
  n: number;
  median_sec: number | null;
  p10_sec: number | null;
  p90_sec: number | null;
  pct_within_60s: number | null;
  days: number;
}
export interface HorizonSeries {
  route_id: string;
  mode: string;
  label: string;
  points: HorizonPoint[];
}
export interface HorizonResponse {
  sign_convention: string;
  bucket_order: string[];
  method: string;
  series: HorizonSeries[];
}

export interface DayRow {
  service_date: string;
  route_id: string;
  label: string;
  mode: string;
  bucket: Bucket;
  is_partial: boolean;
  n: number;
  median_sec: number | null;
  p90_sec: number | null;
  arrivals_total: number;
  unfulfilled: number;
}
export interface DayResponse {
  sign_convention: string;
  method: string;
  rows: DayRow[];
}

export interface SliceInfo {
  stop_id: string;
  route_id: string;
  direction_id: number;
  label: string;
  mode: string;
  stop_role: string | null;
  arrivals: number;
  arrivals_last_7d: number;
  no_recent_service: boolean;
}
export interface ServiceAlert {
  routes: string[];
  effect: string;
  severity: number;
  header: string;
  start: number | null;
  end: number | null;
}
export interface SummaryResponse {
  since: string | null;
  until: string | null;
  arrivals: number;
  rollup_computed_at: number | null;
  graded_predictions: number;
  unfulfilled: number;
  unfulfilled_rate: number | null;
  arrivals_by_source: { source: string; n: number }[];
  collector: {
    runs_retained: number;
    failed_runs: number;
    concurrent_ticks: number;
    last_run: number;
  };
  slices: SliceInfo[];
  service_alerts: ServiceAlert[];
}

export interface SliceResponse {
  min_n: number;
  cells_total: number;
  mean_n_per_cell: number;
  cells_passing: number;
  coverage: number;
  note: string;
  cells: {
    stop_id: string; route_id: string; direction_id: number; weekday: number;
    hour: number; horizon_bucket: string; n: number;
    median_error_sec: number | null; p90_error_sec: number | null;
  }[];
}

/**
 * Fetch that never throws. A dead or degraded Worker must render a banner, not a
 * crash and not an endless spinner, so failure is a value the page can display.
 */
/**
 * `fetchedAt` is when the Worker produced the response (its HTTP Date header, in
 * epoch seconds), NOT when this page rendered. Next's data cache can hand back a
 * stored response on a later render; the Date header travels with it, so it
 * says how old the data really is.
 */
export async function getJson<T>(
  path: string,
): Promise<{ data: T | null; error: string | null; fetchedAt: number | null }> {
  try {
    const res = await fetch(`${WORKER_BASE}${path}`, { next: { revalidate: 1800 } });
    const date = res.headers.get('date');
    const fetchedAt = date ? Math.floor(Date.parse(date) / 1000) : null;
    if (!res.ok) return { data: null, error: `${path} returned HTTP ${res.status}`, fetchedAt };
    return { data: (await res.json()) as T, error: null, fetchedAt };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err), fetchedAt: null };
  }
}

export const fmtSigned = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}s`;

export const fmtInt = (n: number): string => n.toLocaleString('en-US');
