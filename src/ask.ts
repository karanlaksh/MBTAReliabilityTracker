// The trip assistant: "should I leave earlier?" — answered from the rollup tables.
//
// THE MODEL NEVER PRODUCES A RELIABILITY NUMBER. It does two narrow jobs:
//   1. PARSE the question into a fixed JSON schema (stops, day, time). Its stop
//      names are not trusted: they are matched against STOPS in code.
//   2. PHRASE an answer, writing PLACEHOLDERS ({share}, {platform_by}, ...) rather
//      than numbers. Code fills them in. guardPhrasing() then rejects any phrasing
//      containing a digit, a number word, or an unknown placeholder, and the fixed
//      template is used instead. Enforcement, not instruction: a model that ignores
//      the prompt still cannot put a number on the screen.
// Every figure comes from the database; the platform-by time is arithmetic in
// platformBy(). See README "Trip assistant" for the derivation.

import type { Env } from './collector';
import { HEADWAY_MIN, RIDE_SEC } from './schedule';
import { serviceDate } from './service-date';

// --- stops the assistant knows ---------------------------------------------
// Travel order is DIRECTION 1 (Green-E inbound; Orange northbound); direction 0
// runs the other way. Route 39's two stops serve one direction each, so no trip
// between them exists in this data.
interface StopDef { id: string; name: string; aliases: string[] }
const LINES: Record<string, StopDef[]> = {
  'Green-E': [
    { id: 'place-nuniv', name: 'Northeastern', aliases: ['northeastern', 'northeastern university', 'neu'] },
    { id: 'place-symcl', name: 'Symphony', aliases: ['symphony'] },
    { id: 'place-prmnl', name: 'Prudential', aliases: ['prudential', 'pru'] },
    { id: 'place-coecl', name: 'Copley', aliases: ['copley', 'copley square'] },
    { id: 'place-pktrm', name: 'Park Street', aliases: ['park street', 'park st', 'park'] },
  ],
  Orange: [
    { id: 'place-forhl', name: 'Forest Hills', aliases: ['forest hills'] },
    { id: 'place-rugg', name: 'Ruggles', aliases: ['ruggles'] },
    { id: 'place-masta', name: 'Massachusetts Ave', aliases: ['massachusetts ave', 'massachusetts avenue', 'mass ave'] },
    { id: 'place-bbsta', name: 'Back Bay', aliases: ['back bay'] },
    { id: 'place-dwnxg', name: 'Downtown Crossing', aliases: ['downtown crossing', 'dtx'] },
  ],
};
const ROUTE_NAME: Record<string, string> = { 'Green-E': 'Green Line E', Orange: 'Orange Line', '39': 'Bus 39' };
/** A route the user named must contain one of these, or the trip is rejected. */
const ROUTE_WORDS: Record<string, string[]> = { 'Green-E': ['green', 'e line', 'e branch'], Orange: ['orange'] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/\bstation\b/g, '').replace(/\bstop\b/g, '').trim();

/** Every (route, stop) a name could mean. Exact alias match only — no guessing. */
export function findStops(name: string): { route: string; index: number; stop: StopDef }[] {
  const n = norm(name);
  const out: { route: string; index: number; stop: StopDef }[] = [];
  for (const [route, stops] of Object.entries(LINES)) {
    stops.forEach((stop, index) => {
      if (stop.aliases.includes(n)) out.push({ route, index, stop });
    });
  }
  return out;
}

// --- evaluation points ---------------------------------------------------------
const BUCKETS: { label: string; h: number }[] = [
  { label: '~1.5 min', h: 90 }, { label: '~4.5 min', h: 270 }, { label: '~9 min', h: 540 }, { label: '~16 min', h: 960 },
];
/** The evaluation point nearest the ride: how far ahead the arrival prediction you rely on is made. */
export function bucketFor(rideSec: number): string {
  return BUCKETS.reduce((best, b) => (Math.abs(b.h - rideSec) < Math.abs(best.h - rideSec) ? b : best)).label;
}

