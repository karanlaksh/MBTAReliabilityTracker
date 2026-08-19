import { fmtInt, type ServiceAlert, type SummaryResponse } from '@/lib/api';

/**
 * Find the alert that explains a slice reporting no service.
 *
 * A watched slice at zero MUST read as "no service" with the governing notice,
 * never as a flat line at zero. Zero predictions and a broken collector look
 * identical in a chart, and the whole point of capturing alerts was so a gap
 * carries its own explanation instead of being inferred from MBTA's website.
 */
function explain(routeId: string, alerts: ServiceAlert[]): ServiceAlert | null {
  const hits = alerts.filter(
    (a) => a.routes.includes(routeId) && (a.effect === 'SUSPENSION' || a.effect === 'SHUTTLE'),
  );
  return hits.sort((a, b) => (b.start ?? 0) - (a.start ?? 0))[0] ?? null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--rule)] bg-[var(--surface-1)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{hint}</div> : null}
    </div>
  );
}

export default function CollectionStatus({ summary }: { summary: SummaryResponse }) {
  const rate = summary.unfulfilled_rate;
  const bySource = summary.arrivals_by_source;
  const total = bySource.reduce((n, s) => n + s.n, 0);

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Collecting since"
          value={summary.since ?? '—'}
          hint={summary.until ? `through ${summary.until}` : undefined}
        />
        <Stat label="Graded predictions" value={fmtInt(summary.graded_predictions)} />
        <Stat
          label="Unfulfilled rate"
          value={rate === null ? 'insufficient data' : `${(rate * 100).toFixed(1)}%`}
          hint={`${fmtInt(summary.unfulfilled)} skipped or vanished, of ${fmtInt(summary.graded_predictions)}`}
        />
        <Stat
          label="Failed collector runs"
          value={fmtInt(summary.collector.failed_runs)}
          hint={`of ${fmtInt(summary.collector.runs_retained)} retained (7 days)`}
        />
      </div>

      <h3 className="mt-8 text-sm font-semibold text-[var(--text-primary)]">Watched stops</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--rule)] text-left text-[var(--text-secondary)]">
              <th scope="col" className="py-2 pr-4 font-medium">Stop</th>
              <th scope="col" className="py-2 pr-4 font-medium">Mode</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Arrivals</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Last 7 days</th>
            </tr>
          </thead>
          <tbody>
            {summary.slices.map((s) => {
              const alert = s.no_recent_service ? explain(s.route_id, summary.service_alerts) : null;
              return (
                <tr key={`${s.stop_id}-${s.route_id}-${s.direction_id}`} className="border-b border-[var(--grid)]">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    {s.label}
                    {s.stop_role === 'terminus' ? (
                      <span className="ml-2 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                        terminus
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-4 text-[var(--text-secondary)]">{s.mode}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{fmtInt(s.arrivals)}</td>
                  <td className="py-2 pr-4 text-right">
                    {s.no_recent_service ? (
                      // Not a zero. "No service", with the notice that caused it.
                      <span className="text-[var(--text-secondary)]">
                        <span className="font-medium text-[var(--warning)]">no service</span>
                        {alert ? (
                          <span className="mt-0.5 block max-w-md text-left text-xs text-[var(--text-muted)]">
                            {alert.header}
                          </span>
                        ) : (
                          <span className="mt-0.5 block text-left text-xs text-[var(--text-muted)]">
                            no governing alert recorded
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="tabular-nums">{fmtInt(s.arrivals_last_7d)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="mt-8 text-sm font-semibold text-[var(--text-primary)]">
        How each arrival was established
      </h3>
      <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
        {bySource.map((s) => (
          <li key={s.source} className="flex items-baseline justify-between gap-4 border-b border-[var(--grid)] py-1">
            <span className="font-mono text-xs">{s.source}</span>
            <span className="tabular-nums">
              {fmtInt(s.n)}
              <span className="ml-2 text-[var(--text-muted)]">
                {total > 0 ? `${((100 * s.n) / total).toFixed(1)}%` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        <code>no_arrival_predicted</code> means MBTA published a departure time but never an arrival
        time, mostly at the origin terminus. Those are excluded from the unfulfilled rate: un-promised
        is not the same as unfulfilled.
      </p>
    </div>
  );
}
