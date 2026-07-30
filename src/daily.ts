/**
 * The daily challenge: which map everyone is driving today.
 *
 * One shared boundary worldwide — midnight US Eastern — so the leaderboard is never
 * ambiguous. Two people are never on "today" with different maps, which is the failure
 * mode of rolling over in each player's own timezone.
 *
 * Eastern rather than UTC because that is the author's midnight; the only thing that
 * matters technically is that it is *one* boundary, and DST is handled by asking Intl for
 * the date in that zone rather than by arithmetic on offsets.
 */

/** The timezone whose midnight rolls the challenge over. */
export const DAY_ZONE = "America/New_York";

/** Day 1. Everything counts forward from here. */
const EPOCH_KEY = "2026-07-29";

/**
 * Today's key as `YYYY-MM-DD` in the challenge timezone.
 *
 * `en-CA` because its short date format *is* ISO order, which avoids assembling the string
 * from parts and getting the padding wrong.
 */
export function dayKey(at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: DAY_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    // A build without timezone data would otherwise throw here - and this is called at
    // module load to pick the map, so it would take the whole game down rather than
    // degrade. The US rules below agree with Intl for every date the game will see.
    return easternKeyFallback(at);
  }
}

/**
 * US Eastern date without Intl, using the DST rules in force since 2007: forward on the
 * second Sunday in March, back on the first Sunday in November, both at 02:00 local.
 */
function easternKeyFallback(at: Date): string {
  const year = at.getUTCFullYear();
  const nthSundayUtc = (month: number, nth: number): number => {
    // 07:00 UTC is 02:00 EST; close enough for a boundary that is hours wide.
    const first = Date.UTC(year, month, 1, 7);
    const dow = new Date(first).getUTCDay();
    const day = 1 + ((7 - dow) % 7) + (nth - 1) * 7;
    return Date.UTC(year, month, day, 7);
  };
  const t = at.getTime();
  const dst = t >= nthSundayUtc(2, 2) && t < nthSundayUtc(10, 1);
  const shifted = new Date(t - (dst ? 4 : 5) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Whole days between two `YYYY-MM-DD` keys. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Human-facing challenge number: day 1, day 2, ... */
export function dayNumber(key: string = dayKey()): number {
  return daysBetween(EPOCH_KEY, key) + 1;
}

/**
 * Course seed for a given day.
 *
 * Derived from the date rather than stored, so the map for any past or future day can be
 * reproduced offline — useful for testing, and it means the server never has to be
 * consulted to know what course you are on.
 *
 * The multiply-and-mix keeps consecutive days far apart in seed space; feeding mulberry32
 * 20260729 and 20260730 back to back produces courses that open almost identically.
 */
export function seedForDay(key: string = dayKey()): number {
  const compact = Number(key.replace(/-/g, ""));
  let h = compact ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** e.g. "Wednesday 29 July 2026", for the intro card. */
export function dayLabel(key: string = dayKey()): string {
  const d = new Date(`${key}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return key;
  }
}

/** Milliseconds until the next rollover, for the countdown. */
export function msUntilRollover(at: Date = new Date()): number {
  const today = dayKey(at);
  // Step forward in hours until the key changes; cheap, and immune to DST arithmetic.
  for (let h = 1; h <= 48; h++) {
    const probe = new Date(at.getTime() + h * 3_600_000);
    if (dayKey(probe) !== today) {
      // Narrow to the minute.
      for (let m = 1; m <= 60; m++) {
        const fine = new Date(at.getTime() + (h - 1) * 3_600_000 + m * 60_000);
        if (dayKey(fine) !== today) return fine.getTime() - at.getTime();
      }
      return probe.getTime() - at.getTime();
    }
  }
  return 0;
}
