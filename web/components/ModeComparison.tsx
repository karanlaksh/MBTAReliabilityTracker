'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BUCKETS, ROUTE_COLOR, fmtInt, fmtSigned, type HorizonSeries } from '@/lib/api';

/** Minimum n before a cell is quoted at all. Below this it says so. */
const MIN_N = 20;

interface Row {
  bucket: string;
  [key: string]: string | number | null;
}

function toRows(series: HorizonSeries[], metric: 'median_sec' | 'p90_sec'): Row[] {
  return BUCKETS.map((b) => {
    const row: Row = { bucket: b };
    for (const s of series) {
      const p = s.points.find((x) => x.bucket === b);
      row[s.route_id] = p && p.n >= MIN_N ? (p[metric] ?? null) : null;
      row[`${s.route_id}__n`] = p?.n ?? 0;
    }
    return row;
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-[var(--rule)] bg-white px-3 py-2 text-sm shadow-sm">
      <div className="mb-1 font-medium text-[var(--text-primary)]">{label} out</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-[var(--text-secondary)]">
          <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: p.stroke }} />
          <span>{p.name}</span>
          <span className="font-medium text-[var(--text-primary)]">{fmtSigned(p.value)}</span>
          {/* n travels with every value. No median without its sample size. */}
          <span className="text-[var(--text-muted)]">n={fmtInt(Number(p.payload?.[`${p.dataKey}__n`] ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  series,
  metric,
}: {
  title: string;
  subtitle: string;
  series: HorizonSeries[];
  metric: 'median_sec' | 'p90_sec';
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
        <p className="text-xs text-[var(--text-secondary)]">{subtitle}</p>
      </figcaption>
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={toRows(series, metric)} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
              stroke="var(--rule)"
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
              stroke="var(--rule)"
              tickLine={false}
              width={54}
              tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}s`}
            />
            {/* Unambiguous zero: heavier than the grid and labelled, so nobody has
                to ask which direction is bad. */}
            <ReferenceLine
              y={0}
              stroke="var(--zero-line)"
              strokeWidth={1.5}
              label={{
                value: 'on time',
                // Right end: at the left it overprinted the first x tick and, in the
                // median chart, the Green Line's -9s point at ~1.5 min.
                position: 'insideTopRight',
                // Lifted clear of the line: where the axis starts at 0 (the p90
                // chart) the zero line IS the x-axis, and the label touched "~16 min".
                offset: -8,
                fontSize: 11,
                fill: 'var(--text-muted)',
              }}
            />
            <Tooltip content={<ChartTooltip />} />
            <Legend
              verticalAlign="bottom"
              height={28}
              wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
            />
            {series.map((s) => (
              <Line
                key={s.route_id}
                type="linear"
                dataKey={s.route_id}
                name={s.label}
                stroke={ROUTE_COLOR[s.route_id] ?? 'var(--text-secondary)'}
                strokeWidth={2}
                dot={{ r: 4, strokeWidth: 2, fill: 'var(--surface-1)' }}
                activeDot={{ r: 6 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export default function ModeComparison({ series }: { series: HorizonSeries[] }) {
  if (!series.length) {
    return <p className="text-sm text-[var(--text-secondary)]">Insufficient data.</p>;
  }
  return (
    <div>
      <div className="grid gap-8 md:grid-cols-2">
        <Panel
          title="Median error"
          subtitle="The typical miss. Positive = arrived later than predicted."
          series={series}
          metric="median_sec"
        />
        <Panel
          title="90th percentile error"
          subtitle="The bad tail: one trip in ten is at least this wrong."
          series={series}
          metric="p90_sec"
        />
      </div>

      {/* Table view, so identity is never colour-alone and every n is legible
          without hovering. */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Median and 90th percentile signed error by route and evaluation point
          </caption>
          <thead>
            <tr className="border-b border-[var(--rule)] text-left text-[var(--text-secondary)]">
              <th scope="col" className="py-2 pr-4 font-medium">Route</th>
              {BUCKETS.map((b) => (
                <th key={b} scope="col" className="py-2 pr-4 text-right font-medium">
                  {b} out
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.route_id} className="border-b border-[var(--grid)]">
                <th scope="row" className="py-2 pr-4 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5"
                      style={{
                        background: ROUTE_COLOR[s.route_id],
                        borderRadius: s.route_id === 'Orange' ? 999 : 2,
                      }}
                    />
                    {s.label}
                  </span>
                </th>
                {BUCKETS.map((b) => {
                  const p = s.points.find((x) => x.bucket === b);
                  // Absent or below threshold says so. Never a zero, which would
                  // read as "perfectly accurate".
                  if (!p || p.n < MIN_N) {
                    return (
                      <td key={b} className="py-2 pr-4 text-right text-[var(--text-muted)]">
                        insufficient data
                      </td>
                    );
                  }
                  return (
                    <td key={b} className="py-2 pr-4 text-right tabular-nums">
                      <span className="font-medium">{fmtSigned(p.median_sec)}</span>
                      <span className="text-[var(--text-muted)]"> / {fmtSigned(p.p90_sec)}</span>
                      <span className="block text-xs text-[var(--text-muted)]">n={fmtInt(p.n)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Each cell shows median / 90th percentile, then sample size. Positive means the vehicle
          arrived <strong>later</strong> than MBTA predicted.
        </p>
      </div>
    </div>
  );
}
