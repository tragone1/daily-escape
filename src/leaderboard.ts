/**
 * Leaderboard client: identity, submission and reading the board.
 *
 * Identity is deliberately thin. A random id in localStorage plus a name you choose is
 * enough to own your scores across days without accounts, passwords or a sign-in provider.
 * Clearing site data loses the link, which is the honest cost of not having accounts, and
 * is worth saying out loud in the UI rather than hiding.
 */

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
export function nameIsValid(name: string): boolean {
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 2 && n.length <= 18 && /^[\p{L}\p{N} _.'-]+$/u.test(n);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
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
