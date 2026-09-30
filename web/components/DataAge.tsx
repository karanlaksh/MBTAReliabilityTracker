'use client';

import { useEffect, useState } from 'react';

/**
 * How old this page's data is, stated on the page itself.
 *
 * Two different clocks, shown separately because they fail separately:
 *   - fetched: when the Worker produced the data this page was built from. Old
 *     means the PAGE has not been rebuilt (the daily revalidation did not run).
 *   - rollup: when the rollup tables were last recomputed. Old means the BACKEND
 *     has stopped summarising (the rollup failed or was skipped by its gate).
 *
 * The age is computed HERE, in the reader's browser, against the reader's clock.
 * A server-rendered "3 min ago" is baked into cached HTML and goes on saying
 * "3 min ago" for as long as the cache lives — which is the exact failure this
 * exists to expose. The absolute times are server-rendered, so they are visible
 * without JavaScript.
 */

/** Past this, the daily rebuild or the daily rollup has missed at least once. */
const STALE_AFTER_SEC = 26 * 3600;

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function ago(sec: number): string {
  const mins = Math.max(0, Math.round(sec / 60));
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function Stamp({ label, at, now }: { label: string; at: number | null; now: number | null }) {
  if (at === null) return <>{label} unknown</>;
  return (
    <>
      {label}{' '}
      <span suppressHydrationWarning>{FMT.format(new Date(at * 1000))} ET</span>
      {now !== null ? <> ({ago(now - at)})</> : null}
    </>
  );
}

export default function DataAge({
  fetchedAt,
  rollupAt,
}: {
  fetchedAt: number | null;
  rollupAt: number | null;
}) {
  // null until mounted, so server and client render identical markup.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  const pageStale = now !== null && fetchedAt !== null && now - fetchedAt > STALE_AFTER_SEC;
  const rollupStale = now !== null && rollupAt !== null && now - rollupAt > STALE_AFTER_SEC;

  return (
    <p className="text-xs text-[var(--text-muted)]">
      <Stamp label="Data fetched" at={fetchedAt} now={now} /> ·{' '}
      <Stamp label="rollup computed" at={rollupAt} now={now} />.
      {pageStale ? (
        <span className="font-semibold text-[var(--text-primary)]">
          {' '}
          This page is more than a day old: its scheduled daily rebuild has not run, so every figure
          on it may be out of date.
        </span>
      ) : null}
      {rollupStale ? (
        <span className="font-semibold text-[var(--text-primary)]">
          {' '}
          The rollup is more than a day old: the daily recompute has not run, so the newest service
          dates are missing.
        </span>
      ) : null}
    </p>
  );
}
