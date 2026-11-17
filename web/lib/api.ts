// Typed client for the Worker's rollup API.
//
// The Worker is the only thing that touches D1. This module knows nothing about
// prediction_snapshots, arrivals or SQL — it reads three JSON endpoints.

export const WORKER_BASE =
  process.env.NEXT_PUBLIC_WORKER_BASE ?? 'https://mbta-collector.mbta-collector.workers.dev';

/**
 * The primary analysis window: the headline finding and the mode comparison are
 * graded over these dates only, not pooled across all time. A pooled figure
 * would average complete days together with the partial days of the September
 * read-limit outage, which is not a like-for-like comparison.
 *
 * October onward, open-ended: `to` is null, so the Worker grades every complete
 * service date from Oct 1 (partial days are excluded by default) and the window
 * keeps up on its own. October is the first full month with every watched slice
 * running and collection clean; it replaced Aug 1–19, which was chosen when
 * August was the only complete data. `label` is only the fallback — the page
 * labels the window from the span the Worker reports it actually graded
 * (windowLabel below).
 */
export const PRIMARY_WINDOW: { from: string; to: string | null; label: string } = {
  from: '2026-10-01',
  to: null,
  label: 'Oct 1, 2026 onward',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;

/**
 * "Oct 1 – Nov 1, 2026", from the dates the figures were actually graded over.
 * If any service date in that span is absent, says how many are present — a
 * label must not claim a day the figures do not contain.
 */
export function windowLabel(span: HorizonSpan | undefined, fallback: string): string {
  if (!span?.first || !span.last) return fallback;
  const [y1, m1, d1] = span.first.split('-').map(Number);
  const [y2, m2, d2] = span.last.split('-').map(Number);
  const range =
    y1 !== y2 ? `${MONTHS[m1 - 1]} ${d1}, ${y1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`
      : m1 !== m2 ? `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`
        : `${MONTHS[m1 - 1]} ${d1}–${d2}, ${y2}`;
  const calendar = dayCount(span.first, span.last);
  return span.days < calendar ? `${range} (${span.days} of ${calendar} service dates)` : range;
}

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
/** The service dates a horizon response was graded over. Absent from an older Worker. */
export interface HorizonSpan {
  first: string | null;
  last: string | null;
  days: number;
}

export interface HorizonResponse {
  sign_convention: string;
  bucket_order: string[];
  method: string;
  span?: HorizonSpan;
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

/** Every weekday x hour cell for one slice, small cells included. */
export interface SliceCells {
  stop_id: string;
  route_id: string;
  direction_id: number;
  horizon_bucket: string;
  cells: { weekday: number; hour: number; n: number; share_within_60s: number }[];
}

/** The heatmap's first view: present in both the real and the seeded data. */
export const DEFAULT_GRID_SLICE = { stop: 'place-nuniv', route: 'Green-E', dir: 1, bucket: '~9 min' } as const;

export interface SliceResponse {
  min_n: number;
  /** The displayed value. Share of predictions within 60s: exact and outlier-resistant. */
  metric?: 'share_within_60s';
  cells_total: number;
  mean_n_per_cell: number;
  cells_passing: number;
  coverage: number;
  /** The display gate, from the API so the page and the estimate cannot disagree. */
  gate?: { minN: number; minCoverage: number; minMeanN: number };
  /** How much has accumulated: the grid folds in one final service date at a time. */
  accumulation?: { dates_folded: number; first: string | null; last: string | null };
  /** When the gate should open at the current rate; date null while not estimable. */
  estimate?: { date: string | null; weeks: number | null; basis: string };
  /**
   * Present only from the old API, when the grid was a ROLLING window of this
   * many days rather than accumulating. Kept so the page stays honest if it is
   * ever served by a Worker that predates migration 0011.
   */
  window_days?: number;
  /** One stop/direction/bucket's full weekday x hour grid, when asked for. */
  slice?: SliceCells | null;
  /**
   * Heatmap colour scale per evaluation point: the 5th-95th percentile of
   * share-within-60s across all stops' cells (n >= min_n) at that point.
   */
  scale?: Record<string, { lo: number; hi: number; cells: number }>;
  note: string;
  cells: {
    stop_id: string; route_id: string; direction_id: number; weekday: number;
    hour: number; horizon_bucket: string; n: number;
    share_within_60s: number;
  }[];
}

/**
 * Fetch that never throws. A dead or degraded Worker must render a banner, not a
 * crash and not an endless spinner, so failure is a value the page can display.
 */
/**
 * `fetchedAt` is when the Worker produced the response (its x-generated-at
 * header, else its HTTP Date header, in epoch seconds), NOT when this page rendered. Next's data cache can hand back a
 * stored response on a later render; the Date header travels with it, so it
 * says how old the data really is.
 */
export async function getJson<T>(
  path: string,
): Promise<{ data: T | null; error: string | null; fetchedAt: number | null }> {
  try {
    const res = await fetch(`${WORKER_BASE}${path}`, { next: { revalidate: 1800 } });
    // x-generated-at first: the Worker's D1 response cache (src/cache.ts) can
    // serve a body produced hours ago, and on a hit Date is only when it was SENT.
    const generated = Number(res.headers.get('x-generated-at'));
    const date = res.headers.get('date');
    const fetchedAt = generated > 0 ? generated : date ? Math.floor(Date.parse(date) / 1000) : null;
    if (!res.ok) return { data: null, error: `${path} returned HTTP ${res.status}`, fetchedAt };
    return { data: (await res.json()) as T, error: null, fetchedAt };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err), fetchedAt: null };
  }
}

export const fmtSigned = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}s`;

export const fmtInt = (n: number): string => n.toLocaleString('en-US');
