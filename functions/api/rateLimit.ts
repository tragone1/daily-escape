/**
 * Per-address submission limiting.
 *
 * The existing cap is keyed on `playerId`, which the browser generates and can
 * therefore rotate at will: it stops a player spamming by accident, not a
 * script spamming on purpose. This is keyed on something the caller does not
 * choose.
 *
 * The address is never stored. The key is a SHA-256 of the address plus the
 * day, so a row cannot be turned back into an IP and the same address produces
 * a different key tomorrow — a rate limiter should not quietly become a log of
 * who played and when.
 *
 * Held in D1 because a Worker isolate is not a place to keep state: requests
 * from one address land on different isolates, and an in-memory counter would
 * be both wrong and trivially defeated.
 */

/**
 * Limits chosen for a shared network, not a single player.
 *
 * A run takes minutes, so a human submits a handful of times an hour. A
 * household, a school or an office behind one NAT address might have several
 * people playing at once - hence a ceiling well above any individual's
 * behaviour but far below what a script wants. Someone genuinely blocked by
 * this is submitting once every twelve seconds for ten minutes.
 */
export const WINDOW_MS = 10 * 60_000;
export const MAX_PER_WINDOW = 50;

export interface LimitVerdict {
  allowed: boolean;
  /** Seconds until the window resets. Sent to the caller so a retry is informed. */
  retryAfter: number;
}

/**
 * The caller's address, as Cloudflare reports it.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client -
 * unlike `X-Forwarded-For`, which is an ordinary request header anyone can
 * write. Trusting the wrong one is how a rate limiter becomes decorative.
 */
export function callerAddress(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP");
}

async function bucketKey(address: string, day: string, windowStart: number): Promise<string> {
  const data = new TextEncoder().encode(`${address}|${day}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hash}:${windowStart}`;
}

/**
 * Count one attempt and say whether it is allowed.
 *
 * Counts the ATTEMPT, not the success: a flood of malformed submissions costs
 * the same to serve as valid ones, so rejecting them for free would leave the
 * cheapest attack uncounted.
 */
export async function checkRateLimit(
  db: D1Database,
  request: Request,
  day: string,
  now = Date.now(),
): Promise<LimitVerdict> {
  const address = callerAddress(request);
  // No address means this is not running behind the Cloudflare edge - local
  // development, or a test. Nothing to key on, so nothing to limit.
  if (!address) return { allowed: true, retryAfter: 0 };

  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = await bucketKey(address, day, windowStart);
  const expiresAt = windowStart + WINDOW_MS;

  /*
   * One statement, so two requests arriving together cannot both read the old
   * count and both decide they are the first. SQLite applies the upsert
   * atomically; doing this as a SELECT then an UPDATE is the classic way to
   * make a limiter that lets a burst straight through.
   */
  let row: { hits: number } | null = null;
  try {
    row = await db
      .prepare(
        `INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?)
           ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1
         RETURNING hits`,
      )
      .bind(key, expiresAt)
      .first<{ hits: number }>();
  } catch (err) {
    /*
     * FAIL OPEN, deliberately.
     *
     * The table this writes to comes from migration 0002. If a deployment goes
     * out before that migration is applied - which is exactly the kind of
     * ordering mistake a launch produces - every write here throws, and a
     * limiter that propagates its own failure would take down the score
     * submission it exists to protect. Spam is a nuisance; a leaderboard that
     * rejects every legitimate score is an outage.
     *
     * Logged so the gap is visible rather than silent.
     */
    console.log(
      JSON.stringify({
        t: "error",
        name: "rate_limit_unavailable",
        detail: err instanceof Error ? err.message.slice(0, 120) : "unknown",
      }),
    );
    return { allowed: true, retryAfter: 0 };
  }

  const hits = row?.hits ?? 1;
  if (hits > MAX_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.ceil((expiresAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

/**
 * Drop expired rows now and then.
 *
 * Opportunistic rather than scheduled: this table would otherwise grow forever
 * and Pages Functions have no cron. One in fifty requests pays for the sweep,
 * which is often enough to keep the table small and rare enough not to matter.
 */
export async function sweepExpired(db: D1Database, now = Date.now()): Promise<void> {
  if (Math.random() > 0.02) return;
  try {
    await db.prepare(`DELETE FROM rate_limits WHERE expires_at < ?`).bind(now).run();
  } catch {
    /* Housekeeping must never fail a submission. */
  }
}
