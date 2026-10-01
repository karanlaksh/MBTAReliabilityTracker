'use client';

import { useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend,
} from 'recharts';
import {
  BUCKETS, DEGRADED_WINDOW, ROUTE_COLOR, fmtInt, fmtSigned, type Bucket, type DayRow,
} from '@/lib/api';

/** Every ISO date from `from` to `to` inclusive. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}


/**
 * Partial days are DROPPED from the plotted line, not drawn faintly.
 *
 * A partial service date has fewer graded arrivals and renders as a dip at the
 * right-hand edge — a collection artifact that looks exactly like a finding, and
 * appears precisely where the eye expects the newest and most interesting data.
 * They are listed below the chart instead, so they are disclosed rather than
 * hidden, but nothing can mistake one for a complete point.
 *
 * The same reasoning covers DEGRADED_WINDOW, the September read-limit outage:
 * those dates are partial by construction. The whole window collapses to ONE
 * axis slot — a dashed break with its own tick — rather than 28 empty days. It
 * is never removed: without it Aug 30 would sit directly beside Sept 29 and the
 * line would read as consecutive days. Every other date keeps its own slot, so
 * any future missing day still shows as a gap rather than silently closing up.
 */

/** Axis key for the collapsed degraded window. Not a date, so it can't collide. */
const BREAK_KEY = 'break';

/**
 * Date labels on the first line; the break's label on a second line beneath its
 * dashed rule. Two lines is what lets the dates either side of the break keep
 * their own labels instead of being thinned away to make room for it.
 */
