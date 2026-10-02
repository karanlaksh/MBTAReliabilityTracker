'use client';

import { useEffect, useState } from 'react';
import { BUCKETS, fmtInt, type Bucket, type SliceCells, type SliceInfo } from '@/lib/api';

/**
 * The typical week for one stop, direction and evaluation point: weekday x hour,
 * coloured by the SHARE OF PREDICTIONS WITHIN 60 SECONDS of the actual arrival.
 *
 * HIGHER IS BETTER here — the opposite of every other number on the page, which
 * is an error where lower is better. So the direction is said in words at both
 * ends of the legend, not left to the colour: a viewer must not have to work out
 * which end is good.
 *
 * One hue, light -> dark (sequential): darker = more predictions within a minute.
 *
 * CONTINUOUS, AND FITTED PER EVALUATION POINT. The ramp spans the 5th-95th
 * percentile of share-within-60s across EVERY stop's cells at the selected
 * point (from the API), and is clamped beyond. Fixed 20-point bands put 60% of
 * the default view's cells in one band and erased a rush-vs-midday gap of
 * 0.17 that is four times the cell-to-cell noise. Per point, not per stop: all
 * stops share a scale at a given point, so clicking between stops compares like
 * with like. The legend shows the fitted numbers and says the ramp is fitted.
 *
 * Ramp: the reference sequential blue, steps 250 -> 700. Step 250 is the light
 * end that passed the palette checker on this surface (#fcfcfb, 2.06:1).
 *
 * Cells below MIN_N are drawn EMPTY, not coloured: no figure without its sample
 * size, as everywhere else on this page. n is in every tooltip.
 */
const RAMP = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Position 0..1 along the ramp, interpolated between adjacent steps. */
function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const [a, b] = [hex(RAMP[i]), hex(RAMP[i + 1])];
  const f = x - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

const WEEKDAYS: { w: number; label: string }[] = [
  { w: 1, label: 'Mon' }, { w: 2, label: 'Tue' }, { w: 3, label: 'Wed' }, { w: 4, label: 'Thu' },
  { w: 5, label: 'Fri' }, { w: 6, label: 'Sat' }, { w: 0, label: 'Sun' },
];
/** Service hours, in service-day order: 5am through midnight. */
const HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0];
const hourLabel = (h: number) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`);
const hourLong = (h: number) => (h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`);

