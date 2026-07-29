/**
 * The hunter's tether — the squad's answer to a player who cannot be hit hard enough.
 *
 * Every other threat in the game is a collision, and collisions have a fatal property in
 * common: they give you speed. The heaviest unit on the roster arriving at full charge
 * shoved the player clear of the scrum, which looked devastating and played as an escape.
 * A cable has no such problem. It does not push, it holds — your top speed is cut, you are
 * dragged back toward the unit on the other end, and everything else in the section gets
 * to catch up while you deal with it.
 *
 * It is answerable, and deliberately by spending something: a boost charge snaps the line.
 * That puts the meter you were saving for the next climb up against the thing that is
 * about to end the run, which is a better decision than either half was on its own.
 */

import { CONFIG } from "../config";
import { clamp, dist } from "../math";
import { Node3D, type Mesh, type Renderer } from "../gfx/renderer";
import type { Vehicle } from "../vehicle/vehicle";
import type { PoliceCar } from "./policeCar";

interface Line {
  unit: PoliceCar;
  /** Seconds of life left. */
  life: number;
  /** How long the player has been burning boost against it. */
  strain: number;
}

export type TetherEvent = "fired" | "snapped" | "expired";

export class TetherSystem {
  private lines: Line[] = [];
  private cooldowns = new WeakMap<PoliceCar, number>();
  private clock = 0;
  private readonly cable: Mesh;
  private readonly root: Node3D;

  constructor(r: Renderer) {
    this.root = r.createNode();
    // One cable mesh, stretched between the two ends each frame. A unit box scaled along
    // Z is all a taut line needs, and it costs one draw call whether it is up or not.
    this.cable = r.createMesh(
      { kind: "box", width: 0.34, height: 0.34, depth: 1 },
      { color: [0.95, 0.98, 1], emissive: 1, alpha: 0.85 },
    );
    this.cable.parent = this.root;
    this.root.setEnabled(false);
  }

  get attached(): boolean {
    return this.lines.length > 0;
  }

  /** 0..1 progress toward snapping the line with boost, for the HUD. */
  get strain(): number {
    const line = this.lines[0];
    if (!line) return 0;
    return clamp(line.strain / CONFIG.police.hunter.tether.boostBreakTime, 0, 1);
  }

  reset(): void {
    this.lines = [];
    this.cooldowns = new WeakMap();
    this.root.setEnabled(false);
  }

  /**
   * Fire, hold, drag and break. Returns what happened this frame, if anything.
   */
  update(dt: number, player: Vehicle, units: PoliceCar[]): TetherEvent | null {
    const cfg = CONFIG.police.hunter.tether;
    this.clock += dt;
    player.restraint = 1;

    let event: TetherEvent | null = null;

    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      const v = line.unit.vehicle;
      const d = dist(v.x, v.z, player.x, player.z);

      // Burning boost is what cuts it. Anything else and you are just being dragged.
      if (player.boosting) line.strain += dt;

      const dead = !line.unit.active || line.unit.destroyed || line.unit.disabled;
      const overStretched = d > cfg.breakLength;
      const cut = line.strain >= cfg.boostBreakTime;
      line.life -= dt;

      if (dead || overStretched || cut || line.life <= 0) {
        this.lines.splice(i, 1);
        this.cooldowns.set(line.unit, this.clock);
        event = cut || overStretched ? "snapped" : "expired";
        continue;
      }

      // Hold and haul. The pull is toward the hunter, so it also steers you off your line.
      player.restraint = Math.min(player.restraint, cfg.speedScale);
      if (d > 1) {
        player.applyImpulse(((v.x - player.x) / d) * cfg.pull * dt, ((v.z - player.z) / d) * cfg.pull * dt);
      }
    }

    if (this.lines.length < cfg.maxActive) {
      const fired = this.tryFire(player, units);
      if (fired) event = "fired";
    }

    this.draw(player);
    return event;
  }

  /** Find a hunter that is in range, lined up, off cooldown and has a clear shot. */
  private tryFire(player: Vehicle, units: PoliceCar[]): boolean {
    const cfg = CONFIG.police.hunter.tether;

    for (const unit of units) {
      if (unit.role !== "hunter") continue;
      if (!unit.active || unit.destroyed || unit.disabled) continue;
      if (this.clock - (this.cooldowns.get(unit) ?? -999) < cfg.cooldown) continue;

      const v = unit.vehicle;
      const dx = player.x - v.x;
      const dz = player.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d > cfg.fireRange || d < 6) continue;

      // It has to be pointed at you, so a hunter you have already passed cannot fire
      // blind over its own shoulder.
      const aim = Math.atan2(dx, dz);
      let err = aim - v.heading;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      if (Math.abs(err) > cfg.fireCone) continue;

      this.lines.push({ unit, life: cfg.duration, strain: 0 });
      return true;
    }
    return false;
  }

  /** Stretch the cable mesh between the two ends. */
  private draw(player: Vehicle): void {
    const line = this.lines[0];
    if (!line) {
      this.root.setEnabled(false);
      return;
    }
    const v = line.unit.vehicle;
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    const d = Math.hypot(dx, dz) || 1;

    this.root.setEnabled(true);
    this.root.position.set((v.x + player.x) / 2, (v.y + player.y) / 2 + 1.3, (v.z + player.z) / 2);
    this.root.rotation.y = Math.atan2(dx, dz);
    this.cable.scaling.set(1, 1, d);
    // Whitens as it comes under strain, so cutting it reads as a struggle you are winning.
    const glow = 0.6 + this.strain * 0.4;
    this.cable.tint[3] = glow;
  }
}
