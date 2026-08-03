/**
 * Leaderboard client: identity, submission and reading the board.
 *
 * Identity is deliberately thin. A random id in localStorage plus a name you choose is
 * enough to own your scores across days without accounts, passwords or a sign-in provider.
 * Clearing site data loses the link, which is the honest cost of not having accounts, and
 * is worth saying out loud in the UI rather than hiding.
 */

import { letterNumberPattern } from "./compat";
import { dayKey } from "./daily";

const ID_KEY = "dailyEscape.playerId";
const NAME_KEY = "dailyEscape.playerName";

export interface Entry {
  rank: number;
  playerId: string;
  name: string;
  score: number;
  section: number;
  distance: number;
  elapsedMs: number;
}

export interface Board {
  day: string;
  today: string;
  players: number;
  entries: Entry[];
  you: Entry | null;
}

export interface DaySummary {
  day: string;
  players: number;
  best: number;
}

export interface SubmitResult {
  day: string;
  best: number;
  improved: boolean;
  rank: number | null;
}

/** localStorage refuses to work in some embedded frames; none of this is worth a crash. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Stable per-browser id, created on first use. Matches the server's `[a-z0-9]{16,32}`. */
export function playerId(): string {
  const existing = read(ID_KEY);
  if (existing && /^[a-z0-9]{16,32}$/.test(existing)) return existing;

  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
  write(ID_KEY, id);
  return id;
}

export function playerName(): string | null {
  return read(NAME_KEY);
}

export function setPlayerName(name: string): void {
  write(NAME_KEY, name.trim());
}

/** Same rule as the server, so the UI can reject before a round trip. */
const NAME_PATTERN = letterNumberPattern();

export function nameIsValid(name: string): boolean {
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 2 && n.length <= 18 && NAME_PATTERN.test(n);
}

/**
 * Longest a request may hang before it is treated as failed.
 *
 * `fetch` has no timeout of its own: a request to a server that accepts the
 * connection and then never answers stays pending until the tab is closed. To
 * a player that is a SUBMIT button that says "Sending..." forever, which reads
 * as the game being broken rather than the network being slow. Ten seconds is
 * well past a healthy round trip and well short of anyone's patience.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** A failure a retry might fix, as opposed to one the server has ruled on. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: abort.signal });
  } catch (err) {
    // Offline, DNS failure, connection refused, or our own timeout - all of
    // them are worth retrying, unlike a considered rejection from the server.
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new NetworkError(
      timedOut ? "The server took too long to answer." : "Could not reach the leaderboard.",
    );
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    // 5xx and 429 are worth another go; 4xx is a verdict.
    const retryable = res.status >= 500 || res.status === 429;
    const message = body.error ?? `request failed (${res.status})`;
    throw retryable ? new NetworkError(message) : new Error(message);
  }
  return body;
}

export async function submitScore(run: {
  score: number;
  section: number;
  distance: number;
  elapsedMs: number;
}): Promise<SubmitResult> {
  const name = playerName();
  if (!name) throw new Error("no name set");
  return call<SubmitResult>("/api/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: playerId(), name, ...run }),
  });
}

export async function fetchBoard(day?: string): Promise<Board> {
  const params = new URLSearchParams({ playerId: playerId() });
  if (day) params.set("day", day);
  return call<Board>(`/api/leaderboard?${params}`);
}

export async function fetchDays(): Promise<{ today: string; days: DaySummary[] }> {
  return call<{ today: string; days: DaySummary[] }>("/api/leaderboard?mode=days");
}

/** Today, per the challenge timezone, computed client-side for display only. */
export function today(): string {
  return dayKey();
}

/**
 * A finished run that could not be sent.
 *
 * Kept so a dropped connection at the end of a good run does not simply lose
 * it: the score is held locally and offered back the next time the game
 * loads. Only one is kept - the best - because a queue of pending runs would
 * be a way to bank attempts and submit them later, and the server only keeps
 * a player's best for the day anyway.
 *
 * The DAY is stored with it and checked on the way out. A run held overnight
 * belongs to a map nobody is playing any more, and submitting it against
 * today's board would be wrong.
 */
export interface PendingRun {
  score: number;
  section: number;
  distance: number;
  elapsedMs: number;
  day: string;
}

const PENDING_KEY = "dailyEscape.pendingRun";

export function savePending(run: Omit<PendingRun, "day">, day: string): void {
  const existing = loadPending(day);
  if (existing && existing.score >= run.score) return;
  write(PENDING_KEY, JSON.stringify({ ...run, day }));
}

export function loadPending(today: string): PendingRun | null {
  const raw = read(PENDING_KEY);
  if (!raw) return null;
  try {
    const run = JSON.parse(raw) as PendingRun;
    if (run.day !== today) {
      // Yesterday's map. Nothing to submit it to.
      clearPending();
      return null;
    }
    if (![run.score, run.section, run.distance, run.elapsedMs].every(Number.isFinite)) {
      clearPending();
      return null;
    }
    return run;
  } catch {
    // Corrupted or truncated storage: drop it rather than trip over it forever.
    clearPending();
    return null;
  }
}

export function clearPending(): void {
  write(PENDING_KEY, "");
}