export type DayType = 'weekday' | 'saturday' | 'sunday';
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function dayTypeOf(weekday: number): DayType {
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
}

// --- the platform-by time ---------------------------------------------------------
/**
 * platform_by = arrive_by - ride - headway - p90 lateness, rounded DOWN to 5 min.
 *
 *   ride      scheduled in-vehicle time, origin -> destination (MBTA schedules)
 *   headway   scheduled gap between trains at that hour: room to miss one
 *   p90       90th-percentile lateness of the destination arrival prediction at the
 *             evaluation point nearest the ride — how late "the app says Park St
 *             in ~13 min" runs in the worst 10% of cases. Early (negative) counts 0.
 * Rounded down, never to nearest: a rounding error must make you earlier, not late.
 * Assumes the planned train's prediction starts out close to its schedule.
 */
export function platformBy(arriveBySec: number, rideSec: number, headwayMin: number, p90Sec: number): number {
  const latest = arriveBySec - rideSec - headwayMin * 60 - Math.max(0, p90Sec);
  return Math.floor(latest / 300) * 300;
}

// --- the guard ----------------------------------------------------------------------
export const PLACEHOLDERS = [
  'route', 'origin', 'destination', 'day', 'hour', 'share', 'n_hour', 'median', 'p90', 'n_day',
  'arrive_by', 'platform_by', 'headway', 'tail', 'tail_pct',
] as const;
const REQUIRED = ['share', 'platform_by', 'arrive_by', 'origin'];
const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|quarter|dozen|percent|percentage|once|twice|double|triple)\b/i;

/**
 * Accept the model's phrasing only if it cannot carry a number of its own.
 * Rejects: any digit; any number word; any {placeholder} not in PLACEHOLDERS;
 * any required placeholder missing; anything over 700 characters. On rejection
 * the caller uses the fixed template — the answer degrades in style, never in fact.
 */
export function guardPhrasing(text: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
  if (text.length > 700) return { ok: false, reason: 'too long' };
  // Placeholder NAMES are checked below against the allowed list; the prose around
  // them is what must carry no number. ({p90} is a legitimate name with digits.)
  const prose = text.replace(/\{[a-z0-9_]+\}/g, ' ');
  if (/[0-9]/.test(prose)) return { ok: false, reason: 'contains a digit' };
  const word = prose.match(NUMBER_WORDS);
  if (word) return { ok: false, reason: `contains a number word: "${word[0]}"` };
  const used = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const unknown = used.filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length) return { ok: false, reason: `unknown placeholder {${unknown[0]}}` };
  const missing = REQUIRED.filter((p) => !used.includes(p));
  if (missing.length) return { ok: false, reason: `missing {${missing[0]}}` };
  if (/[{}]/.test(prose)) return { ok: false, reason: 'stray brace' };
  return { ok: true };
}

export const TEMPLATE =
  '{route}, {origin} to {destination}, {day} around {hour}: {share} of predictions at {destination} land ' +
  'within a minute (n={n_hour}). All day on {day}s the median miss is {median} and the worst {tail} run ' +
  'more than {p90} late (n={n_day}). For a {arrive_by} arrival, be on the platform at {origin} by ' +
  '{platform_by} — that leaves room to miss a train ({headway}) and still covers the {tail_pct} case.';

export function fill(text: string, facts: Record<string, string>): string {
  return text.replace(/\{([a-z0-9_]+)\}/g, (_, k) => facts[k] ?? `{${k}}`);
}

