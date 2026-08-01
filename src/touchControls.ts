/*
 * Mobile touch controls, per the player\'s design.
 *
 * Two floating thumb sticks: the LEFT half of the screen is a vertical stick - push
 * up for gas, further up past the detent for BOOST, pull down for brake/reverse. The
 * RIGHT half is a horizontal stick for steering - and a sharp upward FLICK on it
 * fires a rocket, so neither thumb ever leaves its stick. A small tap pad in the top
 * right also fires, as the discoverable backup.
 *
 * Sticks are floating: each touch\'s starting point becomes that stick\'s centre, so
 * there is no fixed target to hunt for mid-chase.
 */

interface StickState {
  id: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
}

const GAS_RANGE = 70;      // px of travel for full throttle / full brake
const BOOST_BAND = 118;    // push beyond this = boost (edge-triggered)
const STEER_RANGE = 64;    // px of travel for full lock
const FLICK_UP = 55;       // upward travel on the steer stick that fires (edge)

class TouchControls {
  active = false;
  throttle = 0;
  brake = 0;
  steer = 0;
  private boostEdge = false;
  private fireEdge = false;
  private boostLatched = false;
  private flickLatched = false;
  private left: StickState | null = null;
  private right: StickState | null = null;

  attach(): void {
    // Listeners are attached unconditionally - they simply never fire without a
    // touchscreen - but the on-screen pads only appear where touch exists.
    const opts = { passive: false } as AddEventListenerOptions;
    window.addEventListener("touchstart", (e) => this.onStart(e), opts);
    window.addEventListener("touchmove", (e) => this.onMove(e), opts);
    window.addEventListener("touchend", (e) => this.onEnd(e), opts);
    window.addEventListener("touchcancel", (e) => this.onEnd(e), opts);
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) this.buildUi();
  }

  private buildUi(): void {
    const ui = document.createElement("div");
    ui.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:40;font:12px monospace;color:rgba(255,255,255,0.65)";
    const pad = document.createElement("div");
    pad.textContent = "ROCKET";
    pad.style.cssText =
      "position:absolute;top:12px;right:12px;padding:14px 18px;border:1px solid rgba(255,255,255,0.35);" +
      "border-radius:10px;background:rgba(10,12,18,0.5);pointer-events:auto;user-select:none;-webkit-user-select:none";
    pad.addEventListener("touchstart", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.fireEdge = true;
    }, { passive: false });
    ui.appendChild(pad);
    const hint = document.createElement("div");
    hint.textContent = "left: gas / reverse (push high = BOOST)   right: steer (flick up = rocket)";
    hint.style.cssText =
      "position:absolute;bottom:6px;left:50%;transform:translateX(-50%);white-space:nowrap;opacity:0.7";
    ui.appendChild(hint);
    document.body.appendChild(ui);
    setTimeout(() => { if (hint.parentElement) hint.style.opacity = "0"; }, 9000);
  }

  private onStart(e: TouchEvent): void {
    const target = e.target as HTMLElement | null;
    // Let taps on real UI (buttons, inputs, the rocket pad) behave normally.
    if (target && (target.closest("button") || target.closest("input") || target.closest("a"))) return;
    e.preventDefault();
    this.active = true;
    for (const t of Array.from(e.changedTouches)) {
      const stick: StickState = { id: t.identifier, originX: t.clientX, originY: t.clientY, dx: 0, dy: 0 };
      if (t.clientX < window.innerWidth / 2) {
        if (!this.left) this.left = stick;
      } else if (!this.right) {
        this.right = stick;
      }
    }
  }

  private onMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      for (const stick of [this.left, this.right]) {
        if (stick && stick.id === t.identifier) {
          stick.dx = t.clientX - stick.originX;
          stick.dy = t.clientY - stick.originY;
        }
      }
    }
    this.recompute();
  }

  private onEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (this.left && this.left.id === t.identifier) this.left = null;
      if (this.right && this.right.id === t.identifier) this.right = null;
    }
    this.recompute();
  }

  private recompute(): void {
    if (this.left) {
      const up = -this.left.dy; // screen up = negative dy
      if (up >= 0) {
        this.throttle = Math.min(1, up / GAS_RANGE);
        this.brake = 0;
        if (up > BOOST_BAND) {
          if (!this.boostLatched) { this.boostEdge = true; this.boostLatched = true; }
        } else if (up < BOOST_BAND * 0.8) {
          this.boostLatched = false;
        }
      } else {
        this.throttle = 0;
        this.brake = Math.min(1, -up / GAS_RANGE);
      }
    } else {
      this.throttle = 0;
      this.brake = 0;
      this.boostLatched = false;
    }
    if (this.right) {
      this.steer = Math.max(-1, Math.min(1, this.right.dx / STEER_RANGE));
      const up = -this.right.dy;
      if (up > FLICK_UP) {
        if (!this.flickLatched) { this.fireEdge = true; this.flickLatched = true; }
      } else if (up < FLICK_UP * 0.6) {
        this.flickLatched = false;
      }
    } else {
      this.steer = 0;
      this.flickLatched = false;
    }
  }

  /** Edge-consuming reads, one shot per gesture. */
  takeBoost(): boolean { const b = this.boostEdge; this.boostEdge = false; return b; }
  takeFire(): boolean { const f = this.fireEdge; this.fireEdge = false; return f; }
}

export const TOUCH = new TouchControls();
