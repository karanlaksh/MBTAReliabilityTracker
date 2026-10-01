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
 * Five fixed 20-point bands, the same for every stop, so two stops can be compared
 * by eye. Steps from the reference sequential ramp starting at step 250, validated
 * with the dataviz palette checker on this surface (#fcfcfb, ordinal): monotone
 * lightness, adjacent gaps >= 0.06, light end 2.06:1, single hue — all pass.
 *
 * Cells below MIN_N are drawn EMPTY, not coloured: no figure without its sample
 * size, as everywhere else on this page. n is in every tooltip.
 */
const BANDS = [
  { min: 0.8, color: '#0d366b', label: '80–100%' },
  { min: 0.6, color: '#1c5cab', label: '60–80%' },
  { min: 0.4, color: '#2a78d6', label: '40–60%' },
  { min: 0.2, color: '#5598e7', label: '20–40%' },
  { min: 0, color: '#86b6ef', label: '0–20%' },
];
const colorFor = (share: number) => BANDS.find((b) => share >= b.min)!.color;

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
}: {
  /** Watched stop-directions, from /api/summary. */
  slices: SliceInfo[];
  /** Worker base URL including any /demo prefix; the browser refetches from it. */
  apiBase: string;
  minN: number;
  /** The default slice, fetched on the server so the first paint has data. */
  initial: SliceCells | null;
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

      {/* Legend: the direction is stated in words at both ends, not left to colour. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">Share of predictions within 60 seconds</span>
        <span>Worse</span>
        <span className="flex gap-[2px]" aria-hidden>
          {[...BANDS].reverse().map((b) => (
            <span key={b.color} className="flex flex-col items-center">
              <span className="block h-3 w-9 rounded-[2px]" style={{ background: b.color }} />
              <span className="mt-0.5 text-[10px] text-[var(--text-muted)] tabular-nums">{b.label}</span>
            </span>
          ))}
        </span>
        <span>Better</span>
        <span className="flex items-center gap-1.5">
          <span className="block h-3 w-4 rounded-[2px] border border-dashed border-[var(--rule)]" aria-hidden />
          fewer than {minN} predictions
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Higher is better here: unlike the error figures above, this is the share of predictions that
        landed within a minute of the actual arrival.
      </p>
    </div>
  );
}
