/**
 * POST /api/score — submit a run.
 *
 * Keeps only a player's best score per day, so the board reads as a ranking of people
 * rather than a log of attempts.
 *
 * On tampering, plainly: this endpoint cannot tell a real run from a fabricated one. The
 * checks below reject scores that are *physically impossible* for the time claimed, cap how
 * often anyone can submit, and bound the numbers - which stops idle tampering and keeps a
 * bad request from corrupting the table. Someone determined can still post a plausible
 * lie. Closing that needs server-side replay of the input stream, which needs the
 * simulation to be deterministic, which it is not yet.
 */

import { bad, cleanName, dayKey, guarded, json, validPlayerId } from "./_shared";

/**
 * Fastest the game can physically bank score, per second.
 *
 * Top speed is 46 u/s and a section is roughly 550 units, so distance and the 500-per-
 * section bonus together come to about 88 points a second flat out. 130 leaves generous
 * headroom for boosted stretches and downhill runs while still being nowhere near what a
 * fabricated score looks like.
 */
const MAX_POINTS_PER_SECOND = 130;
/** Nobody scores anything meaningful in under this, and it guards divide-by-tiny. */
const MIN_RUN_MS = 3_000;
/** A run longer than this is not a run, it is a stuck tab. */
const MAX_RUN_MS = 90 * 60_000;
/** Submissions accepted per player per day. Generous; it is a spam bound, not a play limit. */
const MAX_SUBMISSIONS_PER_DAY = 400;

interface Body {
  playerId?: unknown;
  name?: unknown;
  score?: unknown;
  section?: unknown;
  distance?: unknown;
  elapsedMs?: unknown;
  day?: unknown;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export const onRequestPost = guarded(async ({ request, env }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("expected JSON");
  }

  const { playerId, score, section, distance, elapsedMs } = body;
  if (!validPlayerId(playerId)) return bad("bad playerId");

  const name = cleanName(body.name);
  if (!name) return bad("name must be 2-18 characters, letters and numbers");

  if (!isInt(score, 0, 10_000_000)) return bad("bad score");
  if (!isInt(section, 1, 500)) return bad("bad section");
  if (!isInt(distance, 0, 10_000_000)) return bad("bad distance");
  if (!isInt(elapsedMs, MIN_RUN_MS, MAX_RUN_MS)) return bad("bad elapsed");

  // The score the client claims has to be consistent with its own breakdown, and the
  // breakdown has to be reachable in the time claimed.
  const expected = distance + (section - 1) * 500;
  if (Math.abs(score - expected) > 500) return bad("score does not match its breakdown");
  if (score > (elapsedMs / 1000) * MAX_POINTS_PER_SECOND) return bad("score impossible for the time");

  /*
   * The day is decided here, never by the client.
   *
   * Trusting a submitted date would let anyone drop a score onto a day whose map they had
   * already studied, which is the one piece of tampering that would actually spoil the
   * board rather than just inflating one row.
   */
  const day = dayKey();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO players (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  )
    .bind(playerId, name, now, now)
    .run();

  const existing = await env.DB.prepare(
    `SELECT score, runs FROM scores WHERE day = ? AND player_id = ?`,
  )
    .bind(day, playerId)
    .first<{ score: number; runs: number }>();

  if (existing && existing.runs >= MAX_SUBMISSIONS_PER_DAY) {
    return bad("too many submissions today", 429);
  }

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO scores (day, player_id, score, section, distance, elapsed_ms, runs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(day, playerId, score, section, distance, elapsedMs, now, now)
      .run();
  } else if (score > existing.score) {
    await env.DB.prepare(
      `UPDATE scores SET score = ?, section = ?, distance = ?, elapsed_ms = ?,
              runs = runs + 1, updated_at = ? WHERE day = ? AND player_id = ?`,
    )
      .bind(score, section, distance, elapsedMs, now, day, playerId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE scores SET runs = runs + 1, updated_at = ? WHERE day = ? AND player_id = ?`,
    )
      .bind(now, day, playerId)
      .run();
  }

  const rank = await env.DB.prepare(
    `SELECT COUNT(*) + 1 AS rank FROM scores WHERE day = ? AND score > ?`,
  )
    .bind(day, Math.max(score, existing?.score ?? 0))
    .first<{ rank: number }>();

  return json({
    day,
    best: Math.max(score, existing?.score ?? 0),
    improved: !existing || score > existing.score,
    rank: rank?.rank ?? null,
  });
});
