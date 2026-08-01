/*
 * Juggernaut incident recorder, enabled with ?debug in the URL.
 *
 * Exists because synthetic test batteries kept passing while real play kept failing:
 * the player is the only rig that reproduces the real conditions. Records every
 * juggernaut lifecycle - seat, exposure while armed, fire moment (player speed and
 * distance), closest approach, contact side, outcome - and renders them in a fixed
 * panel the player can screenshot.
 */
import type { PoliceCar } from "./police/policeCar";
import type { Vehicle } from "./vehicle/vehicle";

interface Incident {
  id: number;
  seat: string;
  armedAt: number;
  maxExposure: number;
  firedAt: number | null;
  fireDist: number | null;
  firePSpeed: number | null;
  minD: number;
  aheadAtMin: number;
  outcome: string;
}

const live = new Map<PoliceCar, Incident>();
const done: Incident[] = [];
let nextId = 1;
let panel: HTMLDivElement | null = null;

export const DEBUG_JUGG = typeof location !== "undefined" && location.search.includes("debug");

/*
 * Section jump, debug only: Digit1-9 jump to sections 1-9, Digit0 to 10; hold Shift
 * for 11-20. Installed lazily on the first recorder tick so the game object exists.
 */
let jumpKeysInstalled = false;
function installJumpKeys(): void {
  if (jumpKeysInstalled) return;
  jumpKeysInstalled = true;
  window.addEventListener("keydown", (e) => {
    const m = /^Digit(\d)$/.exec(e.code);
    if (!m) return;
    const digit = Number(m[1]);
    let section = digit === 0 ? 10 : digit;
    if (e.shiftKey) section += 10;
    const game = (window as unknown as { __game?: { jumpToSection(s: number): void } }).__game;
    if (game) game.jumpToSection(section - 1);
  });
}

function ui(): HTMLDivElement {
  if (!panel) {
    panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,0.8);" +
      "color:#8f8;font:11px monospace;padding:8px;border-radius:6px;max-width:430px;" +
      "white-space:pre;pointer-events:none";
    document.body.appendChild(panel);
  }
  return panel;
}

function fmt(i: Incident): string {
  const exp = i.maxExposure > 0.5 ? "EXPOSED " + i.maxExposure.toFixed(1) : "hidden";
  const fire =
    i.firedAt === null
      ? "no-fire"
      : "fired d=" + (i.fireDist ?? 0).toFixed(0) + " pSpd=" + (i.firePSpeed ?? 0).toFixed(0);
  const close =
    i.minD < 900
      ? " min=" + i.minD.toFixed(1) + (i.aheadAtMin > 3 ? " AHEAD" : i.aheadAtMin < -3 ? " behind" : " SIDE")
      : "";
  return "#" + i.id + " [" + exp + "] " + fire + close + " -> " + i.outcome;
}

export function recordJuggernauts(
  units: readonly PoliceCar[],
  player: Vehicle,
  elapsed: number,
): void {
  if (!DEBUG_JUGG) return;
  installJumpKeys();
  for (const u of units) {
    if (u.role !== "juggernaut") continue;
    let inc = live.get(u);
    if (u.active && u.ambushAt && (!inc || inc.outcome !== "")) {
      inc = {
        id: nextId++,
        seat: u.vehicle.x.toFixed(0) + "," + u.vehicle.z.toFixed(0),
        armedAt: elapsed,
        maxExposure: -99,
        firedAt: null,
        fireDist: null,
        firePSpeed: null,
        minD: 999,
        aheadAtMin: 0,
        outcome: "",
      };
      live.set(u, inc);
    }
    if (!inc || inc.outcome !== "") continue;
    const v = u.vehicle;
    const d = Math.hypot(v.x - player.x, v.z - player.z);
    if (u.ambushAt && u.ambushOut) {
      const exp =
        (v.x - u.ambushAt.x) * u.ambushOut.x + (v.z - u.ambushAt.z) * u.ambushOut.z;
      inc.maxExposure = Math.max(inc.maxExposure, exp);
    }
    if (!u.ambushAt && inc.firedAt === null && !u.spent) {
      inc.firedAt = elapsed;
      inc.fireDist = d;
      inc.firePSpeed = player.speed;
    }
    if (inc.firedAt !== null) {
      if (d < inc.minD) {
        inc.minD = d;
        inc.aheadAtMin =
          (v.x - player.x) * Math.sin(player.heading) +
          (v.z - player.z) * Math.cos(player.heading);
      }
      if (d < 5.4) inc.outcome = "CONTACT";
    }
    if (u.spent && inc.outcome === "") inc.outcome = inc.firedAt === null ? "expired" : "MISS";
    if (!u.active && inc.outcome === "") inc.outcome = "recycled";
    if (inc.outcome !== "") {
      done.push(inc);
      try {
        localStorage.setItem("juggLog", JSON.stringify(done.slice(-30)));
      } catch {
        /* full is fine */
      }
      // Ship it to the dev server's collector so the session leaves a record on disk.
      try {
        fetch("/debug-log", { method: "POST", body: fmt(inc) }).catch(() => {});
      } catch {
        /* offline is fine */
      }
    }
  }
  const lines = done.slice(-7).map(fmt);
  for (const [, inc] of live) {
    if (inc.outcome === "") lines.push(fmt({ ...inc, outcome: "..." }));
  }
  ui().textContent = "JUGG DEBUG build-85 | keys 1-9,0 jump to section (shift +10)\n" + (lines.length ? lines.join("\n") : "(none yet)");
}
