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
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('players','scores')`,
    ).first<{ n: number }>();
    out.tables = row?.n ?? 0;
    out.migrated = (row?.n ?? 0) === 2;
    if (!out.migrated) out.hint = "Run: npm run db:remote";
  } catch (err) {
    out.migrated = false;
    out.error = err instanceof Error ? err.message : String(err);
  }

  return json(out, out.migrated ? 200 : 503);
};