function BreakAwareTick({
  x, y, payload, breakLabel,
}: { x: number; y: number; payload: { value: string }; breakLabel: string }) {
  const isBreak = payload.value === BREAK_KEY;
  return (
    <text
      x={x}
      y={y}
      dy={isBreak ? 26 : 12}
      textAnchor="middle"
      fontSize={isBreak ? 10 : 11}
      fill={isBreak ? 'var(--text-muted)' : 'var(--text-secondary)'}
    >
      {isBreak ? breakLabel : payload.value}
    </text>
  );
}
export default function TimeSeries({
  rows,
  degraded = DEGRADED_WINDOW,
}: {
  rows: DayRow[];
  /**
   * The window drawn as a collapsed break, and the caption that explains it.
   * null in DEMO_MODE only: the seeded data has no outage to mark.
   */
  degraded?: { from: string; to: string; label: string } | null;
}) {
  const isDegraded = (d: string) => degraded !== null && d >= degraded.from && d <= degraded.to;
  const [bucket, setBucket] = useState<Bucket>('~9 min');

  const forBucket = rows.filter((r) => r.bucket === bucket);
  const complete = forBucket.filter((r) => !r.is_partial);
  const partial = forBucket.filter((r) => r.is_partial);

  const routes = [...new Set(complete.map((r) => r.route_id))];
  const dates = [...new Set(complete.map((r) => r.service_date))].sort();
  const degradedWithData = dates.filter(isDegraded);

  // Every date from the first to the later of the last date and the end of the
  // degraded window — the domain comes from the DATA; the window only extends it
  // while nothing newer exists — with the degraded dates replaced by one slot.
  const span = dates.length
    ? dateRange(
        dates[0],
        degraded === null || dates[dates.length - 1] > degraded.to ? dates[dates.length - 1] : degraded.to,
      )
    : [];
  const axis: string[] = [];
  for (const d of span) {
    if (!isDegraded(d)) axis.push(d);
    else if (axis[axis.length - 1] !== BREAK_KEY) axis.push(BREAK_KEY);
  }
  const breakLabel = degraded?.label ?? '';
  // Which dates get a tick label. The break's label is drawn on a SECOND LINE
  // (see BreakAwareTick), so it can never collide with a date; dates only have to
  // avoid each other. Dates are kept greedily by priority — the first date after
  // the break and the last date always, then every fourth — and a date is skipped
  // only if an already-kept date sits in an adjacent slot, where the two labels
  // would overprint. The previous rule dropped every date within two slots of the
  // break, which with one or two post-break dates left them all unlabelled.
  const breakAt = axis.indexOf(BREAK_KEY);
  const priority: number[] = [];
  if (breakAt >= 0 && breakAt + 1 < axis.length) priority.push(breakAt + 1);
  priority.push(axis.length - 1);
  for (let i = 0; i < axis.length; i += 4) priority.push(i);
  const keptDates: number[] = [];
  for (const i of priority) {
    if (i < 0 || axis[i] === BREAK_KEY || keptDates.includes(i)) continue;
    if (keptDates.some((k) => Math.abs(k - i) < 2)) continue;
    keptDates.push(i);
  }
  const ticks = axis
    .map((d, i) => ({ d, i }))
    .filter(({ d, i }) => d === BREAK_KEY || keptDates.includes(i))
    .map(({ d }) => (d === BREAK_KEY ? d : d.slice(5)));

  const data = axis.map((d) => {
    const row: Record<string, string | number | null> = {
      service_date: d === BREAK_KEY ? BREAK_KEY : d.slice(5),
    };
    for (const rt of routes) {
      const hit = d === BREAK_KEY
        ? undefined
        : complete.find((r) => r.service_date === d && r.route_id === rt);
      // Below threshold reads as absent, not as zero.
      row[rt] = hit && hit.n >= 20 ? hit.median_sec : null;
      row[`${rt}__n`] = hit?.n ?? 0;
    }
    return row;
  });

  if (!dates.length) {
    return <p className="text-sm text-[var(--text-secondary)]">Insufficient data.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">Evaluation point:</span>
        {BUCKETS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBucket(b)}
            aria-pressed={b === bucket}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              b === bucket
                ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-white'
                : 'border-[var(--rule)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
            }`}
          >
            {b} out
          </button>
        ))}
      </div>

      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="service_date"
              stroke="var(--rule)"
              tickLine={false}
              ticks={ticks}
              interval={0}
              height={40}
              tick={(props: any) => <BreakAwareTick {...props} breakLabel={breakLabel} />}
            />
            {axis.includes(BREAK_KEY) ? (
              <ReferenceLine x={BREAK_KEY} stroke="var(--text-muted)" strokeDasharray="3 3" />
            ) : null}
            <YAxis
              tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
              stroke="var(--rule)"
              tickLine={false}
              width={52}
              tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}s`}
            />
            <ReferenceLine
              y={0}
              stroke="var(--zero-line)"
              strokeWidth={1.5}
              label={{ value: 'on time', position: 'insideTopLeft', fontSize: 11, fill: 'var(--text-muted)' }}
            />
            <Tooltip
              content={({ active, payload, label }: any) => {
                if (!active || !payload?.length || label === BREAK_KEY) return null;
                return (
                  <div className="rounded-md border border-[var(--rule)] bg-white px-3 py-2 text-sm shadow-sm">
                    <div className="mb-1 font-medium">{label}</div>
                    {payload.map((p: any) => (
                      <div key={p.dataKey} className="flex items-center gap-2 text-[var(--text-secondary)]">
                        <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: p.stroke }} />
                        <span>{p.name}</span>
                        <span className="font-medium text-[var(--text-primary)]">{fmtSigned(p.value)}</span>
                        <span className="text-[var(--text-muted)]">n={fmtInt(Number(p.payload?.[`${p.dataKey}__n`] ?? 0))}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Legend verticalAlign="bottom" height={28} wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
            {routes.map((rt) => (
              <Line
                key={rt}
                type="linear"
                dataKey={rt}
                name={complete.find((r) => r.route_id === rt)?.label ?? rt}
                stroke={ROUTE_COLOR[rt] ?? 'var(--text-secondary)'}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 2, fill: 'var(--surface-1)' }}
                activeDot={{ r: 6 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Median signed error per service date at the {bucket} evaluation point. Gaps are dates with
        fewer than 20 graded arrivals for that route.
        {degraded !== null ? (
          <>
            {' '}
            The dashed break marks {breakLabel}, compressed to a single step: the read-limit outage,
            when collection ran only from 20:00 ET until the database&rsquo;s daily read budget ran out
            {degradedWithData.length > 0 ? (
              <>
                {' '}
                &mdash; the {degradedWithData.length} partial date
                {degradedWithData.length === 1 ? '' : 's'} recorded in it are not plotted
              </>
            ) : null}
            ; see limitations. Aug 18 and Aug 20&ndash;30 left an unusually high share of arrivals
            unmatched (30&ndash;43%, against 1&ndash;5% on other days), for a reason not yet
            determined.
          </>
        ) : null}
        {partial.length > 0 && (
          <>
            {' '}
            {partial.length} in-progress service date
            {partial.length === 1 ? '' : 's'} (
            {[...new Set(partial.map((p) => p.service_date))].join(', ')}) {partial.length === 1 ? 'is' : 'are'}{' '}
            excluded: a day still being collected has fewer graded arrivals and would read as a dip.
          </>
        )}
      </p>
    </div>
  );
}
