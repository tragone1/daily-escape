/**
 * HUD and end-of-run screens. Plain DOM over the canvas — cheaper and easier to iterate
 * on than Babylon GUI, and it keeps interface code completely separate from the game.
 */

import { CONFIG } from "../config";
import type { Surface } from "../world/course";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD element #${id} is missing from index.html`);
  return node as T;
}

export interface HudFrame {
  elapsed: number;
  speed: number;
  boostCharge: number;
  boosting: boolean;
  policeNear: number;
  captureProgress: number;
  /** Screen-space bearing further up the course, radians, 0 = straight ahead. */
  escapeBearing: number;
  rocketAmmo: number;
  rocketInFlight: boolean;
  score: number;
  best: number;
  /** 1-based section number. */
  section: number;
  /** 0..1 through the current section. */
  sectionProgress: number;
  surface: Surface;
  airborne: boolean;
  /** Set while a police deployable is still hurting the car; overrides the surface tag. */
  tireWarning: string | null;
  /** True past the course boundary, where the car crawls and progress stops counting. */
  offCourse: boolean;
}

export interface RunSummary {
  score: number;
  best: number;
  isNewBest: boolean;
  /** 1-based section reached. */
  section: number;
  distance: number;
  elapsed: number;
}

const SURFACE_LABEL: Record<Surface, string> = {
  asphalt: "ASPHALT",
  dirt: "DIRT",
  gravel: "GRAVEL",
  mud: "MUD",
  grass: "GRASS",
};

export class Hud {
  private timer = el("timer");
  private speed = el("speed");
  private heat = el("heat");
  private heatCount = el("heatCount");
  private boostFill = el("boostFill");
  private boostText = el("boostText");
  private captureWrap = el("captureWrap");
  private captureFill = el("captureFill");
  private captureText = el("captureText");
  private rocketRow = el("rocketRow");
  private rocketText = el("rocketText");
  private compassArrow = el("compassArrow");
  private vignette = el("vignette");
  private flash = el("flash");
  private overlay = el("overlay");
  private overlayTitle = el("overlayTitle");
  private overlaySub = el("overlaySub");
  private overlayTime = el("overlayTime");
  private overlayStars = el("overlayStars");
  private overlayDetail = el("overlayDetail");
  private scoreValue = el("scoreValue");
  private bestValue = el("bestValue");
  private sectionValue = el("sectionValue");
  private banner = el("banner");
  private sectionBanner = el("sectionBanner");
  private progressFill = el("progressFill");
  private surfaceTag = el("surfaceTag");


  private bannerTime = 0;
  private sectionTime = 0;
  private flashAmount = 0;

  constructor(onRestart: () => void) {
    el<HTMLButtonElement>("restartBtn").addEventListener("click", onRestart);
    el<HTMLButtonElement>("playAgainBtn").addEventListener("click", onRestart);
  }

  /** Screen-wide white pop for boosts and heavy impacts. */
  punch(amount: number): void {
    this.flashAmount = Math.min(0.55, this.flashAmount + amount);
  }

  /** Big transient centre-screen callout — rocket results and pickups. */
  announce(text: string, good: boolean): void {
    this.banner.textContent = text;
    this.banner.classList.toggle("good", good);
    this.banner.classList.remove("show");
    void this.banner.offsetWidth; // restart the animation on repeat calls
    this.banner.classList.add("show");
    this.bannerTime = 1.4;
  }

  /** Section title card, shown on crossing into a new part of the course. */
  announceSection(text: string): void {
    this.sectionBanner.textContent = text;
    this.sectionBanner.classList.remove("show");
    void this.sectionBanner.offsetWidth;
    this.sectionBanner.classList.add("show");
    this.sectionTime = 2.6;
  }

