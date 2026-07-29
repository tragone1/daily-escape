/**
 * Police deployables — the weapons the squad puts on the road in front of you.
 *
 * Two kinds, both laid by a unit that has got *ahead* of you, which is the only way the
 * police can hurt you without touching you:
 *
 *  - SPIKE STRIP: shreds the tyres. Speed and acceleration collapse for a few seconds,
 *    and boost does not paper over it. This is the one that gets you caught.
 *  - OIL SLICK: keeps your speed and takes your steering. Cheaper, laid more often, and
 *    genuinely nasty going into a corner with four cars on you.
 *
 * Both are answerable, which is the point — a hazard you cannot avoid is just damage.
 * They cover most of the road but never all of it, they take a moment to arm, they glow,
 * and you can jump one clean if you are airborne over it.
 */

import { CONFIG } from "../config";
import { clamp } from "../math";
import { Node3D, type Mesh, type Renderer } from "../gfx/renderer";
import type { Vehicle } from "../vehicle/vehicle";
import type { Terrain } from "../world/terrain";
import type { PoliceCar } from "./policeCar";

export type HazardKind = "spike" | "oil";

interface Hazard {
  kind: HazardKind;
  live: boolean;
  x: number;
  z: number;
  y: number;
  heading: number;
  /** Seconds until it bites; a hazard that armed instantly would be unreadable. */
  arm: number;
  /** Seconds of life left. */
  life: number;
  root: Node3D;
  glow: Mesh;
}

export class HazardField {
  private items: Hazard[] = [];
  private cooldown = 0;
  private lastUsed = new WeakMap<PoliceCar, number>();
  private clock = 0;
  private effect: { kind: HazardKind; timer: number } | null = null;

  constructor(r: Renderer, private terrain: Terrain) {
    const cfg = CONFIG.police.hazards;
    for (const kind of ["spike", "oil"] as HazardKind[]) {
      for (let i = 0; i < cfg.maxLive; i++) {
        const built = kind === "spike" ? buildSpikeStrip(r) : buildOilSlick(r);
        built.root.setEnabled(false);
        this.items.push({
          kind,
          live: false,
          x: 0,
          z: 0,
          y: 0,
          heading: 0,
          arm: 0,
          life: 0,
          ...built,
        });
      }
    }
  }

  /** What the HUD should shout while the damage lasts, or null when the car is clean. */
  get warning(): string | null {
    if (!this.effect) return null;
    return this.effect.kind === "spike" ? "TIRES SHREDDED" : "NO GRIP";
  }

  reset(): void {
    for (const h of this.items) {
      h.live = false;
      h.root.setEnabled(false);
    }
    this.cooldown = 0;
    this.effect = null;
    this.lastUsed = new WeakMap();
  }

  /**
   * Age the field, let the squad lay new hazards, and test the player against the live
   * ones. Returns the hazard the player drove over this frame, if any.
   */
  update(
    dt: number,
    player: Vehicle,
    playerProgress: number,
    section: number,
    units: PoliceCar[],
  ): HazardKind | null {
    this.clock += dt;
    this.cooldown -= dt;

    this.applyEffect(dt, player);

    for (const h of this.items) {
      if (!h.live) continue;
      h.arm = Math.max(0, h.arm - dt);
      h.life -= dt;
      if (h.life <= 0) {
        h.live = false;
        h.root.setEnabled(false);
        continue;
      }
      // Pulse while arming, then fade out over the last second of life.
      const pulse = h.arm > 0 ? 0.35 + 0.65 * Math.abs(Math.sin(this.clock * 9)) : 1;
      h.glow.alpha = Math.min(1, h.life) * pulse * (h.kind === "spike" ? 0.95 : 0.85);
    }

    this.deploy(playerProgress, section, units);
    return this.testPlayer(player);
  }

