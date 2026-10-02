'use client';

import { useState } from 'react';

/**
 * DEMO ONLY — "so should I leave earlier?", answered from the rollup tables.
 *
 * The Worker (src/ask.ts) does all of it: a model parses the question into a
 * fixed schema, code looks the figures up and computes the platform-by time, and
 * the answer is a fixed template. This panel only sends the question and shows
 * what comes back — including the arithmetic, so the decision can be checked
 * rather than trusted.
 */
type Result =
  | {
      status: 'ok';
      answer: string;
      phrasing: 'model' | 'template';
      derivation: {
        arrive_by: string; ride_sec: number; headway_min: number; p90_sec: number;
        unrounded: string; platform_by: string; evaluation_point: string;
      };
    }
  | { status: string; answer: string };

/** Short label on the pill; the full question is what is sent. Nothing is truncated. */
const EXAMPLES = [
  {
    label: '9am interview at Park Street, from Northeastern',
    question: 'I have a 9am interview at Park Street. Leaving from Northeastern on a weekday — when should I be on the platform?',
  },
  { label: 'Ruggles → Downtown Crossing by 5:30pm Friday', question: 'Ruggles to Downtown Crossing, arriving by 5:30pm on Friday' },
  { label: 'Kenmore → Park Street by 9am', question: 'Kenmore to Park Street by 9am' },
];

export default function TripAssistant({ apiBase }: { apiBase: string }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setAsked(text);
    setResult(null);
    try {
      const res = await fetch(`${apiBase}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      setResult((await res.json()) as Result);
    } catch {
      setResult({ status: 'unavailable', answer: 'The assistant could not be reached just now.' });
    } finally {
      setBusy(false);
    }
  }

  const min = (s: number) => `${Math.round(s / 60)} min`;

  return (
    <div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <label htmlFor="trip-question" className="sr-only">Your trip</label>
        <input
          id="trip-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Northeastern to Park Street, arriving by 9am on a weekday"
          maxLength={300}
          className="flex-1 rounded-md border border-[var(--rule)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)] focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="rounded-md border border-[var(--text-primary)] bg-[var(--text-primary)] px-4 py-2 text-sm text-white transition disabled:opacity-50"
        >
          {busy ? 'Working it out…' : 'Ask'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">Try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            title={ex.question}
            onClick={() => {
              setQuestion(ex.question);
              void submit(ex.question);
            }}
            className="rounded-full border border-[var(--rule)] px-3 py-1 text-left text-xs text-[var(--text-secondary)] transition hover:border-[var(--text-muted)]"
          >
            {ex.label}
          </button>
        ))}
      </div>

      {asked ? (
        <div className="mt-5 border-l-2 border-[var(--rule)] pl-4" aria-live="polite">
          <p className="text-xs text-[var(--text-muted)]">{asked}</p>
          {result ? (
            <>
              <p className="mt-2 text-base leading-relaxed text-[var(--text-primary)]">{result.answer}</p>
              {result.status === 'ok' && 'derivation' in result ? (
                <details className="mt-3 text-sm text-[var(--text-secondary)]">
                  <summary className="cursor-pointer select-none text-xs text-[var(--text-muted)]">
                    How this was worked out
                  </summary>
                  <p className="mt-2 font-mono text-xs leading-relaxed tabular-nums">
                    {result.derivation.arrive_by} arrival
                    <br />− {min(result.derivation.ride_sec)} scheduled ride (MBTA timetable)
                    <br />− {result.derivation.headway_min} min headway (room to miss a train)
                    <br />− {min(Math.max(0, result.derivation.p90_sec))} 90th-percentile lateness at the destination
                    ({result.derivation.evaluation_point} out)
                    <br />= {result.derivation.unrounded}, rounded down to {result.derivation.platform_by}
                  </p>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    Every figure comes from the database and the arithmetic above. The language model only
                    reads the question; the answer is a fixed template, because a model rewording it can
                    misstate what a correct number means.
                  </p>
                </details>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-[var(--text-muted)]">Working it out…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
