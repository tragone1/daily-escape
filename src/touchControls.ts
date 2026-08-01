/*
 * Mobile touch controls, second design pass, per the player:
 *
 * FIXED translucent buttons, laid out for LANDSCAPE - like a keyboard you can see.
 * Left cluster: UP (gas) with DOWN (brake/reverse) below it, BOOST beside the gas.
 * Right cluster: LEFT and RIGHT steer arrows side by side, ROCKET above them.
 * Buttons stay in place whether touched or not, at fixed positions, so a quick tap
 * of steering works exactly like tapping an arrow key - no floating origins, no
 * disappearing sticks. Pressed buttons light up.
 */

interface Pad {
  el: HTMLDivElement;
  ids: Set<number>;
}

class TouchControls {
  active = false;
  throttle = 0;
  brake = 0;
  steer = 0;
  private boostEdge = false;
  private fireEdge = false;
  private pads = new Map<string, Pad>();

  attach(): void {
    const isTouch =
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      location.search.includes("touchui");
    if (!isTouch) return;
    document.body.classList.add("touch-mode");
    this.buildUi();
    // The game area must never scroll or zoom; the pads handle their own touches.
    const opts = { passive: false } as AddEventListenerOptions;
    window.addEventListener("touchmove", (e) => this.onSlide(e), opts);
    // Releases are global: a touch that slid from gas to brake must release the pad
    // it currently holds, not the one it started on.
    const endAll = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        for (const [, pad] of this.pads) {
          pad.ids.delete(t.identifier);
          if (pad.ids.size === 0) pad.el.classList.remove("pressed");
        }
        this.slideIn.delete(t.identifier);
      }
      this.recompute();
    };
    window.addEventListener("touchend", endAll, opts);
    window.addEventListener("touchcancel", endAll, opts);
  }

  /** Touches that slid over a pad since entry, so slide-boost fires exactly once. */
  private slideIn = new Map<number, string>();

  /*
   * Slide-to-boost: holding the gas and dragging onto BOOST fires it without ever
   * lifting - the gas pad keeps its touch (leaving an element does not end a touch),
   * so throttle stays pinned while the boost lights. Works for ROCKET too.
   */
  private onSlide(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      /*
       * Sliding between hold pads transfers the touch: gas to brake and left to
       * right work like rolling a thumb between keys, no lift needed.
       */
      let holder: Pad | null = null;
      for (const [, pad] of this.pads) if (pad.ids.has(t.identifier)) holder = pad;
      if (holder) {
        for (const name of ["up", "down", "left", "right"]) {
          const pad = this.pads.get(name);
          if (!pad || pad === holder) continue;
          const r = pad.el.getBoundingClientRect();
          if (t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom) {
            holder.ids.delete(t.identifier);
            if (holder.ids.size === 0) holder.el.classList.remove("pressed");
            pad.ids.add(t.identifier);
            pad.el.classList.add("pressed");
            this.recompute();
            break;
          }
        }
      }
      let over: string | null = null;
      for (const name of ["boost", "fire"]) {
        const p = this.pads.get(name);
        if (!p) continue;
        const r = p.el.getBoundingClientRect();
        if (t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom) {
          over = name;
          break;
        }
      }
      const prev = this.slideIn.get(t.identifier) ?? null;
      if (over && over !== prev) {
        if (over === "boost") this.boostEdge = true;
        if (over === "fire") this.fireEdge = true;
        const pad = this.pads.get(over);
        if (pad) {
          pad.el.classList.add("pressed");
          setTimeout(() => {
            if (pad.ids.size === 0) pad.el.classList.remove("pressed");
          }, 180);
        }
      }
      if (over) this.slideIn.set(t.identifier, over);
      else this.slideIn.delete(t.identifier);
    }
  }

  private pad(
    name: string,
    label: string,
    css: string,
    onPress?: () => void,
  ): void {
    const el = document.createElement("div");
    el.className = "tpad";
    el.innerHTML = label;
    el.style.cssText = css;
    const entry: Pad = { el, ids: new Set() };
    const opts = { passive: false } as AddEventListenerOptions;
    el.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.active = true;
        for (const t of Array.from(e.changedTouches)) entry.ids.add(t.identifier);
        el.classList.add("pressed");
        if (onPress) onPress();
        this.recompute();
      },
      opts,
    );
    document.body.appendChild(el);
    this.pads.set(name, entry);
  }

  private buildUi(): void {
    // Left cluster: drive.
    this.pad("up", "&#9650;", "left:calc(24px + env(safe-area-inset-left));bottom:118px;width:84px;height:84px");
    this.pad("down", "&#9660;", "left:calc(24px + env(safe-area-inset-left));bottom:24px;width:84px;height:84px");
    this.pad(
      "boost",
      "BOOST",
      "left:calc(136px + env(safe-area-inset-left));bottom:132px;width:74px;height:58px;font-size:12px",
      () => {
        this.boostEdge = true;
      },
    );
    // Right cluster: steer + rocket.
    this.pad("left", "&#9664;", "right:calc(136px + env(safe-area-inset-right));bottom:28px;width:92px;height:92px");
    this.pad("right", "&#9654;", "right:calc(24px + env(safe-area-inset-right));bottom:28px;width:92px;height:92px");
    this.pad(
      "fire",
      "ROCKET",
      "right:calc(60px + env(safe-area-inset-right));bottom:142px;width:96px;height:56px;font-size:12px",
      () => {
        this.fireEdge = true;
      },
    );
  }

  private held(name: string): boolean {
    const p = this.pads.get(name);
    return !!p && p.ids.size > 0;
  }

  private recompute(): void {
    this.throttle = this.held("up") ? 1 : 0;
    this.brake = this.held("down") ? 1 : 0;
    this.steer = (this.held("right") ? 1 : 0) - (this.held("left") ? 1 : 0);
  }

  takeBoost(): boolean {
    const b = this.boostEdge;
    this.boostEdge = false;
    return b;
  }

  takeFire(): boolean {
    const f = this.fireEdge;
    this.fireEdge = false;
    return f;
  }
}

export const TOUCH = new TouchControls();
