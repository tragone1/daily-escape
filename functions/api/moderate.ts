/**
 * POST /api/moderate — remove or rename one leaderboard entry.
 *
 * A word list will not win against a determined player, and it is not supposed
 * to. This is the other half of that design: when something gets through, a
 * human needs a way to take it down in seconds without a database console.
 *
 * Authenticated with a shared secret held as a Cloudflare Pages secret, never
 * in the repo and never sent to a browser. If the secret is not configured the
 * route refuses everything rather than defaulting to open - an unset variable
 * must never be the same thing as an unlocked door.
 */

import { bad, dayKey, guarded, json } from "./_shared";

interface ModEnv {
  DB: D1Database;
  MODERATION_SECRET?: string;
}

interface Body {
  action?: unknown;
  day?: unknown;
  playerId?: unknown;
  name?: unknown;
}

/**
 * Compared in constant time, genuinely.
 *
 * The obvious version returns early when the lengths differ, which leaks the
 * secret's length - so it is not constant time at all, whatever the comment
 * above it says. Hashing both sides first gives two fixed-length digests, and
 * the comparison below then takes the same time for every input including a
 * wrong length.
 */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const digest = async (v: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const onRequestPost = guarded(async ({ request, env }) => {
  const secret = (env as unknown as ModEnv).MODERATION_SECRET;
  if (!secret) {
    return json({ error: "Moderation is not configured on this deployment." }, 503);
  }

  const offered = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!offered || !(await secretMatches(offered, secret))) {
    // Deliberately identical to the response for a well-formed but wrong key:
    // distinguishing them tells a prober which half they got right.
    return json({ error: "Not authorised." }, 401);
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("expected JSON");
  }

  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
    ? body.day
    : dayKey();
  if (typeof body.playerId !== "string" || !body.playerId) return bad("playerId required");

  /*
   * Two actions, both narrow on purpose. "remove" drops one score row and
   * leaves the player record, so the same person can play again with a
   * different name rather than being silently unable to score. "rename"
   * replaces the display name, which is the gentler answer when the run
   * itself was legitimate and only the name was not.
   */
  if (body.action === "remove") {
    const res = await env.DB.prepare(`DELETE FROM scores WHERE day = ? AND player_id = ?`)
      .bind(day, body.playerId)
      .run();
    return json({ ok: true, action: "remove", day, removed: res.meta?.changes ?? 0 });
  }

  if (body.action === "rename") {
    const replacement = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Player";
    if (replacement.length > 18) return bad("replacement name too long");
    const res = await env.DB.prepare(`UPDATE players SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(replacement, Date.now(), body.playerId)
      .run();
    return json({ ok: true, action: "rename", name: replacement, changed: res.meta?.changes ?? 0 });
  }

  return bad("action must be 'remove' or 'rename'");
});
