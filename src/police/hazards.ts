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
import type { CollisionWorld } from "../physics/collisionWorld";
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
  /** Span across the road, clamped so a gap always remains. */
  halfWidth: number;
  root: Node3D;
  glow: Mesh;
}

export class HazardField {
  private items: Hazard[] = [];
  private cooldown = 0;
  private lastUsed = new WeakMap<PoliceCar, number>();
  private clock = 0;
  private effect: { kind: HazardKind; timer: number } | null = null;

  constructor(
    r: Renderer,
    private terrain: Terrain,
    private collision: CollisionWorld,
  ) {
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
          halfWidth: 1,
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
      // Never span the whole carriageway: a hazard has to leave a line to take.
      const seg = this.terrain.sample(unit.vehicle.x, unit.vehicle.z).segment;
      const road = seg.halfWidth;
      const room = Math.max(0, road - cfg.minGap * 0.5);
      let halfWidth = Math.max(2.2, Math.min(k.halfWidth, room, road * cfg.maxRoadShare));
      let px = unit.vehicle.x;
      let pz = unit.vehicle.z;
      let heading = unit.vehicle.heading;

      /*
       * Spikes go against a wall, not wherever the unit happened to be driving.
       *
       * `minGap` is meant to guarantee a way past, but a strip dropped at the unit's own
       * position lands mid-road, and the gap it leaves comes out as two useless halves -
       * in a corridor, barely a car's width each, with the car itself two units wide.
       * Pushed flush to one side the same clearance becomes a single lane you can
       * actually take. The strip is squared to the road at the same time, since an edge
       * can only sit against a wall if it is parallel to one.
       *
       * Oil is deliberately left where it falls: it is the chaotic one, and a slick you
       * can plan a line around is not the same weapon.
       */
      if (kind === "spike") {
        const across = (px - seg.ax) * seg.dz - (pz - seg.az) * seg.dx;
        const along = (px - seg.ax) * seg.dx + (pz - seg.az) * seg.dz;
        const cx = seg.ax + seg.dx * along;
        const cz = seg.az + seg.dz * along;
        /*
         * Work inside the lane that is actually open, not the one the road is nominally
         * wide. A skip or a barrier standing near the kerb is a wall as far as the car is
         * concerned, so hugging the tarmac edge behind one left the strip spanning every
         * route through - avoidable on paper, unavoidable in the lane. Probing for the
         * widest clear run makes the block part of the wall, which is what it already is
         * to anyone driving at it.
         */
        const band = this.clearBand(cx, cz, seg, road) ?? { lo: -road, hi: road };
        /*
         * And if that lane cannot take a strip *and* a gap, this is not a place for one.
         * Laying it anyway is how the unavoidable ones happened: the fallback used to be
         * the naive wall-hug, applied in exactly the tight spot that needed care most.
         * Better to wait for a spot that leaves an answer - a hazard with no way past is
         * not a hazard, it is just damage.
         */
        const usable = (band.hi - band.lo - cfg.minGap) * 0.5;
        if (usable < 2.2) continue;
        halfWidth = Math.max(2.2, Math.min(halfWidth, usable));
        // Flush to whichever end of the clear run the unit was already nearer.
        const lateral =
          across >= (band.lo + band.hi) * 0.5
            ? band.hi - halfWidth
            : band.lo + halfWidth;
        px = cx + seg.dz * lateral;
        pz = cz - seg.dx * lateral;
        heading = Math.atan2(seg.dx, seg.dz);
      }

      slot.halfWidth = halfWidth;
      slot.live = true;
      slot.x = px;
      slot.z = pz;
      slot.heading = heading;
      slot.y = this.terrain.heightAt(slot.x, slot.z);
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
      // Scale the mesh to match the span actually used.
      slot.root.scaling.set(slot.halfWidth / k.halfWidth, 1, 1);
      slot.root.setEnabled(true);

      this.lastUsed.set(unit, this.clock);
      this.cooldown = cfg.globalCooldown * rate * (kind === "oil" ? 1.6 : 1);
      return;
    }
  }

  /**
   * The widest run of laterally clear road across a point, as offsets from the centreline.
   *
   * Answers "where could a car actually be here", not "how wide is the tarmac". Props
   * standing near the kerb — skips, barriers, stacked crates — are solid, so the lane
   * they leave is the one that matters when deciding where a strip may span. Returns
   * null when nothing is in the way and the caller can just use the road.
   *
   * Only runs on deployment, which the cooldowns keep rare, so probing is cheap enough
   * to do properly.
   */
  private clearBand(
    cx: number,
    cz: number,
    seg: { dx: number; dz: number },
    road: number,
  ): { lo: number; hi: number } | null {
    const PROBES = 33;
    // A shade under half the car, so a gap only counts when it is genuinely drivable.
    const probeRadius = 0.95;
    let bestLo = 0;
    let bestHi = 0;
    let runLo: number | null = null;
    let blocked = false;

    for (let i = 0; i < PROBES; i++) {
      const lat = -road + (2 * road * i) / (PROBES - 1);
      const px = cx + seg.dz * lat;
      const pz = cz - seg.dx * lat;
      const clear = this.collision.isClear(px, pz, probeRadius);
      if (!clear) blocked = true;
      if (clear) {
        if (runLo === null) runLo = lat;
        if (lat - runLo > bestHi - bestLo) {
          bestLo = runLo;
          bestHi = lat;
        }
      } else {
        runLo = null;
      }
    }
    // Nothing solid anywhere across the road: the plain wall-hug is already correct.
    // A band narrower than the strip needs is still reported rather than discarded — the
    // caller declines to lay there, which is the whole point of measuring.
    return blocked ? { lo: bestLo, hi: bestHi } : null;
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
      if (Math.abs(across) > h.halfWidth + player.params.halfWidth) continue;

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
