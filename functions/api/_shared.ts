/**
 * Shared bits for the leaderboard API.
 *
 * The day boundary has to be computed identically here and in the browser, or a score
 * submitted either side of midnight Eastern lands on the wrong board. Both sides ask Intl
 * for the date in the challenge timezone rather than doing arithmetic on UTC offsets,
 * which is also what keeps DST from mattering.
 */

export const DAY_ZONE = "America/New_York";

export interface Env {
  DB: D1Database;
}

export function dayKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The board is public data and is read by the game from the same origin; caching is
      // handled per-route because "today" and "last Tuesday" have very different lifetimes.
      "cache-control": "no-store",
    },
  });
}

export function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Player ids are generated in the browser, so their shape has to be checked here. */
export function validPlayerId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{16,32}$/.test(id);
}

/**
 * Trim a display name to something safe to render.
 *
 * Names go straight into the DOM on the leaderboard, so the allowed set is deliberately
 * narrow rather than escaped-on-output — there is no legitimate reason for a leaderboard
 * name to contain markup, and a whitelist cannot be got wrong the way escaping can.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 18) return null;
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) return null;
  return name;
}
