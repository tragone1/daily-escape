/*
 * Mobile touch controls, per the player\'s design.
 *
 * Two floating thumb sticks: the LEFT half of the screen is a vertical stick - push
 * up for gas, further up past the detent for BOOST, pull down for brake/reverse. The
 * RIGHT half is a horizontal stick for steering - and a sharp upward FLICK on it
 * fires a rocket, so neither thumb ever leaves its stick. A small tap pad in the top
 * area also fires, as the discoverable backup.
 *
 * Sticks are floating (they centre where the thumb lands) and VISIBLE: a translucent
 * ring with a knob that tracks the thumb, direction arrows lighting as they engage,
 * green glow while the boost detent is crossed.
 */

interface StickState {
  id: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
}

const GAS_RANGE = 70;
const BOOST_BAND = 118;
const STEER_RANGE = 64;
const FLICK_UP = 55;

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
  private leftUi: HTMLDivElement | null = null;
  private rightUi: HTMLDivElement | null = null;

  attach(): void {
    const opts = { passive: false } as AddEventListenerOptions;
    window.addEventListener("touchstart", (e) => this.onStart(e), opts);
    window.addEventListener("touchmove", (e) => this.onMove(e), opts);
    window.addEventListener("touchend", (e) => this.onEnd(e), opts);
    window.addEventListener("touchcancel", (e) => this.onEnd(e), opts);
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0 || location.search.includes("touchui")) {
      document.body.classList.add("touch-mode");
      this.buildUi();
    }
  }

  private mkStick(arrows: string[]): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "stick";
    el.style.display = "none";
    el.innerHTML =
      `<div class="knob"></div>` +
      arrows
        .map(
          (a) =>
            `<div class="arrow" data-dir="` + a + `" style="` +
            (a === "up" ? "top:6px;left:50%;transform:translateX(-50%)" :
             a === "down" ? "bottom:6px;left:50%;transform:translateX(-50%)" :
             a === "left" ? "left:8px;top:50%;transform:translateY(-50%)" :
             "right:8px;top:50%;transform:translateY(-50%)") +
            `">` +
            (a === "up" ? "&#9650;" : a === "down" ? "&#9660;" : a === "left" ? "&#9664;" : "&#9654;") +
            "</div>",
        )
        .join("");
    document.body.appendChild(el);
    return el;
  }

  private buildUi(): void {
    this.leftUi = this.mkStick(["up", "down"]);
    this.rightUi = this.mkStick(["left", "right"]);
    const pad = document.createElement("div");
    pad.textContent = "ROCKET";
    pad.style.cssText =
      "position:fixed;top:40%;right:10px;padding:10px 12px;border:1px solid rgba(255,255,255,0.3);" +
      "border-radius:9px;background:rgba(10,12,18,0.45);z-index:44;font:11px monospace;" +
      "color:rgba(255,255,255,0.7);user-select:none;-webkit-user-select:none";
    pad.addEventListener("touchstart", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.fireEdge = true;
    }, { passive: false });
    document.body.appendChild(pad);
  }

  private showStick(ui: HTMLDivElement | null, st: StickState | null): void {
    if (!ui) return;
    if (!st) {
      ui.style.display = "none";
      return;
    }
    ui.style.display = "block";
    ui.style.left = st.originX - 54 + "px";
    ui.style.top = st.originY - 54 + "px";
    const knob = ui.querySelector(".knob") as HTMLDivElement | null;
    if (knob) {
      const kx = Math.max(-46, Math.min(46, st.dx));
      const ky = Math.max(-46, Math.min(46, st.dy));
      knob.style.transform = "translate(calc(-50% + " + kx + "px), calc(-50% + " + ky + "px))";
    }
  }

  private paint(): void {
    this.showStick(this.leftUi, this.left);
    this.showStick(this.rightUi, this.right);
    if (this.leftUi) {
      this.leftUi.classList.toggle("hot", this.throttle > 0.05 || this.brake > 0.05);
      this.leftUi.classList.toggle("boosting", this.boostLatched);
      const up = this.leftUi.querySelector(`[data-dir="up"]`);
      const down = this.leftUi.querySelector(`[data-dir="down"]`);
      if (up) up.classList.toggle("lit", this.throttle > 0.05);
      if (down) down.classList.toggle("lit", this.brake > 0.05);
    }
    if (this.rightUi) {
      this.rightUi.classList.toggle("hot", Math.abs(this.steer) > 0.05);
      const l = this.rightUi.querySelector(`[data-dir="left"]`);
      const rr = this.rightUi.querySelector(`[data-dir="right"]`);
      if (l) l.classList.toggle("lit", this.steer < -0.05);
      if (rr) rr.classList.toggle("lit", this.steer > 0.05);
    }
  }

  private onStart(e: TouchEvent): void {
    const target = e.target as HTMLElement | null;
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
    this.recompute();
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
      const up = -this.left.dy;
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
    this.paint();
  }

  takeBoost(): boolean { const b = this.boostEdge; this.boostEdge = false; return b; }
  takeFire(): boolean { const f = this.fireEdge; this.fireEdge = false; return f; }
}

export const TOUCH = new TouchControls();