  /** Blend the tyre penalty out as the effect wears off, so recovery is felt, not flipped. */
  private applyEffect(dt: number, player: Vehicle): void {
    if (this.effect) {
      this.effect.timer -= dt;
      if (this.effect.timer <= 0) this.effect = null;
    }
    if (!this.effect) {
      player.tireGrip = 1;
      player.tireSpeed = 1;
      return;
    }
    const k = CONFIG.police.hazards[this.effect.kind];
    const t = clamp(this.effect.timer / k.duration, 0, 1);
    // Boosting on oil does not rescue you: power with no traction is the definition of a
    // slide, and this is the one moment where the answer to everything else is wrong.
    const grip =
      this.effect.kind === "oil" && player.boosting
        ? k.gripScale * CONFIG.police.hazards.oil.boostGripScale
        : k.gripScale;
    player.tireGrip = 1 + (grip - 1) * t;
    player.tireSpeed = 1 + (k.speedScale - 1) * t;
  }

  /**
   * Lay a new hazard, at most one every `globalCooldown`.
   *
   * The unit doing it has to be far enough up the road that you can see the thing land —
   * a strip appearing under your nose would be a coin flip, not a threat.
   */
  private deploy(playerProgress: number, section: number, units: PoliceCar[]): void {
    const cfg = CONFIG.police.hazards;
    if (this.cooldown > 0) return;

    const rate = Math.max(cfg.minCooldownScale, 1 - section * cfg.cooldownPerSection);

    for (const unit of units) {
      if (!unit.active || unit.destroyed) continue;

      const kind = hazardFor(unit.role, section);
      if (!kind) continue;

      const last = this.lastUsed.get(unit) ?? -999;
      const kindScale = kind === "oil" ? cfg.oilCooldownScale : 1;
      if (this.clock - last < cfg.unitCooldown * rate * kindScale) continue;

      const lead = this.terrain.progressAt(unit.vehicle.x, unit.vehicle.z) - playerProgress;
      if (lead < cfg.minLead || lead > cfg.maxLead) continue;

      const slot = this.items.find((h) => !h.live && h.kind === kind);
      if (!slot) continue;

      const k = CONFIG.police.hazards[kind];
      slot.live = true;
      slot.x = unit.vehicle.x;
      slot.z = unit.vehicle.z;
      slot.y = this.terrain.heightAt(slot.x, slot.z);
      slot.heading = unit.vehicle.heading;
      slot.arm = k.armTime;
      slot.life = k.life;
      slot.root.position.set(slot.x, slot.y + 0.06, slot.z);
      slot.root.rotation.y = slot.heading;
      // Lie it *on* the road rather than level with the world. A flat strip on a gradient
      // sinks half its length into the tarmac at one end and floats at the other.
      const ground = this.terrain.sample(slot.x, slot.z);
      const cos = Math.cos(slot.heading);
      const sin = Math.sin(slot.heading);
      slot.root.rotation.x = -Math.atan(ground.gradX * sin + ground.gradZ * cos);
      slot.root.rotation.z = Math.atan(ground.gradX * cos - ground.gradZ * sin);
      slot.root.setEnabled(true);

      this.lastUsed.set(unit, this.clock);
      this.cooldown = cfg.globalCooldown * rate * (kind === "oil" ? 1.6 : 1);
      return;
    }
  }

  /** Oriented-rect test against the car's centre, ignoring anything jumped clean over. */
  private testPlayer(player: Vehicle): HazardKind | null {
    for (const h of this.items) {
      if (!h.live || h.arm > 0) continue;
      if (player.y - h.y > 2.0) continue;

      const k = CONFIG.police.hazards[h.kind];
      const dx = player.x - h.x;
      const dz = player.z - h.z;
      const cos = Math.cos(h.heading);
      const sin = Math.sin(h.heading);
      // Local axes: +along is the direction of travel, +across is to its right.
      const along = dx * sin + dz * cos;
      const across = dx * cos - dz * sin;
      if (Math.abs(along) > k.halfLength + player.params.halfLength * 0.6) continue;
      if (Math.abs(across) > k.halfWidth + player.params.halfWidth) continue;

      // Spikes are consumed by the car that hits them; oil stays down and keeps working.
      if (h.kind === "spike") {
        h.live = false;
        h.root.setEnabled(false);
      }
      this.effect = { kind: h.kind, timer: k.duration };
      return h.kind;
    }
    return null;
  }
}

