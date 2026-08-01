// MBTA service dates roll over at ~03:00 America/New_York, not at midnight.
// A trip at 01:30 belongs to the previous service date.
//
// Getting this wrong does not throw. It silently splits late-night trips across
// two service dates, which breaks matching for exactly the trips where delays
// are worst. Hence its own module and its own tests.

const TZ = 'America/New_York';
const SERVICE_DAY_START_HOUR = 3;

// Constructed once. Intl.DateTimeFormat construction is the expensive part and
// this module is on the per-minute cron path.
const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  weekday: undefined,
  hourCycle: 'h23',
});

interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
}

function localParts(epochSec: number): LocalTime {
  const parts = nyParts.formatToParts(new Date(epochSec * 1000));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a ${type} part`);
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as hour 24 under h23. Normalise.
    hour: read('hour') % 24,
  };
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The MBTA service date ('YYYY-MM-DD') that a given instant belongs to.
 */
export function serviceDate(epochSec: number): string {
  const { year, month, day, hour } = localParts(epochSec);
  if (hour >= SERVICE_DAY_START_HOUR) return iso(year, month, day);

  // Roll back one calendar day. The local Y/M/D is a plain calendar date at this
  // point, so UTC arithmetic on it is exact and DST-safe — we are not shifting an
  // instant, we are decrementing a date.
  const prev = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return iso(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}

/**
 * Local wall-clock hour in Boston, 0-23. Used to schedule once-a-day maintenance
 * work inside the per-minute cron.
 */
export function localHour(epochSec: number): number {
  return localParts(epochSec).hour;
}
