import TypicalWeekHeatmap from '@/components/TypicalWeekHeatmap';
import { fmtInt, type SliceInfo, type SliceResponse } from '@/lib/api';

/**
 * The typical-week grid — stop x weekday x hour x bucket — deliberately NOT
 * rendered yet.
 *
 * The value shown is the SHARE OF PREDICTIONS WITHIN 60 SECONDS — exact, resistant
 * to outliers, and readable without a footnote ("4 in 10 at Ruggles at 8am are
 * within a minute"). The grid accumulates across service dates as sums and counts
 * (migration 0011), so cells fill in over time and the gate below can open.
 *
 * Display is still gated on sample size: a share from a handful of predictions
 * would be inventing precision. The gate is data-driven and comes from the API, so
 * the section turns itself on once the data supports it, with no code change.
 */
export default function SliceGrid({
  data,
  slices,
  apiBase,
}: {
  data: SliceResponse | null;
  /** Watched stop-directions, for the heatmap's selectors. */
  slices: SliceInfo[];
  /** Worker base including any /demo prefix, for the heatmap's refetches. */
  apiBase: string;
}) {
  if (!data) return null;

  // Density, not a raw count. A grid where 8% of cells clear the threshold is not
  // a grid, however many cells that happens to be in absolute terms. Both
  // conditions are data-driven, so this section switches itself on once the
  // sample genuinely supports it — no code change required.
  const MIN_COVERAGE = data.gate?.minCoverage ?? 0.6;
  const MIN_MEAN_N = data.gate?.minMeanN ?? 20;
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
              How often predictions land within a minute, by stop, weekday and hour. It accumulates
              one service date at a time
              {data.accumulation?.dates_folded ? (
                <> &mdash; {fmtInt(data.accumulation.dates_folded)} so far</>
              ) : null}
              . {counts} It appears once {(MIN_COVERAGE * 100).toFixed(0)}% of cells reach
              n&nbsp;&ge;&nbsp;{data.min_n} and the mean reaches {MIN_MEAN_N}, so no cell is drawn
              from a handful of predictions.{' '}
              {data.estimate?.date ? (
                <>
                  At the current rate that should be around{' '}
                  <strong className="font-semibold text-[var(--text-primary)]">
                    {new Date(`${data.estimate.date}T12:00:00Z`).toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </strong>
                  .
                </>
              ) : (
                <>No estimate yet: {data.estimate?.basis ?? 'too few dates accumulated'}.</>
              )}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Typical week</h2>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
        How often predictions land within a minute of the actual arrival, by weekday and hour, for
        one stop at a time. Accumulated across {fmtInt(data.accumulation?.dates_folded ?? 0)} service
        dates; cells with fewer than {data.min_n} predictions are left empty.
      </p>
      <TypicalWeekHeatmap slices={slices} apiBase={apiBase} minN={data.min_n} initial={data.slice ?? null} />
    </div>
  );
}
