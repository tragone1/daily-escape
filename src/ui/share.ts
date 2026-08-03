/**
 * Sharing a run.
 *
 * The whole reason this game is hosted rather than played locally is that the
 * map is the same for everyone today, which makes a score a claim someone can
 * answer. So the share is built around the claim: a number, the day it was set,
 * and a link that drops the reader onto the same map.
 *
 * Two paths, because they are genuinely different. On a phone the native share
 * sheet is what people already use to send things to a friend, and it hands off
 * to their messages app in one tap. On a desktop there is no sheet worth using,
 * so the link goes to the clipboard and the button says so.
 */

import { dayKey, dayNumber } from "../daily";

export interface ShareRun {
  score: number;
  section: number;
  distance: number;
}

/** The link a friend opens: today's map, with the score to beat carried on it. */
export function shareUrl(run: ShareRun, name?: string): string {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("d", String(dayNumber(dayKey())));
  url.searchParams.set("s", String(Math.round(run.score)));
  url.searchParams.set("sec", String(run.section));
  const who = (name ?? "").trim();
  if (who) url.searchParams.set("n", who.slice(0, 18));
  return url.toString();
}

/**
 * The message itself.
 *
 * Written to be readable as a text, not as a scoreboard dump: what the game is,
 * what they did, and the one fact that makes it a challenge rather than a brag -
 * that the reader gets the identical map.
 */
export function shareText(run: ShareRun): string {
  const day = dayNumber(dayKey());
  return (
    `Daily Escape - day ${day}\n` +
    `I got ${run.score.toLocaleString()}, busted on section ${run.section}.\n` +
    `Same map for everyone today. Beat it:`
  );
}

type ShareOutcome = "shared" | "copied" | "failed";

/**
 * Hand the run to whatever this device shares with.
 *
 * `navigator.share` rejects when the user simply dismisses the sheet, which is
 * not a failure and must not fall through to copying a link they did not ask
 * for - `AbortError` is the signal for that and is swallowed.
 */
export async function shareRun(run: ShareRun, name?: string): Promise<ShareOutcome> {
  const url = shareUrl(run, name);
  const text = shareText(run);
  const nav = navigator as Navigator & {
    share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  };

  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: "Daily Escape", text, url });
      return "shared";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "shared";
      // Anything else - a browser that advertises share but refuses this
      // payload - falls through to the clipboard rather than dead-ending.
    }
  }

  const payload = `${text}\n${url}`;
  try {
    await navigator.clipboard.writeText(payload);
    return "copied";
  } catch {
    // Clipboard access can be refused outright. A selectable textarea is the
    // last resort that still lets someone copy by hand.
    try {
      const box = document.createElement("textarea");
      box.value = payload;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(box);
      return ok ? "copied" : "failed";
    } catch {
      return "failed";
    }
  }
}

/** A score someone was sent, read off the link they opened. */
export interface Challenge {
  score: number;
  section: number;
  day: number;
  name: string | null;
  /** False when the link is from an earlier day, so the map has since rolled. */
  isToday: boolean;
}

export function challengeFromUrl(): Challenge | null {
  const q = new URLSearchParams(window.location.search);
  const score = Number(q.get("s"));
  if (!Number.isFinite(score) || score <= 0) return null;
  const day = Number(q.get("d"));
  const section = Number(q.get("sec"));
  const name = q.get("n");
  return {
    score: Math.round(score),
    section: Number.isFinite(section) && section > 0 ? Math.round(section) : 0,
    day: Number.isFinite(day) ? day : 0,
    name: name && name.trim() ? name.trim().slice(0, 18) : null,
    isToday: Number.isFinite(day) && day === dayNumber(dayKey()),
  };
}
