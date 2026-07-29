/**
 * Run state for endless mode.
 *
 * There is no finish. A run ends exactly one way — the police pin you long enough to make
 * the arrest — and the only question is how far up the course you got before they managed
 * it. Score is therefore *furthest forward progress on the course*, never distance
 * driven: doubling back, circling, taking the scenic line, or cutting across the
 * wasteland outside the barriers all earn nothing.
 */

import { CONFIG } from "./config";
import { clamp } from "./math";
import { sectionIndexAt } from "./world/course";

export type RunStatus = "running" | "captured";

const BEST_KEY = "dailyEscape.best";

export class GameState {
  status: RunStatus = "running";
  /** Seconds since the run started. */
  elapsed = 0;
  /** 0..1 — how close the police are to boxing you in. */
  captureProgress = 0;
  /** Current distance along the course spine. */
  progress = 0;
  /** Furthest point reached; this and only this drives the score. */
  maxProgress = 0;
  /** 0-based section index at `maxProgress`. */
  section = 0;
  /** Peak capture meter reached, reported in the summary. */
  worstCapture = 0;
  /** Best score seen on this device. */
  best = 0;

  constructor() {
    this.best = this.loadBest();
  }

  /** Distance banked plus a bonus for each section survived. */
  get score(): number {
    return Math.round(this.maxProgress) + this.section * CONFIG.run.sectionBonus;
  }

  get over(): boolean {
    return this.status !== "running";
  }

  get isNewBest(): boolean {
    return this.status === "captured" && this.score >= this.best && this.score > 0;
  }

  private loadBest(): number {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      // Private browsing and embedded frames can both refuse storage; a score that only
      // lasts the session is a much better outcome than a crash on boot.
      return 0;
    }
  }

  private saveBest(value: number): void {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch {
      /* ignore */
    }
  }

  reset(): void {
    this.status = "running";
    this.elapsed = 0;
    this.captureProgress = 0;
    this.progress = 0;
    this.maxProgress = 0;
    this.section = 0;
    this.worstCapture = 0;
  }

  /**
   * Advance the run. Capture requires the player to be held nearly stationary *and*
   * closely surrounded for a sustained period — a single hard hit never ends a run,
   * and breaking free drains the meter faster than it fills.
   */
  update(
    dt: number,
    playerSpeed: number,
    policeNear: number,
    progress: number,
    onCourse: boolean,
  ): void {
    if (this.over) return;

    this.elapsed += dt;
    this.progress = progress;
    /*
     * Ground gained off the course does not count.
     *
     * Progress is measured by projecting onto the nearest spine segment, so driving
     * cross-country past the barriers used to bank distance exactly as if you had driven
     * the road. Combined with the backstop putting you back afterwards, leaving the
     * course was strictly better than staying on it. Freezing the counter out there is
     * what makes the wasteland a cost rather than a shortcut.
     */
    if (onCourse && progress > this.maxProgress) {
      this.maxProgress = progress;
      this.section = sectionIndexAt(progress);
    }

    const run = CONFIG.run;
    /*
     * What counts as pinned rises with the crowd.
     *
     * Up to `captureCrowdFloor` cars only have you if you are nearly stopped. Ten packed
     * around you have you at a good deal more than that — you are not escaping, you are
     * being carried. A flat threshold was why a player could be visibly buried in police
     * and drive out anyway: every ram bumped them back over the line, so the meter never
     * filled however bad it looked.
     *
     * The floor matters as much as the slope. Scaling from the second car made ordinary
     * early-section traffic lethal; nothing should change until you are actually swarmed.
     */
    const swarm = Math.max(0, policeNear - run.captureCrowdFloor);
    const threshold = Math.min(
      run.captureSpeedMax,
      run.captureSpeed + swarm * run.captureSpeedPerUnit,
    );
    const pinned = policeNear > 0 && playerSpeed < threshold;
    // Being swarmed closes the run out fast; a single car nudging you does not.
    const crowd = 1 + run.captureCrowdBonus * Math.max(0, policeNear - 1);
    const rate = 1 / run.captureDuration;
    this.captureProgress = clamp(
      this.captureProgress + (pinned ? rate * crowd : -rate * run.captureRecovery) * dt,
      0,
      1,
    );
    this.worstCapture = Math.max(this.worstCapture, this.captureProgress);

    if (this.captureProgress >= 1) {
      this.status = "captured";
      if (this.score > this.best) {
        this.best = this.score;
        this.saveBest(this.best);
      }
    }
  }
}
