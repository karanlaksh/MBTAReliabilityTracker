import { fmtInt, type SliceResponse } from '@/lib/api';

/**
 * The typical-week grid — stop x weekday x hour x bucket — deliberately NOT
 * rendered yet.
 *
 * Display is gated on sample size: a median from a handful of observations would
 * be inventing precision. The gate is data-driven, so the section turns itself on
 * once the data supports it, with no code change — PROVIDED the grid accumulates
 * across dates. While the API reports a rolling window_days, each cell holds about
 * one day of data and the gate cannot open; the box says so rather than implying
 * it is filling in.
 */
export default function SliceGrid({ data }: { data: SliceResponse | null }) {
  if (!data) return null;

  // Density, not a raw count. A grid where 8% of cells clear the threshold is not
  // a grid, however many cells that happens to be in absolute terms. Both
  // conditions are data-driven, so this section switches itself on once the
  // sample genuinely supports it — no code change required.
  const MIN_COVERAGE = 0.6;
  const MIN_MEAN_N = 20;
  const ready = data.coverage >= MIN_COVERAGE && data.mean_n_per_cell >= MIN_MEAN_N;
  if (!ready) {
    const counts = (
      <>
        Of {fmtInt(data.cells_total)} cells, {fmtInt(data.cells_passing)} currently reach
        n&nbsp;&ge;&nbsp;{data.min_n} &mdash; {(data.coverage * 100).toFixed(1)}% coverage, at a mean
        of {fmtInt(data.mean_n_per_cell)} observations per cell.
      </>
    );
    // Worded from what the data can actually do. "Filling in" is only true when
    // the grid accumulates; a rolling window never fills in, and saying it would
    // is the same kind of promise the old "not enough data yet" box broke.
    return (
      <div className="rounded-lg border border-dashed border-[var(--rule)] px-5 py-4 text-sm">
        {data.window_days ? (
          <>
            <h2 className="font-semibold text-[var(--text-primary)]">
              Typical week grid &mdash; rolling {data.window_days}-day view
            </h2>
            <p className="mt-1 text-[var(--text-secondary)]">
              A stop &times; weekday &times; hour breakdown, shown once each cell holds at least{' '}
              {MIN_MEAN_N} graded predictions on average and {(MIN_COVERAGE * 100).toFixed(0)}% of cells
              reach n&nbsp;&ge;&nbsp;{data.min_n}. {counts} It currently covers only the last{' '}
              {data.window_days} days, so each cell holds about one day of data and cannot reach
              that threshold until the grid accumulates across dates.
            </p>
          </>
        ) : (
          <>
            <h2 className="font-semibold text-[var(--text-primary)]">
              Typical week grid &mdash; filling in
            </h2>
            <p className="mt-1 text-[var(--text-secondary)]">
              A stop &times; weekday &times; hour breakdown, accumulating one service date at a
              time. {counts} It appears once {(MIN_COVERAGE * 100).toFixed(0)}% of cells reach
              n&nbsp;&ge;&nbsp;{data.min_n} and the mean reaches {MIN_MEAN_N}, so no cell is drawn
              from a handful of observations.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Typical week</h2>
      <p className="mb-4 mt-1 text-sm text-[var(--text-secondary)]">
        Cells with at least {data.min_n} graded predictions.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--rule)] text-left text-[var(--text-secondary)]">
              <th scope="col" className="py-2 pr-4 font-medium">Stop</th>
              <th scope="col" className="py-2 pr-4 font-medium">Weekday</th>
              <th scope="col" className="py-2 pr-4 font-medium">Hour</th>
              <th scope="col" className="py-2 pr-4 font-medium">Point</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Median</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">n</th>
            </tr>
          </thead>
          <tbody>
            {data.cells.slice(0, 60).map((c, i) => (
              <tr key={i} className="border-b border-[var(--grid)]">
                <td className="py-1.5 pr-4">{c.stop_id}</td>
                <td className="py-1.5 pr-4">{c.weekday}</td>
                <td className="py-1.5 pr-4 tabular-nums">{c.hour}:00</td>
                <td className="py-1.5 pr-4">{c.horizon_bucket}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">
                  {c.median_error_sec === null ? '—' : `${c.median_error_sec > 0 ? '+' : ''}${Math.round(c.median_error_sec)}s`}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{fmtInt(c.n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