// --- Gemini -----------------------------------------------------------------------
const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'unparseable'], description: 'unparseable if this is not a question about a trip between two stops' },
    origin: { type: 'string', description: 'starting stop as written, or empty' },
    destination: { type: 'string', description: 'destination stop as written, or empty' },
    route: { type: 'string', description: 'route if named (e.g. "Green Line E", "Orange Line"), or empty' },
    day: { type: 'string', enum: ['', 'weekday', ...WEEKDAY_NAMES], description: 'day of travel, resolved against today; empty if not stated' },
    arrive_by: { type: 'string', description: 'required arrival time as 24-hour HH:MM, or empty' },
  },
  required: ['status', 'origin', 'destination', 'route', 'day', 'arrive_by'],
};

/** Waits before the 2nd and 3rd attempt. Short: a rider is waiting on the answer. */
const RETRY_BACKOFF_MS = [700, 1800];

async function gemini(env: Env, system: string, user: string, json: boolean): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const model = env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
  const request = () => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: json
        ? { responseMimeType: 'application/json', responseJsonSchema: PARSE_SCHEMA, temperature: 0 }
        : { temperature: 0.4, maxOutputTokens: 300 },
    }),
  });
  // RETRY on overload and rate limiting only. Measured 2026-10-01 with this key:
  // gemini-3.8-flash returned 503 on 2 of 3 calls, flash-lite on 0 of 5. Any other
  // status is a real error and is not retried.
  let res = await request();
  for (const waitMs of RETRY_BACKOFF_MS) {
    if (![429, 500, 503].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await request();
  }
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') throw new Error('gemini: no text');
  return text;
}

// --- formatting -------------------------------------------------------------------
const signed = (s: number) => {
  const r = Math.round(s);
  if (Math.abs(r) < 120) return `${r >= 0 ? '+' : '−'}${Math.abs(r)}s`;
  return `${r >= 0 ? '+' : '−'}${(Math.abs(r) / 60).toFixed(1)} min`;
};
const late = (s: number) => (s < 120 ? `${Math.max(0, Math.round(s))}s` : `${(s / 60).toFixed(1)} min`);
const clock = (sec: number) => {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};
const hourName = (h: number) => (h === 0 ? '12am' : h === 12 ? 'noon' : h < 12 ? `${h}am` : `${h - 12}pm`);
const DAY_LABEL: Record<DayType, string> = { weekday: 'weekday', saturday: 'Saturday', sunday: 'Sunday' };

// --- the pipeline -----------------------------------------------------------------
export type AskResult =
  | { status: 'ok'; answer: string; phrasing: 'model' | 'template'; guard_reason?: string; facts: Record<string, string>; derivation: Record<string, number | string> }
  | { status: 'unparseable' | 'unknown_stop' | 'unanswerable' | 'not_enough_data' | 'need_time' | 'unavailable'; answer: string };

const MIN_N = 20;

