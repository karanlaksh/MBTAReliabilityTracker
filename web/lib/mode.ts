// DEMO ONLY — the single switch for the recorded demo.
//
// DEMO_MODE=true (set on a Vercel PREVIEW deployment, never on production) does
// two things and nothing else:
//   1. Reads the seeded mbta-demo database, via the Worker's /demo/api/* routes.
//   2. Hides the content that describes the REAL dataset's history: the
//      degraded-data note and data-age line, the degraded banner, the September
//      break on the day-by-day chart, and the limitations section.
// That content is gated here, not deleted. Unset DEMO_MODE and the page is
// exactly what it was. Server-side only: read in app/page.tsx and passed down.

import { DEGRADED_WINDOW, PRIMARY_WINDOW } from './api';

export const DEMO_MODE = process.env.DEMO_MODE === 'true';

/** Prefix for every Worker API path. */
export const API_PREFIX = DEMO_MODE ? '/demo' : '';

/** The seeded range: three continuous months. */
const DEMO_WINDOW = { from: '2026-07-01', to: '2026-09-30', label: 'Jul 1 – Sep 30, 2026' } as const;

/** Window the headline finding and mode comparison are graded over. */
export const HEADLINE_WINDOW = DEMO_MODE ? DEMO_WINDOW : PRIMARY_WINDOW;

/** Window drawn as a break on the day-by-day chart; none in demo mode. */
export const BREAK_WINDOW = DEMO_MODE ? null : DEGRADED_WINDOW;