const ROUTE_NAME: Record<string, string> = { Orange: 'Orange Line', 'Green-E': 'Green Line E', '39': 'Bus 39' };

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  // Same pill as the day-by-day chart's evaluation-point selector.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-3 py-1 text-xs transition ${
        on
          ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-white'
          : 'border-[var(--rule)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
      }`}
    >
      {children}
    </button>
  );
}

export default function TypicalWeekHeatmap({
  slices,
  apiBase,
  minN,
  initial,
  scale,
}: {
  /** Watched stop-directions, from /api/summary. */
  slices: SliceInfo[];
  /** Worker base URL including any /demo prefix; the browser refetches from it. */
  apiBase: string;
  minN: number;
  /** The default slice, fetched on the server so the first paint has data. */
  initial: SliceCells | null;
  /** Colour scale per evaluation point (5th-95th percentile across all stops). */
  scale: Record<string, { lo: number; hi: number; cells: number }>;
}) {
  const stopName = (s: SliceInfo) => s.label.split(' — ')[0];
  const dirName = (s: SliceInfo) => (s.label.split(' — ')[1] ?? '').replace(/\s*\(terminus\)/, '');

  const [sel, setSel] = useState(() => ({
    route: initial?.route_id ?? slices[0]?.route_id ?? '',
    stop: initial?.stop_id ?? slices[0]?.stop_id ?? '',
    dir: initial?.direction_id ?? slices[0]?.direction_id ?? 0,
    bucket: (initial?.horizon_bucket as Bucket) ?? '~9 min',
  }));
  const [data, setData] = useState<SliceCells | null>(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ w: number; h: number } | null>(null);

  const isInitial =
    initial !== null &&
    sel.stop === initial.stop_id &&
    sel.route === initial.route_id &&
    sel.dir === initial.direction_id &&
    sel.bucket === initial.horizon_bucket;

  useEffect(() => {
    if (isInitial) {
      setData(initial);
      return;
    }
    let live = true;
    setLoading(true);
    const qs = new URLSearchParams({ min_n: String(minN), stop: sel.stop, route: sel.route, dir: String(sel.dir), bucket: sel.bucket });
    fetch(`${apiBase}/api/error-by-slice?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!live) return;
        setData(j.slice ?? null);
        setFailed(false);
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sel, apiBase, minN, isInitial, initial]);

  const routes = [...new Set(slices.map((s) => s.route_id))];
  const routeStops = slices.filter((s) => s.route_id === sel.route);
  const stops = [...new Map(routeStops.map((s) => [s.stop_id, s])).values()];
  const dirs = routeStops.filter((s) => s.stop_id === sel.stop);
  const current = dirs.find((s) => s.direction_id === sel.dir) ?? dirs[0];

  const cell = (w: number, h: number) => data?.cells.find((c) => c.weekday === w && c.hour === h);
  const fit = scale[sel.bucket] ?? { lo: 0, hi: 1, cells: 0 };
  const colorFor = (share: number) => rampColor((share - fit.lo) / Math.max(0.01, fit.hi - fit.lo));
  const hovered = hover ? cell(hover.w, hover.h) : undefined;

  const pick = (patch: Partial<typeof sel>) =>
    setSel((s) => {
      const next = { ...s, ...patch };
      // Keep the stop and direction valid for the chosen route.
      const rs = slices.filter((x) => x.route_id === next.route);
      if (!rs.some((x) => x.stop_id === next.stop)) next.stop = rs[0]?.stop_id ?? '';
      const ds = rs.filter((x) => x.stop_id === next.stop);
      if (!ds.some((x) => x.direction_id === next.dir)) next.dir = ds[0]?.direction_id ?? 0;
      return next;
    });

  return (
    <div>
      {/* Filters in one row group above the chart, in the page's pill style. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">Route:</span>
        {routes.map((r) => (
          <Pill key={r} on={r === sel.route} onClick={() => pick({ route: r })}>
            {ROUTE_NAME[r] ?? r}
          </Pill>
        ))}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">Stop:</span>
        {stops.map((s) => (
          <Pill key={s.stop_id} on={s.stop_id === sel.stop} onClick={() => pick({ stop: s.stop_id })}>
            {stopName(s)}
          </Pill>
        ))}
      </div>
      {dirs.length > 1 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">Direction:</span>
          {dirs.map((s) => (
            <Pill key={s.direction_id} on={s.direction_id === sel.dir} onClick={() => pick({ dir: s.direction_id })}>
              {dirName(s)}
            </Pill>
          ))}
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">Evaluation point:</span>
        {BUCKETS.map((b) => (
          <Pill key={b} on={b === sel.bucket} onClick={() => pick({ bucket: b })}>
            {b} out
          </Pill>
        ))}
      </div>

      <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <div
          role="grid"
          aria-label={`Share of predictions within 60 seconds, ${current ? current.label : ''}, ${sel.bucket} out`}
          className="inline-grid min-w-full gap-[2px]"
          style={{ gridTemplateColumns: `2.5rem repeat(${HOURS.length}, minmax(1.6rem, 1fr))` }}
        >
          <div />
          {HOURS.map((h) => (
            <div key={h} className="pb-1 text-center text-[10px] text-[var(--text-muted)] tabular-nums">
              {hourLabel(h)}
            </div>
          ))}
          {WEEKDAYS.map(({ w, label }) => (
            <div key={w} role="row" className="contents">
              <div className="flex items-center pr-2 text-xs text-[var(--text-secondary)]">{label}</div>
              {HOURS.map((h) => {
                const c = cell(w, h);
                const enough = c !== undefined && c.n >= minN;
                return (
                  <div
                    key={h}
                    role="gridcell"
                    tabIndex={0}
                    aria-label={`${label} ${hourLong(h)}: ${
                      enough ? `${Math.round(c!.share_within_60s * 100)}% within 60s, n=${c!.n}` : `not enough data${c ? `, n=${c.n}` : ''}`
                    }`}
                    onMouseEnter={() => setHover({ w, h })}
                    onFocus={() => setHover({ w, h })}
                    onMouseLeave={() => setHover(null)}
                    onBlur={() => setHover(null)}
                    className={`h-7 rounded-[3px] ${
                      enough ? '' : 'border border-dashed border-[var(--rule)] bg-[var(--surface-1)]'
                    } ${hover && hover.w === w && hover.h === h ? 'outline outline-2 outline-[var(--text-primary)]' : ''}`}
                    style={enough ? { background: colorFor(c!.share_within_60s) } : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Hover readout, always the same place so nothing jumps on camera. */}
      <p className="mt-2 h-5 text-sm text-[var(--text-secondary)]" aria-live="polite">
        {hover
          ? (() => {
              const w = WEEKDAYS.find((x) => x.w === hover.w)!.label;
              if (!hovered) return `${w} ${hourLong(hover.h)}: no predictions recorded.`;
              if (hovered.n < minN) return `${w} ${hourLong(hover.h)}: not enough data (n=${fmtInt(hovered.n)}, needs ${minN}).`;
              return `${w} ${hourLong(hover.h)}: ${Math.round(hovered.share_within_60s * 100)}% of predictions within 60 seconds (n=${fmtInt(hovered.n)}).`;
            })()
          : failed
            ? 'This stop could not be loaded.'
            : ' '}
      </p>

      {/* Legend: real numbers at both ends, the direction in words, and the fit stated.
          14px with bold end values, larger than the page's 12px captions: it must stay
          legible when a screen recording is scaled down to half size (checked). */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">Share of predictions within 60 seconds</span>
        <span className="flex items-center gap-2.5">
          <span className="font-semibold text-[var(--text-primary)]">Worse</span>
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">≤{pct(fit.lo)}</span>
          <span
            aria-hidden
            className="block h-4 w-56 rounded-[3px]"
            style={{ background: `linear-gradient(to right, ${RAMP.join(', ')})` }}
          />
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">≥{pct(fit.hi)}</span>
          <span className="font-semibold text-[var(--text-primary)]">Better</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="block h-3 w-4 rounded-[2px] border border-dashed border-[var(--rule)]" aria-hidden />
          fewer than {minN} predictions
        </span>
      </div>
      <p className="mt-2 max-w-2xl text-xs text-[var(--text-muted)]">
        Higher is better here: unlike the error figures above, this is the share of predictions that
        landed within a minute of the actual arrival. The colour ramp is fitted to the {sel.bucket}{' '}
        evaluation point &mdash; it spans the middle 90% of every stop&rsquo;s cells at that point, so
        stops can be compared by colour. Changing the evaluation point refits it.
      </p>
    </div>
  );
}
