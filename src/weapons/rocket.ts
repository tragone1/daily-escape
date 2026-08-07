/**
 * The player's single rocket, and the explosion it makes.
 *
 * One per run, so the interesting decision is *when* to spend it — breaking a box-in, opening a
 * roadblock, or breaking up a squad before it closes. Anything caught near the centre
 * is wrecked outright and gone for the rest of the run; anything on the fringe is thrown
 * and left driverless. It does not home, so a miss costs you the whole run's firepower.
 *
 * The blast is built from primitives layered by lifetime — a white core, a fireball, a
 * ground shockwave, debris and rising smoke, plus a real light flash. Each element is
 * pooled and reused, so detonating costs no allocations.
 */

import { Node3D, type Mesh, type Renderer } from "../gfx/renderer";

import { CONFIG } from "../config";
import { FX } from "../gfx/particles";
import { clamp, forwardOf } from "../math";
import { obbVsOBB } from "../physics/collision";
import type { CollisionWorld } from "../physics/collisionWorld";
import type { PoliceCar } from "../police/policeCar";
import type { Terrain } from "../world/terrain";
import type { Vehicle } from "../vehicle/vehicle";
import { buildRocketMesh } from "./rocketMesh";

export interface Detonation {
  x: number;
  z: number;
  /** Units wrecked outright. */
  destroyed: number;
  /** Units thrown clear but still alive. */
  thrown: number;
}

const ROCKET_HALF_LENGTH = CONFIG.player.rocket.halfLength;
const ROCKET_HALF_WIDTH = CONFIG.player.rocket.halfWidth;
const SPARK_COUNT = 18;
const SMOKE_COUNT = 6;
const TRAIL_COUNT = 14;

interface Particle {
  mesh: Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

export class RocketSystem {
  /** Rockets left this run. */
  ammo: number = CONFIG.player.rocket.ammo;

  private live = false;
  private x = 0;
  private z = 0;
  private vx = 0;
  private vz = 0;
  private heading = 0;
  private travelled = 0;

  private mesh: Node3D;

  // Explosion elements, all pooled.
  private core: Mesh;
  private fireball: Mesh;
  private shockwave: Mesh;
  private sparks: Particle[] = [];
  private smoke: Particle[] = [];
  private trail: Particle[] = [];
  private trailCursor = 0;
  private trailTimer = 0;

  private coreTime = 0;
  private fireTime = 0;
  private shockTime = 0;

  constructor(r: Renderer) {
    // --- Projectile --------------------------------------------------------
    this.mesh = buildRocketMesh(r, ROCKET_HALF_LENGTH, ROCKET_HALF_WIDTH);
    this.mesh.setEnabled(false);

    // --- Blast core: white-hot, gone almost immediately ---------------------
    this.core = r.createMesh({ kind: "sphere", diameter: 2, segments: 10 },
      { color: [1, 1, 0.92], emissive: 1 });
    this.core.setEnabled(false);

    // --- Fireball: slower, fades orange to red ------------------------------
    this.fireball = r.createMesh({ kind: "sphere", diameter: 2, segments: 12 },
      { color: [1, 0.55, 0.12], emissive: 1, alpha: 0.9 });
    this.fireball.setEnabled(false);

    // --- Ground shockwave ring ----------------------------------------------
    this.shockwave = r.createMesh({ kind: "torus", diameter: 2, thickness: 0.16, tessellation: 28 },
      { color: [1, 0.85, 0.5], emissive: 1, alpha: 0.8 });
    this.shockwave.setEnabled(false);

    // --- Debris --------------------------------------------------------------
    for (let i = 0; i < SPARK_COUNT; i++) {
      const m = r.createMesh({ kind: "box", width: 0.55, height: 0.55, depth: 0.55 },
        { color: [1, 0.8, 0.35], emissive: 1 });
      m.setEnabled(false);
      this.sparks.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
    }

    // --- Smoke ---------------------------------------------------------------
    // Warm mid-grey rather than near-black: dark smoke against the fireball read as a
    // hole punched in the middle of the explosion.
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const m = r.createMesh({ kind: "sphere", diameter: 2, segments: 6 },
        { color: [0.3, 0.27, 0.26], emissive: 0.8, alpha: 0.42 });
      m.setEnabled(false);
      this.smoke.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
    }

    // --- Exhaust trail -------------------------------------------------------
    for (let i = 0; i < TRAIL_COUNT; i++) {
      const m = r.createMesh({ kind: "sphere", diameter: 1.1, segments: 5 },
        { color: [1, 0.7, 0.3], emissive: 1, alpha: 0.6 });
      m.setEnabled(false);
      this.trail.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
    }
  }

  get inFlight(): boolean {
    return this.live;
  }

