import { afterEach, describe, expect, it, vi } from 'vitest';
import { __test, ask, TEMPLATE } from '../src/ask';

const { guardPhrasing, platformBy, bucketFor, findStops, fill } = __test;

describe('guardPhrasing — the model may not put a number on the screen', () => {
  const good =
    'On {day}s around {hour}, {share} of {route} predictions at {destination} land within a minute. ' +
    'For a {arrive_by} arrival, be on the platform at {origin} by {platform_by}.';

  it('accepts phrasing whose only figures are placeholders', () => {
    expect(guardPhrasing(good)).toEqual({ ok: true });
  });

  it('accepts the fixed template itself', () => {
    expect(guardPhrasing(TEMPLATE)).toEqual({ ok: true });
  });

  // Each of these is a way a model "helpfully" invents a number.
  const bad: [string, string, RegExp][] = [
    ['an invented clock time', good.replace('{platform_by}', '8:10'), /digit/],
    ['an invented percentage', good.replace('{share}', '62%'), /digit/],
    ['a digit anywhere', `${good} Allow 5 extra minutes.`, /digit/],
    ['a spelled-out quantity', `${good} Leave about ten minutes early.`, /number word: "ten"/],
    ['a spelled-out fraction', `${good} Roughly half the time it is late.`, /number word: "half"/],
    ['a percentage word', `${good} Ninety percent of the time.`, /number word/],
    ['an invented placeholder', `${good} The worst case is {p95}.`, /unknown placeholder \{p95\}/],
    ['a dropped decision', good.replace(', be on the platform at {origin} by {platform_by}', ''), /missing/],
    ['a dropped share', good.replace('{share}', 'most'), /missing \{share\}/],
    ['a malformed placeholder', `${good} {platform by}`, /unknown placeholder|stray brace/],
    ['an unbalanced brace', `${good} }`, /stray brace/],
    ['empty output', '', /empty/],
    ['runaway output', `${good} ${'very '.repeat(200)}`, /too long/],
  ];
  for (const [what, text, reason] of bad) {
    it(`rejects ${what}`, () => {
      const g = guardPhrasing(text);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toMatch(reason);
    });
  }

  it('CANNOT see a fabricated claim — why the model no longer phrases answers', () => {
    // Verbatim from a live run on seeded data, from a share of 18% of PREDICTIONS
    // within a minute. No digit outside a placeholder, no number word, every
    // placeholder valid: the guard passes it, and it is false twice ("most" of 18%;
    // punctuality, not prediction accuracy). A character check cannot see claims.
    const fabricatedClaim =
      'Most {share} of your {route} trips arrive right on time, and the usual delay is just {median}. ' +
      'To make your {arrive_by} arrival, head to the platform at {origin} by {platform_by} to stay safe.';
    expect(guardPhrasing(fabricatedClaim)).toEqual({ ok: true });
  });

  it('rejects non-string output', () => {
    expect(guardPhrasing(undefined).ok).toBe(false);
    expect(guardPhrasing({ text: good }).ok).toBe(false);
  });
});

describe('platformBy — the decision is arithmetic', () => {
  const t = (h: number, m: number) => h * 3600 + m * 60;

  it('subtracts ride, headway and p90 lateness, then rounds DOWN to 5 minutes', () => {
    // 9:00 - 13:00 ride - 8 min headway - 356s p90 = 8:33:04 -> 8:30.
    expect(platformBy(t(9, 0), 780, 8, 356)).toBe(t(8, 30));
  });

  it('never rounds toward later', () => {
    // 8:34:59 unrounded still gives 8:30, not 8:35.
    expect(platformBy(t(9, 0), 780, 8, 301)).toBe(t(8, 30));
  });

  it('treats an early-running p90 as no buffer, never as extra time', () => {
    expect(platformBy(t(9, 0), 600, 5, -40)).toBe(t(8, 45));
  });
});

describe('evaluation point for a ride', () => {
  it('picks the nearest of 90 / 270 / 540 / 960 seconds', () => {
    expect(bucketFor(60)).toBe('~1.5 min');
    expect(bucketFor(300)).toBe('~4.5 min');
    expect(bucketFor(600)).toBe('~9 min');
    expect(bucketFor(780)).toBe('~16 min'); // 13 min: 180s from 960, 240s from 540
    expect(bucketFor(2400)).toBe('~16 min');
  });
});

describe('stop resolution — exact aliases, no guessing', () => {
  it('resolves known names and common short forms', () => {
    expect(findStops('Northeastern')[0].stop.id).toBe('place-nuniv');
    expect(findStops('Park St.')[0].stop.id).toBe('place-pktrm');
    expect(findStops('mass ave station')[0].stop.id).toBe('place-masta');
  });

  it('returns nothing for a stop not in the data', () => {
    expect(findStops('Kenmore')).toEqual([]);
    expect(findStops('Harvard')).toEqual([]);
  });
});

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones visible rather than blank', () => {
    expect(fill('{share} by {platform_by} {nope}', { share: '62%', platform_by: '8:30am' })).toBe('62% by 8:30am {nope}');
  });

  it('fills placeholder names that contain digits', () => {
    // Shipped bug, caught on seeded data: {p90} was left unfilled in the answer.
    expect(fill('worst {tail} over {p90}', { tail: '10%', p90: '6.3 min' })).toBe('worst 10% over 6.3 min');
  });

  it('leaves no placeholder in the fixed template when every fact is supplied', () => {
    const facts = Object.fromEntries(__test.TEMPLATE.match(/\{([a-z0-9_]+)\}/g)!.map((p) => [p.slice(1, -1), 'x']));
    expect(fill(__test.TEMPLATE, facts)).not.toMatch(/[{}]/);
  });
});