/** Which deployable, if any, this unit is carrying at this point in the run. */
function hazardFor(role: string, section: number): HazardKind | null {
  const cfg = CONFIG.police.hazards;
  if (section >= cfg.spike.unlockSection && (cfg.spike.roles as readonly string[]).includes(role)) {
    return "spike";
  }
  if (section >= cfg.oil.unlockSection && (cfg.oil.roles as readonly string[]).includes(role)) {
    return "oil";
  }
  return null;
}

/** A dark bar of teeth with a hazard-striped glow, laid across the direction of travel. */
function buildSpikeStrip(r: Renderer): { root: Node3D; glow: Mesh } {
  const k = CONFIG.police.hazards.spike;
  const root = r.createNode();

  const base = r.createMesh(
    { kind: "box", width: k.halfWidth * 2, height: 0.22, depth: k.halfLength * 2 },
    { color: [0.09, 0.09, 0.11], emissive: 0.3 },
  );
  base.parent = root;

  const teeth = Math.max(6, Math.round(k.halfWidth * 2));
  for (let i = 0; i < teeth; i++) {
    const t = teeth === 1 ? 0.5 : i / (teeth - 1);
    const spike = r.createMesh(
      { kind: "cylinder", diameterTop: 0.001, diameterBottom: 0.34, height: 0.85, tessellation: 5 },
      { color: [0.78, 0.8, 0.86], emissive: 0.6 },
    );
    spike.position.set((t - 0.5) * k.halfWidth * 2, 0.5, 0);
    spike.parent = root;
  }

  // The part you actually see from a hundred units back. It has to sit clear of the base
  // box, not inside it — buried at the strip's own centre height it was invisible.
  const glow = r.createMesh(
    { kind: "box", width: k.halfWidth * 2 + 1.6, height: 0.06, depth: k.halfLength * 2 + 2.2 },
    { color: [1, 0.16, 0.1], emissive: 1, alpha: 0.9 },
  );
  glow.position.y = 0.15;
  glow.parent = root;

  return { root, glow };
}

/** A flattened smear; darker than the road with a slick sheen so it reads at night. */
function buildOilSlick(r: Renderer): { root: Node3D; glow: Mesh } {
  const k = CONFIG.police.hazards.oil;
  const root = r.createNode();

  /*
   * A near-black puddle on near-black asphalt is invisible, which is how the slick spent
   * several versions being something players drove over without ever knowing why the car
   * went sideways. It reads by *contrast* now: a bright iridescent sheen over the pool
   * and a hard rim around it, so it stands out on tarmac the way the spike strip does.
   */
  const pool = r.createMesh(
    { kind: "cylinder", diameterTop: 2, diameterBottom: 2, height: 0.05, tessellation: 16 },
    { color: [0.06, 0.05, 0.1], emissive: 0.3, alpha: 0.95 },
  );
  pool.scaling.set(k.halfWidth, 1, k.halfLength);
  pool.parent = root;

  const glow = r.createMesh(
    { kind: "cylinder", diameterTop: 2, diameterBottom: 2, height: 0.03, tessellation: 16 },
    { color: [0.5, 0.9, 1.0], emissive: 1, alpha: 0.8 },
  );
  glow.scaling.set(k.halfWidth * 0.86, 1, k.halfLength * 0.86);
  glow.position.y = 0.06;
  glow.parent = root;

  // Hard rim: an edge is what the eye actually picks up at speed.
  const rim = r.createMesh(
    { kind: "torus", diameter: 2, thickness: 0.22, tessellation: 18 },
    { color: [0.75, 0.55, 1.0], emissive: 1, alpha: 0.95 },
  );
  rim.rotation.x = Math.PI / 2;
  rim.scaling.set(k.halfWidth, k.halfLength, 1);
  rim.position.y = 0.09;
  rim.parent = root;

  return { root, glow };
}