  reset(): void {
    this.ammo = CONFIG.player.rocket.ammo;
    this.live = false;
    this.coreTime = 0;
    this.fireTime = 0;
    this.shockTime = 0;
    this.mesh.setEnabled(false);
    this.core.setEnabled(false);
    this.fireball.setEnabled(false);
    this.shockwave.setEnabled(false);
    for (const p of [...this.sparks, ...this.smoke, ...this.trail]) {
      p.life = 0;
      p.mesh.setEnabled(false);
    }
  }

  /** Launch from the nose of the car. Returns false when out of ammo or already firing. */
  fire(player: Vehicle): boolean {
    if (this.ammo <= 0 || this.live) return false;
    const cfg = CONFIG.player.rocket;
    const f = forwardOf(player.heading);

    this.ammo--;
    this.live = true;
    this.travelled = 0;
    this.trailTimer = 0;
    this.heading = player.heading;
    // Spawn clear of our own bumper so it never detonates on the launching car.
    this.x = player.x + f.x * (player.params.halfLength + 1.6);
    this.z = player.z + f.z * (player.params.halfLength + 1.6);
    // Inherit the car's velocity so firing at speed feels connected to the car.
    this.vx = f.x * cfg.speed + player.vx;
    this.vz = f.z * cfg.speed + player.vz;

    this.mesh.setEnabled(true);
    return true;
  }