// --- end to end, with a fake Gemini and a fake database ----------------------------
function fakeDb() {
  const grid = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, n: 100, n_within_60: 34 }));
  const daily = ['2026-09-21', '2026-09-22', '2026-09-23'].map((service_date) => ({
    service_date, n: 200, median_error_sec: 108, p90_error_sec: 356,
  }));
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: sql.includes('rollup_grid_totals') ? grid : daily }),
      }),
    }),
  } as unknown as D1Database;
}

function fakeGemini(phrasing: string) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const isParse = body.generationConfig?.responseMimeType === 'application/json';
    calls.push(isParse ? 'parse' : 'phrase');
    const text = isParse
      ? JSON.stringify({ status: 'ok', origin: 'Northeastern', destination: 'Park Street', route: '', day: 'weekday', arrive_by: '09:00' })
      : phrasing;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  });
  return calls;
}

const env = { GEMINI_API_KEY: 'test' } as Parameters<typeof ask>[0];
const NOW = Math.floor(Date.parse('2026-09-30T12:00:00Z') / 1000);

describe('ask — end to end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the model only to parse: one call, and the answer is the template filled from the database', async () => {
    const calls = fakeGemini('Leave at 8:05 — about 62% of trains are on time.');
    const r = await ask(env, fakeDb(), 'Northeastern to Park St by 9am on a weekday?', NOW);
    expect(calls).toEqual(['parse']); // no phrasing call at all
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.phrasing).toBe('template');
    expect(r.answer).not.toMatch(/8:05|62%/);
    // The real figures: 34% from the grid (170/500), the computed platform-by time.
    expect(r.answer).toContain('34% of predictions at Park Street land within a minute');
    expect(r.answer).toContain('be on the platform at Northeastern by 8:30am');
    expect(r.answer).not.toMatch(/[{}]/); // every placeholder filled
    expect(r.derivation).toMatchObject({ ride_sec: 780, p90_sec: 356, platform_by: '8:30am', evaluation_point: '~16 min' });
  });

  it('says so plainly for a stop not in the data', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'ok', origin: 'Kenmore', destination: 'Park Street', route: '', day: '', arrive_by: '09:00' }) }] } }] })));
    const r = await ask(env, fakeDb(), 'Kenmore to Park St by 9?', NOW);
    expect(r.status).toBe('unknown_stop');
    expect(r.answer).toMatch(/don’t have data for “Kenmore”/);
  });

  it('says so plainly for a question that is not a trip', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'unparseable', origin: '', destination: '', route: '', day: '', arrive_by: '' }) }] } }] })));
    expect((await ask(env, fakeDb(), 'what is the best pizza in Boston', NOW)).status).toBe('unparseable');
  });

  it('says so plainly for a combination the data cannot answer', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'ok', origin: 'Northeastern', destination: 'Ruggles', route: '', day: '', arrive_by: '09:00' }) }] } }] })));
    const r = await ask(env, fakeDb(), 'Northeastern to Ruggles by 9?', NOW);
    expect(r.status).toBe('unanswerable');
    expect(r.answer).toMatch(/no single route/);
  });

  it('refuses rather than guesses when the cell is too thin', async () => {
    fakeGemini('{share} {origin} {arrive_by} {platform_by}');
    const thin = {
      prepare: (sql: string) => ({ bind: () => ({ all: async () => ({ results: sql.includes('rollup_grid_totals') ? [{ weekday: 1, n: 7, n_within_60: 3 }] : [] }) }) }),
    } as unknown as D1Database;
    const r = await ask(env, thin, 'Northeastern to Park St by 9am on a weekday?', NOW);
    expect(r.status).toBe('not_enough_data');
    expect(r.answer).toMatch(/n=7/);
  });

  it('asks for an arrival time rather than inventing one', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'ok', origin: 'Northeastern', destination: 'Park Street', route: '', day: 'weekday', arrive_by: '' }) }] } }] })));
    expect((await ask(env, fakeDb(), 'Northeastern to Park St?', NOW)).status).toBe('need_time');
  });

  it('retries an overloaded model rather than failing the question', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      if (n === 1) return new Response('overloaded', { status: 503 }); // first parse attempt
      const isParse = n === 2;
      const text = isParse
        ? JSON.stringify({ status: 'ok', origin: 'Northeastern', destination: 'Park Street', route: '', day: 'weekday', arrive_by: '09:00' })
        : 'unused';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    });
    const r = await ask(env, fakeDb(), 'Northeastern to Park St by 9am on a weekday?', NOW);
    vi.useRealTimers();
    expect(r.status).toBe('ok');
    expect(n).toBe(2); // 503, then the retried parse; no phrasing call
  });

  it('does not retry a real error', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return new Response('bad request', { status: 400 });
    });
    const r = await ask(env, fakeDb(), 'Northeastern to Park St by 9am on a weekday?', NOW);
    expect(r.status).toBe('unavailable');
    expect(n).toBe(1);
  });


});