export async function ask(env: Env, db: D1Database, question: string, nowSec: number): Promise<AskResult> {
  const q = question.trim().slice(0, 300);
  if (!q) return { status: 'unparseable', answer: 'Ask me about a trip, for example: "Northeastern to Park Street, arriving by 9am tomorrow."' };

  // 1. PARSE. Today's date goes in so "tomorrow" and "Tuesday" resolve; nothing else.
  const today = serviceDate(nowSec);
  const todayName = WEEKDAY_NAMES[new Date(`${today}T12:00:00Z`).getUTCDay()];
  let parsed: { status: string; origin: string; destination: string; route: string; day: string; arrive_by: string };
  try {
    parsed = JSON.parse(await gemini(env,
      `Extract the trip from a question about Boston's MBTA. Today is ${todayName}, ${today}. ` +
      'Return only what the user said; never invent a stop or a time. Do not answer the question.', q, true));
  } catch {
    return { status: 'unavailable', answer: 'The assistant could not read that question just now. Try again in a moment.' };
  }
  if (parsed.status !== 'ok') {
    return { status: 'unparseable', answer: 'I couldn’t tell which trip you mean. Try: "Northeastern to Park Street, arriving by 9am on a weekday."' };
  }
  if (!parsed.origin || !parsed.destination) {
    return { status: 'unparseable', answer: 'I need both where you’re starting and where you’re going.' };
  }

  // 2. RESOLVE in code: the model's stop names are matched, never trusted.
  const from = findStops(parsed.origin), to = findStops(parsed.destination);
  if (!from.length) return { status: 'unknown_stop', answer: `I don’t have data for “${parsed.origin}”. I cover the Green Line E from Northeastern to Park Street and the Orange Line from Forest Hills to Downtown Crossing.` };
  if (!to.length) return { status: 'unknown_stop', answer: `I don’t have data for “${parsed.destination}”. I cover the Green Line E from Northeastern to Park Street and the Orange Line from Forest Hills to Downtown Crossing.` };
  const pair = from.flatMap((f) => to.filter((t) => t.route === f.route && t.index !== f.index).map((t) => ({ f, t })))[0];
  if (!pair) return { status: 'unanswerable', answer: `There’s no single route in my data from ${from[0].stop.name} to ${to[0].stop.name}.` };
  const route = pair.f.route;
  if (parsed.route && !ROUTE_WORDS[route].some((w) => norm(parsed.route).includes(w))) {
    return { status: 'unanswerable', answer: `${from[0].stop.name} to ${to[0].stop.name} is on the ${ROUTE_NAME[route]}, not the ${parsed.route}.` };
  }
  const dir = pair.t.index > pair.f.index ? 1 : 0;
  const origin = pair.f.stop, dest = pair.t.stop;

  if (!/^\d{1,2}:\d{2}$/.test(parsed.arrive_by)) {
    return { status: 'need_time', answer: `When do you need to be at ${dest.name}? Tell me an arrival time and I’ll give you a time to be on the platform.` };
  }
  const [hh, mm] = parsed.arrive_by.split(':').map(Number);
  if (hh > 23 || mm > 59) return { status: 'need_time', answer: 'That arrival time doesn’t look right — try something like "by 9am".' };
  const arriveSec = hh * 3600 + mm * 60;

  // "weekday" pools Monday-Friday; a NAMED day uses that day's own figures, so a
  // question about Friday is answered about Fridays. Headways follow the
  // timetable's day type either way.
  const pooled = parsed.day === 'weekday';
  const dayIndex = pooled ? 1 : WEEKDAY_NAMES.indexOf(parsed.day || todayName);
  const dayType = dayTypeOf(dayIndex);
  const days = pooled ? [1, 2, 3, 4, 5] : [dayIndex];
  const dayLabel = pooled ? 'weekday' : WEEKDAY_NAMES[dayIndex][0].toUpperCase() + WEEKDAY_NAMES[dayIndex].slice(1);

  // 3. SCHEDULE: ride time and headway, from MBTA's published schedules.
  const rideSec = RIDE_SEC[`${route}|${dir}|${origin.id}|${dest.id}`];
  if (rideSec === undefined) return { status: 'unanswerable', answer: `I don’t have a scheduled ride time from ${origin.name} to ${dest.name}.` };
  const departHour = Math.floor(((arriveSec - rideSec + 86_400) % 86_400) / 3600);
  const hwTable = HEADWAY_MIN[`${route}|${dir}|${dayType}`];
  const headway = hwTable?.[departHour];
  if (headway === undefined) {
    return { status: 'unanswerable', answer: `The ${ROUTE_NAME[route]} has no scheduled service from ${origin.name} around ${hourName(departHour)} on ${DAY_LABEL[dayType]}s.` };
  }

  // 4. FIGURES, from the database. The grid gives the hour; by_day gives the day.
  const bucket = bucketFor(rideSec);
  const arrivalHour = Math.floor(((arriveSec - 60 + 86_400) % 86_400) / 3600);
  const grid = (await db.prepare(
    `SELECT weekday, n, n_within_60 FROM rollup_grid_totals
      WHERE stop_id = ? AND route_id = ? AND direction_id = ? AND hour = ? AND horizon_bucket = ? AND is_added = 0`,
  ).bind(dest.id, route, dir, arrivalHour, bucket).all<{ weekday: number; n: number; n_within_60: number }>()).results ?? [];
  const cells = grid.filter((c) => days.includes(c.weekday));
  const nHour = cells.reduce((t, c) => t + c.n, 0);
  const within = cells.reduce((t, c) => t + c.n_within_60, 0);
  if (nHour < MIN_N) {
    return { status: 'not_enough_data', answer: `Not enough data for ${dest.name} around ${hourName(arrivalHour)} on ${dayLabel}s (n=${nHour}, I need at least ${MIN_N}).` };
  }
  const daily = ((await db.prepare(
    `SELECT service_date, n, median_error_sec, p90_error_sec FROM rollup_error_by_day
      WHERE stop_id = ? AND route_id = ? AND direction_id = ? AND horizon_bucket = ? AND is_added = 0 AND is_partial = 0`,
  ).bind(dest.id, route, dir, bucket).all<{ service_date: string; n: number; median_error_sec: number; p90_error_sec: number }>()).results ?? [])
    .filter((r) => days.includes(new Date(`${r.service_date}T12:00:00Z`).getUTCDay()) && r.median_error_sec !== null);
  const nDay = daily.reduce((t, r) => t + r.n, 0);
  if (nDay < MIN_N) return { status: 'not_enough_data', answer: `Not enough data for ${dest.name} on ${dayLabel}s.` };
  // n-weighted mean of daily medians / p90s: medians do not compose across dates.
  const median = daily.reduce((t, r) => t + r.median_error_sec * r.n, 0) / nDay;
  const p90 = daily.reduce((t, r) => t + r.p90_error_sec * r.n, 0) / nDay;

  // 5. DECISION: arithmetic, not the model.
  const platform = platformBy(arriveSec, rideSec, headway, p90);

  const facts: Record<string, string> = {
    route: ROUTE_NAME[route], origin: origin.name, destination: dest.name, day: dayLabel,
    hour: hourName(arrivalHour), share: `${Math.round((100 * within) / nHour)}%`, n_hour: nHour.toLocaleString('en-US'),
    median: signed(median), p90: late(p90), n_day: nDay.toLocaleString('en-US'),
    arrive_by: clock(arriveSec), platform_by: clock(platform), headway: `${headway} min`,
    tail: '10%', tail_pct: '90th-percentile',
  };
  const derivation = {
    arrive_by: clock(arriveSec), ride_sec: rideSec, headway_min: headway, p90_sec: Math.round(p90),
    unrounded: clock(arriveSec - rideSec - headway * 60 - Math.max(0, p90)), platform_by: clock(platform),
    evaluation_point: bucket, arrival_hour: arrivalHour, day_type: dayType,
  };

  // 6. PHRASE (optional), then GUARD. Any failure falls back to the template.
  let phrasing: 'model' | 'template' = 'template';
  let answerText = TEMPLATE;
  let guardReason: string | undefined;
  try {
    const draft = await gemini(env,
      'Rewrite this answer for a rider in plain, friendly English, at most three sentences. ' +
      'Keep every {placeholder} exactly as written; never write any number, digit, time or quantity yourself — ' +
      'only placeholders carry figures. Keep {share}, {origin}, {arrive_by} and {platform_by}. Output only the answer.',
      TEMPLATE, false);
    const g = guardPhrasing(draft.trim());
    if (g.ok) { answerText = draft.trim(); phrasing = 'model'; } else guardReason = g.reason;
  } catch (err) {
    guardReason = err instanceof Error ? err.message : String(err);
  }
  return { status: 'ok', answer: fill(answerText, facts), phrasing, guard_reason: guardReason, facts, derivation };
}

export const __test = { norm, findStops, bucketFor, dayTypeOf, platformBy, guardPhrasing, fill, TEMPLATE };
