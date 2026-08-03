/**
 * What went wrong, and roughly what people did.
 *
 * Deliberately small. Without any of this a player reporting a black screen is
 * unactionable, and there is no way to know whether anyone opens a shared link
 * - but a game does not need to know who its players are to answer either
 * question.
 *
 * What is never sent: the player's name, their id, their score, the URL they
 * came from, or anything identifying. Errors carry a category, a message, the
 * build, and nothing else. Counters carry a name and nothing else.
 */

import { API_VERSION, BUILD_ID } from "./version";

/** Events worth counting. Anything not on this list is not collected. */
export type Metric =
  | "page_loaded"
  | "run_started"
  | "run_ended"
  | "submit_attempted"
  | "submit_succeeded"
  | "submit_failed"
  | "share_used"
  | "restart_used"
  | "return_visit";

interface Payload {
  kind: "error" | "metric";
  name: string;
  build: string;
  api: number;
  /** Only for errors, and only the message - never a stack from a user's machine. */
  detail?: string;
}

/**
 * Failures are reported at most a few times per page.
 *
 * A broken render loop can throw sixty times a second; without a cap the
 * reporting becomes the outage. The cap is per category so one noisy failure
 * cannot hide a different one.
 */
const MAX_PER_CATEGORY = 3;
const sent = new Map<string, number>();

function post(payload: Payload): void {
  const seen = sent.get(payload.name) ?? 0;
  if (seen >= MAX_PER_CATEGORY) return;
  sent.set(payload.name, seen + 1);

  try {
    const body = JSON.stringify(payload);
    /*
     * `sendBeacon` because the most valuable reports happen as the page is
     * going away - a failed load, a tab closed mid-submission - and a normal
     * fetch is cancelled at exactly that moment. Falls back to fetch with
     * keepalive where it is unavailable.
     */
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* Telemetry must never be the reason anything else fails. */
    });
  } catch {
    /* Nor may it throw. */
  }
}

/** A category of failure, with the message but never a stack. */
export function reportError(category: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  post({
    kind: "error",
    name: category,
    build: BUILD_ID,
    api: API_VERSION,
    // Truncated: a long message is a payload, not a diagnosis.
    detail: detail.slice(0, 300),
  });
}

export function count(metric: Metric): void {
  post({ kind: "metric", name: metric, build: BUILD_ID, api: API_VERSION });
}

/**
 * Catch what the game itself does not.
 *
 * The boot path in index.html already shows the player an error screen; this
 * is the half that tells us. Installed once, and never rethrows.
 */
export function installErrorReporting(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    reportError("uncaught", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError("unhandled_rejection", (e as PromiseRejectionEvent).reason);
  });
}
