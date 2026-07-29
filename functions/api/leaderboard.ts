/**
 * GET /api/leaderboard?day=YYYY-MM-DD&playerId=…
 *
 * One day's board, plus the caller's own row even when it falls outside the top slice —
 * being 47th is information, and a board that only shows the top ten tells most players
 * nothing about themselves.
 *
 * `days` instead returns a summary per day, for the recent-days picker.
 */

import { bad, dayKey, json, validPlayerId, type Env } from "./_shared";

const TOP = 25;
const HISTORY_DAYS = 14;

const isDay = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const today = dayKey();

  if (mode === "days") {
    // Summary for the day picker: how many played and what it took to win.
    const rows = await env.DB.prepare(
      `SELECT day, COUNT(*) AS players, MAX(score) AS best
         FROM scores GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
      .bind(HISTORY_DAYS)
      .all<{ day: string; players: number; best: number }>();
    return json({ today, days: rows.results ?? [] });
  }

  const dayParam = url.searchParams.get("day");
  const day = isDay(dayParam) ? dayParam : today;
  // Never serve a board for a day that has not happened; the map would be unplayed and the
  // empty result reads as a bug rather than as the future.
  if (day > today) return bad("that day has not started yet");

  const top = await env.DB.prepare(
    `SELECT s.player_id, p.name, s.score, s.section, s.distance, s.elapsed_ms
       FROM scores s JOIN players p ON p.id = s.player_id
      WHERE s.day = ? ORDER BY s.score DESC, s.updated_at ASC LIMIT ?`,
  )
    .bind(day, TOP)
    .all<{
      player_id: string;
      name: string;
      score: number;
      section: number;
      distance: number;
      elapsed_ms: number;
    }>();

  const entries = (top.results ?? []).map((r, i) => ({
    rank: i + 1,
    playerId: r.player_id,
    name: r.name,
    score: r.score,
    section: r.section,
    distance: r.distance,
    elapsedMs: r.elapsed_ms,
  }));

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scores WHERE day = ?`)
    .bind(day)
    .first<{ n: number }>();

  // The caller's own standing, if they are not already in the slice above.
  let you = null;
  const playerId = url.searchParams.get("playerId");
  if (validPlayerId(playerId) && !entries.some((e) => e.playerId === playerId)) {
    const mine = await env.DB.prepare(
      `SELECT s.score, s.section, s.distance, s.elapsed_ms, p.name
         FROM scores s JOIN players p ON p.id = s.player_id
        WHERE s.day = ? AND s.player_id = ?`,
    )
      .bind(day, playerId)
      .first<{ score: number; section: number; distance: number; elapsed_ms: number; name: string }>();
    if (mine) {
      const rank = await env.DB.prepare(
        `SELECT COUNT(*) + 1 AS rank FROM scores WHERE day = ? AND score > ?`,
      )
        .bind(day, mine.score)
        .first<{ rank: number }>();
      you = {
        rank: rank?.rank ?? null,
        playerId,
        name: mine.name,
        score: mine.score,
        section: mine.section,
        distance: mine.distance,
        elapsedMs: mine.elapsed_ms,
      };
    }
  }

  return json({ day, today, players: total?.n ?? 0, entries, you });
};
