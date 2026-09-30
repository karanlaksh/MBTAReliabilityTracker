import { revalidatePath } from 'next/cache';

/**
 * Rebuilds the page on a schedule, so that no visitor is the one who finds it old.
 *
 * Time-based ISR alone (`revalidate` on the page) is stale-while-revalidate: the
 * first request after the window expires is SERVED THE OLD PAGE and only triggers
 * the rebuild. On a page visited rarely, whoever arrives after a quiet spell sees
 * it as it was at the previous visit, however long ago that was. That is how a
 * cached Aug 20 render outlived September, and how Sept 29 stayed invisible after
 * the 04:00 ET rollup until a manual redeploy. Measured locally with a stub API:
 * first visit after expiry got the old data, the second got the new.
 *
 * revalidatePath purges the page and the fetches under it, and the first request
 * after a purge renders fresh (also measured). Called by the Vercel cron in
 * vercel.json once a day, after the rollup.
 *
 * WHY 10:00 UTC. The rollup runs at 04:00 America/New_York: 08:00 UTC in summer,
 * 09:00 UTC in winter. Vercel's Hobby crons fire at some point within the
 * scheduled hour, so 10:00-10:59 UTC is after the rollup in both — 06:xx EDT or
 * 05:xx EST. Any earlier hour could race the winter rollup.
 *
 * AUTHENTICATED because every rebuild reads the Worker's API, which reads D1: an
 * open endpoint would let anyone spend the database's read budget. Vercel's cron
 * sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set on the
 * project. If it is not set, this refuses every call and the page falls back to
 * time-based ISR — stale-prone, and visibly so via the data-age line.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }
  revalidatePath('/');
  return Response.json({ revalidated: '/', at: new Date().toISOString() });
}
