import CollectionStatus from '@/components/CollectionStatus';
import DataAge from '@/components/DataAge';
import DegradedBanner from '@/components/DegradedBanner';
import Finding from '@/components/Finding';
import Limitations from '@/components/Limitations';
import ModeComparison from '@/components/ModeComparison';
import SliceGrid from '@/components/SliceGrid';
import TimeSeries from '@/components/TimeSeries';
import {
  DEGRADED_WINDOW,
  PRIMARY_WINDOW,
  getJson,
  type DayResponse,
  type HorizonResponse,
  type SliceResponse,
  type SummaryResponse,
} from '@/lib/api';

/**
 * Backstop only. Time-based ISR is stale-while-revalidate: the first visit after
 * the window expires is served the OLD page and merely triggers a rebuild, so on
 * a rarely visited page it cannot keep the page current by itself. What keeps it
 * current is app/api/revalidate, called by a daily Vercel cron after the 04:00 ET
 * rollup. The page states its own data age either way (DataAge).
 */
export const revalidate = 1800;

export default async function Page() {
  // Fetched in parallel; each returns a value on failure rather than throwing, so
  // one dead endpoint degrades a section instead of the page.
  const [horizon, days, summary, slices] = await Promise.all([
    // The finding and the mode comparison are graded over the primary window only,
    // not pooled across the September outage. The day-by-day series is not
    // windowed: it shows everything, with the outage as a labelled gap.
    getJson<HorizonResponse>(
      `/api/error-by-horizon?from=${PRIMARY_WINDOW.from}&to=${PRIMARY_WINDOW.to}`,
    ),
    getJson<DayResponse>('/api/error-by-day'),
    getJson<SummaryResponse>('/api/summary'),
    getJson<SliceResponse>('/api/error-by-slice?min_n=20'),
  ]);

  const problems = [horizon.error, days.error, summary.error, slices.error].filter(
    (e): e is string => e !== null,
  );

  const series = horizon.data?.series ?? [];

  // The OLDEST response this render used: the page is only as fresh as its
  // stalest input.
  const fetchedTimes = [horizon, days, summary, slices]
    .map((r) => r.fetchedAt)
    .filter((t): t is number => t !== null);
  const fetchedAt = fetchedTimes.length ? Math.min(...fetchedTimes) : null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-12 sm:px-8">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">
          MBTA prediction reliability
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          How wrong are MBTA&rsquo;s arrival predictions?
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">
          Every prediction is recorded as MBTA publishes it, then matched against the arrival that
          actually fulfilled it. Predictions are ephemeral &mdash; once overwritten the old value is
          gone &mdash; so this is a record that cannot be reconstructed after the fact.
        </p>
      </header>

      {/* One quiet paragraph, not a failure box: nobody should scroll past a list
          of HTTP errors to reach the result. The failure detail sits with the
          section the failing endpoints actually feed. */}
      <div className="mb-8 space-y-1">
        <p className="text-sm text-[var(--text-secondary)]">
          Primary analysis covers {PRIMARY_WINDOW.label}. Collection was degraded{' '}
          {DEGRADED_WINDOW.label} &mdash; see{' '}
          <a href="#limitations" className="underline underline-offset-2">
            limitations
          </a>
          .
          {problems.length > 0 ? (
            <>
              {' '}
              Some figures may currently be incomplete &mdash; see{' '}
              <a href="#collection-status" className="underline underline-offset-2">
                collection status
              </a>
              .
            </>
          ) : null}
        </p>
        <DataAge fetchedAt={fetchedAt} rollupAt={summary.data?.rollup_computed_at ?? null} />
      </div>

      {/* 1. THE FINDING, generated from data, above everything else. */}
      <section className="mb-14 border-y border-[var(--rule)] py-8">
        <Finding series={series} windowLabel={PRIMARY_WINDOW.label} />
      </section>

      {/* 2. MODE COMPARISON. */}
      <section className="mb-14">
        <h2 className="text-lg font-semibold">Accuracy by how far ahead the prediction was made</h2>
        <p className="mb-5 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
          {PRIMARY_WINDOW.label}. Each point is graded at a fixed horizon &mdash; the prediction that
          was on the display when the vehicle was that far away. Positive means it arrived later than
          promised.
        </p>
        <ModeComparison series={series} />
      </section>

      {/* 3. TIME SERIES. */}
      <section className="mb-14">
        <h2 className="text-lg font-semibold">Day by day</h2>
        <p className="mb-5 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
          One point per service date. MBTA service dates roll over at 03:00, not midnight, so a
          late-night trip belongs to the previous day.
        </p>
        {days.data ? (
          <TimeSeries rows={days.data.rows} />
        ) : (
          // A failed fetch is not a shortage of data, and must not read as one.
          <p className="text-sm text-[var(--text-secondary)]">
            Day-by-day figures could not be loaded &mdash; see collection status.
          </p>
        )}
      </section>

      {/* Typical-week grid: query written, display gated on sample size. It turns
          itself on as months accumulate. */}
      <section className="mb-14">
        <SliceGrid data={slices.data} />
      </section>

      {/* 4. COLLECTION STATUS, with the degraded banner directly above it. */}
      <DegradedBanner messages={problems} />
      <section id="collection-status" className="mb-14 scroll-mt-8">
        <h2 className="text-lg font-semibold">Collection status</h2>
        <p className="mb-5 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
          What has been collected, and how completely.
        </p>
        {summary.data ? (
          <CollectionStatus summary={summary.data} />
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            Collection status unavailable &mdash; the status endpoint did not respond.
          </p>
        )}
      </section>

      {/* Limitations: on the page, not in a footer. */}
      <section id="limitations" className="mb-14 scroll-mt-8 rounded-lg bg-[var(--surface-2)] p-6">
        <h2 className="text-lg font-semibold">What this does not show</h2>
        <p className="mb-5 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
          Read these before quoting any number above. They are sourced from the project&rsquo;s own
          README, not written separately for this page.
        </p>
        <Limitations />
      </section>

      <footer className="border-t border-[var(--rule)] pt-6 text-xs text-[var(--text-muted)]">
        <p>
          Data from the MBTA V3 API. Rollups recompute daily at 04:00 ET, and this page is rebuilt
          once a day after that; the line at the top says when its data was actually fetched.
          Aggregates over a date range are n-weighted means of per-day medians, because medians do
          not compose &mdash; sample sizes are exact.
        </p>
      </footer>
    </main>
  );
}
