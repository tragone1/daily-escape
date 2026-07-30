/**
 * The daily-challenge chrome: day banner, score submission and the leaderboard overlay.
 *
 * Kept out of `Hud`, which is the in-run readout and runs every frame. Everything here is
 * event-driven and talks to the network, so mixing the two would put a fetch in the render
 * path and a frame budget on a dialog.
 */

import { dayKey, dayLabel, dayNumber, msUntilRollover } from "../daily";
import {
  fetchBoard,
  fetchDays,
  nameIsValid,
  playerId,
  playerName,
  setPlayerName,
  submitScore,
  type Board,
} from "../leaderboard";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
};

export interface RunSummary {
  score: number;
  section: number;
  distance: number;
  elapsedMs: number;
}

export class DailyUi {
  private nameInput = el<HTMLInputElement>("nameInput");
  private submitBtn = el<HTMLButtonElement>("submitScore");
  private submitNote = el("submitNote");
  private overlay = el("boardOverlay");
  private list = el("boardList");
  private meta = el("boardMeta");
  private you = el("boardYou");
  private daySelect = el<HTMLSelectElement>("boardDay");

  /** The run currently showing on the result card, if any. */
  private pending: RunSummary | null = null;
  private submittedFor: RunSummary | null = null;

  constructor() {
    this.paintDayBanner();
    // The banner is the only place a player learns the map has changed under them, so it
    // keeps ticking rather than being painted once.
    setInterval(() => this.paintDayBanner(), 30_000);

    const saved = playerName();
    if (saved) this.nameInput.value = saved;

    this.submitBtn.addEventListener("click", () => void this.submit());
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.submit();
    });

    el("startBoard").addEventListener("click", () => void this.openBoard());
    el("resultBoard").addEventListener("click", () => void this.openBoard());
    el("boardClose").addEventListener("click", () => this.closeBoard());
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.closeBoard();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.overlay.hidden) this.closeBoard();
    });
    this.daySelect.addEventListener("change", () => void this.loadBoard(this.daySelect.value));
  }

  /** True while the board is up, so the game can ignore keys meant for the dialog. */
  get boardOpen(): boolean {
    return !this.overlay.hidden;
  }

  private paintDayBanner(): void {
    const key = dayKey();
    el("dayNumber").textContent = `DAY ${dayNumber(key)}`;
    el("dayDate").textContent = dayLabel(key);

    const ms = msUntilRollover();
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    el("dayCountdown").textContent = `new map in ${hours}h ${mins}m`;
  }

  /** Called when a run ends. Resets the submit row for the new score. */
  showResult(run: RunSummary): void {
    this.pending = run;
    this.submittedFor = null;
    this.submitBtn.disabled = false;
    this.submitBtn.textContent = "SUBMIT SCORE";
    this.note("", "");
  }

  private note(text: string, kind: "" | "good" | "bad"): void {
    this.submitNote.textContent = text;
    this.submitNote.className = kind;
  }

  private async submit(): Promise<void> {
    const run = this.pending;
    if (!run) return;
    if (this.submittedFor === run) return;

    const name = this.nameInput.value.trim();
    if (!nameIsValid(name)) {
      this.note("Name needs 2-18 letters or numbers.", "bad");
      this.nameInput.focus();
      return;
    }
    setPlayerName(name);

    this.submitBtn.disabled = true;
    this.note("Sending...", "");
    try {
      const res = await submitScore(run);
      this.submittedFor = run;
      this.submitBtn.textContent = "SUBMITTED";
      this.note(
        res.improved
          ? `Best of the day so far - ${res.best.toLocaleString()}, rank ${res.rank ?? "?"}.`
          : `Kept your better score of ${res.best.toLocaleString()} (rank ${res.rank ?? "?"}).`,
        "good",
      );
    } catch (err) {
      this.submitBtn.disabled = false;
      // Offline, or the API is not deployed yet. Either way the run still happened.
      this.note(err instanceof Error ? err.message : "Could not reach the leaderboard.", "bad");
    }
  }

  private async openBoard(): Promise<void> {
    this.overlay.hidden = false;
    this.meta.textContent = "Loading...";
    this.list.replaceChildren();
    this.you.textContent = "";

    try {
      const { today, days } = await fetchDays();
      // Always offer today, even before anyone has posted a score on it.
      const keys = days.map((d) => d.day);
      if (!keys.includes(today)) keys.unshift(today);
      this.daySelect.replaceChildren(
        ...keys.map((day) => {
          const opt = document.createElement("option");
          opt.value = day;
          opt.textContent = day === today ? `Today - day ${dayNumber(day)}` : `Day ${dayNumber(day)} - ${day}`;
          return opt;
        }),
      );
      this.daySelect.value = today;
      await this.loadBoard(today);
    } catch {
      this.meta.textContent = "Leaderboard unavailable.";
    }
  }

  private closeBoard(): void {
    this.overlay.hidden = true;
  }

  private async loadBoard(day: string): Promise<void> {
    this.meta.textContent = "Loading...";
    try {
      const board = await fetchBoard(day);
      this.paintBoard(board);
    } catch (err) {
      this.list.replaceChildren();
      this.meta.textContent = err instanceof Error ? err.message : "Could not load that day.";
    }
  }

  private paintBoard(board: Board): void {
    const me = playerId();
    this.meta.textContent =
      board.players === 0
        ? "Nobody has posted a score for this map yet."
        : `${board.players} ${board.players === 1 ? "driver" : "drivers"} - day ${dayNumber(board.day)}`;

    this.list.replaceChildren(
      ...board.entries.map((e) => {
        const li = document.createElement("li");
        if (e.playerId === me) li.className = "me";
        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = String(e.rank);
        const who = document.createElement("span");
        who.className = "who";
        // textContent, never innerHTML: names come from other people.
        who.textContent = e.name;
        const sec = document.createElement("span");
        sec.className = "sec";
        sec.textContent = `S${e.section}`;
        const pts = document.createElement("span");
        pts.className = "pts";
        pts.textContent = e.score.toLocaleString();
        li.append(rank, who, sec, pts);
        return li;
      }),
    );

    this.you = el("boardYou");
    this.you.textContent = board.you
      ? `You: rank ${board.you.rank} with ${board.you.score.toLocaleString()} (section ${board.you.section})`
      : "";
  }
}
