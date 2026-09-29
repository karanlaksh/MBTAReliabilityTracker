'use client';

import { useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend,
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

const isDegraded = (d: string) => d >= DEGRADED_WINDOW.from && d <= DEGRADED_WINDOW.to;

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
 * those dates are partial by construction. The axis is continuous, so the gap
 * occupies its real width and is shaded and labelled — visible, never collapsed
 * into a seamless line from August to late September.
 */
export default function TimeSeries({ rows }: { rows: DayRow[] }) {
  const [bucket, setBucket] = useState<Bucket>('~9 min');

  const forBucket = rows.filter((r) => r.bucket === bucket);
  const complete = forBucket.filter((r) => !r.is_partial);
  const partial = forBucket.filter((r) => r.is_partial);

  const routes = [...new Set(complete.map((r) => r.route_id))];
  const dates = [...new Set(complete.map((r) => r.service_date))].sort();
  const degradedWithData = dates.filter(isDegraded);

  // Continuous axis from the first date to the later of the last date and the end
  // of the degraded window, so the gap is drawn at its true width.
  const axis = dates.length
    ? dateRange(dates[0], dates[dates.length - 1] > DEGRADED_WINDOW.to ? dates[dates.length - 1] : DEGRADED_WINDOW.to)
    : [];

  const data = axis.map((d) => {
    const row: Record<string, string | number | null> = { service_date: d.slice(5) };
    for (const rt of routes) {
      const hit = isDegraded(d)
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
              tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
              stroke="var(--rule)"
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <ReferenceArea
              x1={DEGRADED_WINDOW.from.slice(5)}
              x2={DEGRADED_WINDOW.to.slice(5)}
              fill="var(--surface-2)"
              fillOpacity={1}
              stroke="var(--rule)"
              strokeDasharray="3 3"
              label={{
                value: `collection degraded, ${DEGRADED_WINDOW.label} — not plotted`,
                position: 'insideTop',
                fontSize: 11,
                fill: 'var(--text-muted)',
              }}
            />
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
                if (!active || !payload?.length) return null;
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
        fewer than 20 graded arrivals for that route. The shaded band is the September read-limit
        outage, when collection ran only from 20:00 ET until the database&rsquo;s daily read budget
        ran out
        {degradedWithData.length > 0 ? (
          <>
            {' '}
            &mdash; the {degradedWithData.length} partial date{degradedWithData.length === 1 ? '' : 's'}{' '}
            recorded in it are not plotted
          </>
        ) : null}
        ; see limitations. Aug 18 and Aug 20&ndash;30 left an unusually high share of arrivals
        unmatched (30&ndash;43%, against 1&ndash;5% on other days), for a reason not yet determined.
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
