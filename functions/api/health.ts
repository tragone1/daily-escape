/**
 * GET /api/health — is the leaderboard actually wired up on this deployment?
 *
 * Exists because the two ways this can be broken are invisible from the outside and look
 * identical: no D1 binding on this environment, or a binding whose database has never had
 * the migration applied. Both used to surface as Cloudflare's bare "error code: 1101".
 */

import { dayKey, json, type Env } from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const out: Record<string, unknown> = { day: dayKey() };

  if (!env?.DB) {
    out.binding = "missing";
    out.hint =
      "Pages configures bindings per environment. Bind D1 as DB for Preview as well as " +
      "Production, then redeploy that branch.";
    return json(out, 503);
  }
  out.binding = "ok";

  try {
    /*
     * Every table any migration creates, named individually.
     *
     * A count was not enough: this checked only `players` and `scores`, so a
     * database missing `rate_limits` reported migrated:true while the rate
     * limiter was silently disabled on every submission. The endpoint whose
     * whole job is 'is this deployment wired up' must not be able to say yes
     * when part of it is not - so it lists what it expects and reports what is
     * actually missing.
     */
    const expected = ["players", "scores", "rate_limits"];
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`,
    )
      .bind(...expected)
      .all<{ name: string }>();
    const present = new Set((rows.results ?? []).map((r) => r.name));
    const missing = expected.filter((t) => !present.has(t));
    out.tables = present.size;
    out.migrated = missing.length === 0;
    if (missing.length > 0) {
      out.missing = missing;
      out.hint = "Run: npm run db:remote";
    }
  } catch (err) {
    out.migrated = false;
    out.error = err instanceof Error ? err.message : String(err);
  }

  return json(out, out.migrated ? 200 : 503);
};