  update(frame: HudFrame, dt: number): void {
    // Score is the headline now, not the clock.
    this.timer.textContent = frame.score.toLocaleString();
    this.scoreValue.textContent = `SECTION ${frame.section}`;
    this.bestValue.textContent = frame.best > 0 ? `BEST ${frame.best.toLocaleString()}` : "";
    this.sectionValue.textContent = `${frame.elapsed.toFixed(0)}s`;

    const kmh = Math.round(frame.speed * CONFIG.speedToKmh);
    this.speed.innerHTML = `${kmh} <span>KM/H</span>`;

    this.heatCount.textContent = String(frame.policeNear);
    this.heat.classList.toggle("hot", frame.policeNear >= 2);

    const pct = Math.round(frame.boostCharge * 100);
    this.boostFill.style.width = `${pct}%`;
    this.boostFill.classList.toggle("ready", frame.boostCharge >= 1 && !frame.boosting);
    this.boostFill.classList.toggle("active", frame.boosting);
    this.boostText.textContent = frame.boosting
      ? "ACTIVE"
      : frame.boostCharge >= 1
        ? "READY"
        : `${pct}%`;

    const armed = frame.rocketAmmo > 0;
    this.rocketText.textContent = frame.rocketInFlight
      ? "IN FLIGHT"
      : armed
        ? `ARMED x${frame.rocketAmmo} — F`
        : "SPENT";
    this.rocketRow.classList.toggle("armed", armed && !frame.rocketInFlight);
    this.rocketRow.classList.toggle("spent", !armed && !frame.rocketInFlight);

    const showCapture = frame.captureProgress > 0.02;
    this.captureWrap.classList.toggle("show", showCapture);
    this.captureFill.style.width = `${Math.round(frame.captureProgress * 100)}%`;
    // Above two thirds the meter stops being information and becomes an instruction.
    this.captureText.textContent =
      frame.captureProgress > 0.66 ? "BREAK FREE!" : `${Math.round(frame.captureProgress * 100)}%`;
    this.captureText.classList.toggle("urgent", frame.captureProgress > 0.66);
    this.vignette.classList.toggle("danger", frame.captureProgress > 0.35);

    this.compassArrow.style.transform = `rotate(${frame.escapeBearing}rad)`;
    this.progressFill.style.width = `${Math.round(frame.sectionProgress * 100)}%`;

    // Being off the course outranks everything else the tag could say: it is the only one
    // of these states that silently stops the score moving.
    this.surfaceTag.textContent = frame.offCourse
      ? "OFF COURSE"
      : (frame.tireWarning ?? (frame.airborne ? "AIRBORNE" : SURFACE_LABEL[frame.surface]));
    this.surfaceTag.classList.toggle(
      "rough",
      frame.offCourse || frame.tireWarning !== null || frame.airborne || frame.surface !== "asphalt",
    );

    if (this.bannerTime > 0) {
      this.bannerTime = Math.max(0, this.bannerTime - dt);
      if (this.bannerTime === 0) this.banner.classList.remove("show");
    }
    if (this.sectionTime > 0) {
      this.sectionTime = Math.max(0, this.sectionTime - dt);
      if (this.sectionTime === 0) this.sectionBanner.classList.remove("show");
    }

    if (this.flashAmount > 0.001) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * 2.2);
      this.flash.style.opacity = String(this.flashAmount);
    } else if (this.flash.style.opacity !== "0") {
      this.flash.style.opacity = "0";
    }
  }

  showResult(summary: RunSummary): void {
    this.overlay.classList.add("show");
    this.overlayTitle.textContent = "BUSTED";
    this.overlayTitle.className = "lose";
    this.overlaySub.textContent = `They boxed you in on section ${summary.section}.`;

    this.overlayTime.textContent = summary.score.toLocaleString();
    this.overlayTime.style.display = "";

    this.overlayStars.textContent = summary.isNewBest ? "NEW BEST" : "";
    this.overlayStars.className = summary.isNewBest ? "newbest" : "";
    this.overlayStars.style.display = summary.isNewBest ? "" : "none";

    this.overlayDetail.textContent =
      `section ${summary.section} - ${summary.distance.toLocaleString()} m - ` +
      `${summary.elapsed.toFixed(0)}s` +
      (summary.best > summary.score ? ` - best ${summary.best.toLocaleString()}` : "");
    this.overlayDetail.style.display = "";
  }

  hideResult(): void {
    this.overlay.classList.remove("show");
    this.vignette.classList.remove("danger");
    this.banner.classList.remove("show");
    this.sectionBanner.classList.remove("show");
    this.bannerTime = 0;
    this.sectionTime = 0;
    this.flashAmount = 0;
    this.flash.style.opacity = "0";
  }
}