  /**
   * Advance the rocket and resolve detonation. Returns the blast when one happens so the
   * game can trigger shake, sound and HUD feedback.
   */
  update(
    dt: number,
    world: CollisionWorld,
    police: PoliceCar[],
    player: Vehicle,
    terrain?: Terrain,
  ): Detonation | null {
    this.advanceEffects(dt);
    if (!this.live) return null;

    const cfg = CONFIG.player.rocket;

    // --- Homing ------------------------------------------------------------
    const target = this.acquire(police);
    if (target) {
      const desired = Math.atan2(target.vehicle.x - this.x, target.vehicle.z - this.z);
      let err = desired - this.heading;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const turn = clamp(err, -cfg.homingTurnRate * dt, cfg.homingTurnRate * dt);
      this.heading += turn;
      const speed = Math.hypot(this.vx, this.vz);
      this.vx = Math.sin(this.heading) * speed;
      this.vz = Math.cos(this.heading) * speed;
    }

    const step = Math.hypot(this.vx * dt, this.vz * dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.travelled += step;

    // Fly at a fixed height above the ground so slopes do not swallow it or make it
    // sail over a target parked further down a hill.
    const groundY = terrain ? terrain.heightAt(this.x, this.z) : 0;
    this.mesh.position.set(this.x, groundY + cfg.cruiseHeight, this.z);
    this.mesh.rotation.y = this.heading;

    this.emitTrail(dt);

    const body = {
      x: this.x,
      z: this.z,
      halfLength: ROCKET_HALF_LENGTH,
      halfWidth: ROCKET_HALF_WIDTH,
      heading: this.heading,
    };

    for (const unit of police) {
      if (obbVsOBB(body, unit.vehicle.obb)) return this.detonate(police, player);
    }
    for (const solid of world.colliders) {
      // Rockets fly at car height, so they sail over anything they could jump.
      if (solid.topY < 1.2) continue;
      const dx = this.x - solid.obb.x;
      const dz = this.z - solid.obb.z;
      const range = ROCKET_HALF_LENGTH + solid.radius;
      if (dx * dx + dz * dz > range * range) continue;
      if (obbVsOBB(body, solid.obb)) return this.detonate(police, player);
    }
    if (this.travelled >= cfg.maxRange) return this.detonate(police, player);

    return null;
  }

  private emitTrail(dt: number): void {
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return;
    this.trailTimer = 0.02;

    const p = this.trail[this.trailCursor];
    this.trailCursor = (this.trailCursor + 1) % TRAIL_COUNT;
    p.mesh.position.copyFrom(this.mesh.position);
    p.mesh.scaling.setAll(1);
    p.vx = 0;
    p.vy = 1.5;
    p.vz = 0;
    p.maxLife = 0.32;
    p.life = p.maxLife;
    p.mesh.setEnabled(true);
  }

  /**
   * Pick a lock: the live unit closest to straight ahead, inside the cone and in range.
   * Preferring alignment over raw distance means it takes the car you were pointing at,
   * not whichever one happens to be nearest your flank.
   */
  private acquire(police: PoliceCar[]): PoliceCar | null {
    const cfg = CONFIG.player.rocket;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);

    let best: PoliceCar | null = null;
    let bestScore = -Infinity;
    for (const unit of police) {
      if (!unit.active || unit.destroyed) continue;
      const dx = unit.vehicle.x - this.x;
      const dz = unit.vehicle.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > cfg.homingRange || d < 0.5) continue;
      const align = (dx * fx + dz * fz) / d;
      if (align < Math.cos(cfg.homingCone)) continue;
      // Alignment dominates; distance only breaks ties between similar bearings.
      const score = align * 100 - d * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = unit;
      }
    }
    return best;
  }

  /** Radial impulse on everything nearby; wrecks anything close to the centre. */
  private detonate(police: PoliceCar[], player: Vehicle): Detonation {
    const cfg = CONFIG.player.rocket;
    this.live = false;
    this.mesh.setEnabled(false);

    /*
     * The particle layers ride on top of the mesh fireball and shockwave:
     * a white-hot flash, an ember ring with gravity, and a column of slow
     * smoke that outlives the fire the way smoke does.
     */
    const fx = FX.field;
    const blastY = this.mesh.position.y;
    if (fx) {
      fx.spawn({ x: this.x, y: blastY + 1.2, z: this.z, life: 0.14, size0: 7, size1: 12, r: 1.4, g: 1.25, b: 1.0, additive: true });
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + Math.random() * 0.5;
        const sp = 10 + Math.random() * 24;
        fx.spawn({
          x: this.x, y: blastY + 1 + Math.random() * 1.5, z: this.z,
          vx: Math.sin(a) * sp, vy: 6 + Math.random() * 14, vz: Math.cos(a) * sp,
          life: 0.5 + Math.random() * 0.5, size0: 0.55, size1: 0.12,
          r: 1.3, g: 0.7 + Math.random() * 0.3, b: 0.25, additive: true,
          gravity: -34, drag: 1.2,
        });
      }
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 5;
        fx.spawn({
          x: this.x + Math.sin(a) * 1.5, y: blastY + 1.5 + Math.random() * 2, z: this.z + Math.cos(a) * 1.5,
          vx: Math.sin(a) * sp, vy: 4.5 + Math.random() * 4, vz: Math.cos(a) * sp,
          life: 1.3 + Math.random() * 0.9, size0: 2.2, size1: 6.5,
          r: 0.16, g: 0.15, b: 0.15, alpha: 0.5, drag: 1.4,
        });
      }
    }

    let destroyed = 0;
    let thrown = 0;

    for (const unit of police) {
      const v = unit.vehicle;
      const dx = v.x - this.x;
      const dz = v.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > cfg.blastRadius) continue;

      // Linear falloff, and heavier vehicles are thrown proportionally less.
      const falloff = 1 - d / cfg.blastRadius;
      const push = (cfg.blastImpulse * falloff) / v.params.mass;
      const nx = d > 0.01 ? dx / d : 0;
      const nz = d > 0.01 ? dz / d : 1;
      v.applyImpulse(nx * push, nz * push);
      v.applySpin((Math.random() < 0.5 ? -1 : 1) * cfg.blastSpin * falloff);

      // The armoured classes take a near-direct hit to wreck; anything less staggers
      // them. Killing one with your single rocket should be a deliberate play, not a
      // side effect of aiming at the group they happen to be standing in.
      const armoured = { kill: cfg.killRadius, stun: cfg.policeDisableTime };

      const alreadyWrecked = unit.destroyed;
      if (d <= armoured.kill) {
        unit.destroy();
        if (!alreadyWrecked) destroyed++;
      } else if (!alreadyWrecked) {
        unit.disable(armoured.stun * falloff);
        thrown++;
      }
    }

    // The player feels the blast too, but only enough to be a nudge.
    const pdx = player.x - this.x;
    const pdz = player.z - this.z;
    const pd = Math.hypot(pdx, pdz);
    if (pd < cfg.blastRadius) {
      const falloff = 1 - pd / cfg.blastRadius;
      const push = cfg.blastImpulse * falloff * cfg.selfImpulseScale;
      const nx = pd > 0.01 ? pdx / pd : 0;
      const nz = pd > 0.01 ? pdz / pd : 1;
      player.applyImpulse(nx * push, nz * push);
    }

    this.spawnBlastEffects();
    return { x: this.x, z: this.z, destroyed, thrown };
  }

  private spawnBlastEffects(): void {
    const cfg = CONFIG.player.rocket;

    this.coreTime = cfg.flashTime;
    this.fireTime = cfg.fireballTime;
    this.shockTime = cfg.shockwaveTime;

    const blastY = this.mesh.position.y;
    this.core.position.set(this.x, blastY + 1.2, this.z);
    this.core.setEnabled(true);
    this.fireball.position.set(this.x, blastY + 1.4, this.z);
    this.fireball.setEnabled(true);
    // Ring hugs the road so the blast reads as having a footprint. A Babylon torus is
    // already built flat in XZ, so it needs no rotation — adding one stood it on edge.
    this.shockwave.position.set(this.x, blastY - 1.2, this.z);
    this.shockwave.setEnabled(true);

    for (let i = 0; i < SPARK_COUNT; i++) {
      const p = this.sparks[i];
      const angle = (i / SPARK_COUNT) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 22 + Math.random() * 26;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = 9 + Math.random() * 13;
      p.maxLife = cfg.sparkTime * (0.6 + Math.random() * 0.6);
      p.life = p.maxLife;
      p.mesh.position.set(this.x, blastY, this.z);
      p.mesh.scaling.setAll(1);
      p.mesh.setEnabled(true);
    }

    for (let i = 0; i < SMOKE_COUNT; i++) {
      const p = this.smoke[i];
      const angle = (i / SMOKE_COUNT) * Math.PI * 2;
      const speed = 3 + Math.random() * 5;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = 5 + Math.random() * 4;
      p.maxLife = cfg.smokeTime * (0.7 + Math.random() * 0.5);
      p.life = p.maxLife;
      p.mesh.position.set(this.x, blastY + 1, this.z);
      p.mesh.scaling.setAll(1.5);
      p.mesh.setEnabled(true);
    }
  }

  /** Drive every pooled visual forward. Runs whether or not a rocket is in flight. */
  private advanceEffects(dt: number): void {
    const cfg = CONFIG.player.rocket;

    const maxCore = cfg.blastRadius * cfg.coreScale;
    const maxFire = cfg.blastRadius * cfg.fireballScale;
    const maxShock = cfg.blastRadius * cfg.shockwaveScale;

    if (this.coreTime > 0) {
      this.coreTime = Math.max(0, this.coreTime - dt);
      const t = 1 - this.coreTime / cfg.flashTime;
      this.core.scaling.setAll(maxCore * (0.4 + t * 0.6));
      this.core.alpha = clamp(1 - t, 0, 1);
      if (this.coreTime === 0) this.core.setEnabled(false);
    }

    if (this.fireTime > 0) {
      this.fireTime = Math.max(0, this.fireTime - dt);
      const t = 1 - this.fireTime / cfg.fireballTime;
      // Fast expansion that eases out, so the shape "punches" then billows.
      const ease = 1 - Math.pow(1 - t, 3);
      this.fireball.scaling.setAll(maxFire * (0.3 + ease * 0.7));
      // Solid for the first half of its life, then fades. Blending it from the start
      // washed it out into the background instead of reading as a ball of fire.
      this.fireball.alpha = clamp(2.0 * (1 - t), 0, 1);
      this.fireball.color = [1, 0.45 - t * 0.3, 0.06];
      this.fireball.position.y = 2.4 + t * 3.5;
      if (this.fireTime === 0) this.fireball.setEnabled(false);
    }

    if (this.shockTime > 0) {
      this.shockTime = Math.max(0, this.shockTime - dt);
      const t = 1 - this.shockTime / cfg.shockwaveTime;
      const ease = 1 - Math.pow(1 - t, 2);
      const ring = maxShock * (0.15 + ease * 0.85);
      // Torus lies flat: X/Z are the ring radius, Y is its thickness.
      this.shockwave.scaling.set(ring, 1 + ease * 3, ring);
      this.shockwave.alpha = clamp(0.85 * (1 - t), 0, 1);
      if (this.shockTime === 0) this.shockwave.setEnabled(false);
    }

    // Debris: ballistic, bounces once off the road, shrinks out.
    for (const p of this.sparks) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vy -= 42 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      if (p.mesh.position.y < 0.3) {
        p.mesh.position.y = 0.3;
        p.vy = Math.abs(p.vy) * 0.35;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      const k = clamp(p.life / p.maxLife, 0, 1);
      p.mesh.scaling.setAll(0.2 + k * 0.9);
      if (p.life <= 0) p.mesh.setEnabled(false);
    }

    for (const p of this.smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vy *= 1 - 0.5 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vx *= 1 - 1.2 * dt;
      p.vz *= 1 - 1.2 * dt;
      const k = clamp(p.life / p.maxLife, 0, 1);
      p.mesh.scaling.setAll(1.2 + (1 - k) * 3.2);
      if (p.life <= 0) p.mesh.setEnabled(false);
    }

    // Trail puffs drift up and fade. Alpha is shared, so drive it from the newest puff.
    let brightest = 0;
    for (const p of this.trail) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.mesh.position.y += p.vy * dt;
      const k = clamp(p.life / p.maxLife, 0, 1);
      p.mesh.scaling.setAll(0.4 + (1 - k) * 1.6);
      brightest = Math.max(brightest, k);
      if (p.life <= 0) p.mesh.setEnabled(false);
    }
    for (const p of this.trail) p.mesh.alpha = 0.15 + brightest * 0.5;
  }
}
