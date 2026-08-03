/**
 * POST /api/telemetry — one error or one counter.
 *
 * Writes to the Worker log rather than to D1. The leaderboard database exists
 * to hold scores, and letting an unauthenticated public route append rows to
 * it is a way to fill it up; logs are already rate-limited by Cloudflare, cost
 * nothing to discard, and are where you look during an incident anyway.
 *
 * Everything here is untrusted, so the route decides what is recordable rather
 * than echoing what it was sent. An unrecognised metric name is dropped, not
 * logged - otherwise the endpoint is a free write channel into our own logs.
 */

const METRICS = new Set([
  "page_loaded",
  "run_started",
  "run_ended",
  "submit_attempted",
  "submit_succeeded",
  "submit_failed",
  "share_used",
  "restart_used",
  "return_visit",
]);

const ERROR_CATEGORIES = new Set([
  "uncaught",
  "unhandled_rejection",
  "boot_failed",
  "webgl_unsupported",
  "world_build_failed",
  "leaderboard_load_failed",
  "submit_failed",
  "share_failed",
]);

/** Anything that is not a short, plain identifier is not from our client. */
const SAFE_NAME = /^[a-z_]{1,40}$/;

export const onRequestPost: PagesFunction = async ({ request }) => {
  // Always 204: telemetry is fire-and-forget, and a client must never change
  // its behaviour based on whether reporting worked.
  const ok = new Response(null, { status: 204 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const kind = body.kind === "error" ? "error" : body.kind === "metric" ? "metric" : null;
    const name = typeof body.name === "string" ? body.name : "";
    if (!kind || !SAFE_NAME.test(name)) return ok;

    const build = typeof body.build === "string" && /^[a-z0-9]{1,20}$/.test(body.build)
      ? body.build
      : "unknown";
    const api = typeof body.api === "number" && Number.isInteger(body.api) ? body.api : 0;

    if (kind === "metric") {
      if (!METRICS.has(name)) return ok;
      console.log(JSON.stringify({ t: "metric", name, build, api }));
      return ok;
    }

    if (!ERROR_CATEGORIES.has(name)) return ok;
    /*
     * The message is capped and stripped of anything resembling a URL or a
     * long token. A crash message can quote whatever it was handling, and this
     * route must not become a way to write a player's data into our logs.
     */
    const detail = typeof body.detail === "string"
      ? body.detail.slice(0, 300).replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_-]{24,}/g, "[long]")
      : "";
    console.log(JSON.stringify({ t: "error", name, build, api, detail }));
    return ok;
  } catch {
    return ok;
  }
};
