/**
 * Arcade vehicle simulation — shared by the player and every police car.
 *
 * The model is deliberately not a rigid-body sim. Velocity is stored in world space and
 * decomposed into forward/lateral components each step; the lateral component is damped
 * by a "grip" coefficient, which is what rotates the velocity vector toward the car's
 * heading. High grip = planted, low grip = the rear end steps out.
 *
 * Elevation is bolted on the same way: a single ground height sampled from the course,
 * a gradient term that adds or removes forward speed on slopes, and an explicit ramp
 * launch. There is no rigid body and no torque, so the car cannot flip, tumble or land
 * on its roof no matter how big the jump is.
 *
 * All integration is frame-rate independent (exponential damping, dt-scaled forces).
 */

import { CONFIG, type VehicleParams } from "../config";
import type { OBB } from "../physics/collision";
import { clamp, damp, forwardOf, length, rightOf } from "../math";
import type { Terrain } from "../world/terrain";
import type { Surface } from "../world/course";

export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 — brakes while moving forward, reverses once stopped. */
  brake: number;
  /** -1..1 */
  steer: number;
  /** Edge-triggered request to fire the boost. */
  boost: boolean;
}

export interface BoostParams {
  accel: number;
  maxSpeedBonus: number;
  duration: number;
  cooldown: number;
}

export class Vehicle {
  x = 0;
  z = 0;
  /** Ground height, or altitude while airborne. */
  y = 0;
  heading = 0;

  /** World-space horizontal velocity. */
  vx = 0;
  vz = 0;
  /** Vertical velocity; only non-zero while airborne. */
  vy = 0;
  airborne = false;

  /** Set for one frame on touchdown, with the vertical speed of the impact. */
  justLanded = false;
  landingImpact = 0;
  /** Set for one frame when a ramp launches the car. */
  justLaunched = false;

  /** Surface currently under the wheels, for HUD/audio/FX. */
  surface: Surface = "asphalt";
  /** True while past the course boundary, in the wasteland. */
  offCourse = false;
  /**
   * Police, rather than the player. Two things hang off it.
   *
   * The wasteland penalty does not apply to them: it exists to stop the player using the
   * black as an escape hatch, and applying it to the pursuit as well simply moved the
   * stalemate outside the barriers — everyone crawled, so leaving cost nothing.
   *
   * And contact between two of them is heavily damped, so the heaviest units in the game
   * stop scattering their own side every time they arrive.
   */
  isPolice = false;

  restraint = 1;
  /** Rise per unit travelled forward: positive uphill, negative downhill. */
  climb = 0;
  /** Rise per unit travelled to the right — the cross-slope the car sits across. */
  bank = 0;

  /** Smoothed steering input, so tapping a key does not snap the wheels. */
  steerInput = 0;
  /** Transient yaw from impacts, rad/s. Decays quickly so hits do not become spins. */
  yawRate = 0;

  boostTime = 0;
  boostCooldown = 0;
  /** Set for one frame when a boost fires, so the game can react (shake, sound, FX). */
  boostFired = false;

  /** Lateral slip in u/s, exposed for drift smoke/audio and body lean. */
  slip = 0;

  /** Smoothed cosmetic body angles, consumed by the view. */
  leanRoll = 0;
  leanPitch = 0;

  /**
   * Collision modifiers. Heavy police and the shield power-up tune these rather than
   * touching the collision solver, so every vehicle keeps using one code path.
   * `impactResistance` scales speed lost per hit, `pushResistance` scales effective mass
   * when being shoved, `contactBoost` scales the shove this vehicle delivers, and
   * `broadsideBoost` replaces it on hits that land across the player's flank.
   */
  impactResistance = 1;
  pushResistance = 1;
  contactBoost = 1;
  /** Seconds of post-impact recovery left; throttle pulls harder while it runs. */
  recoveryTimer = 0;
  /** Flat top-speed addition from late-run pace scaling (player only). */
  paceBonus = 0;
  /** Acceleration multiplier from the late-run switch (player only). */
  paceAccel = 1;
  /** Striking juggernaut: police in its path take full, undamped impulses. */
  plow = false;
  /**
   * Jammed against the wall mid-pin: this body is machinery, not a car. Infinite
   * effective mass, zero restitution against it - whatever it holds, stays held.
   */
  jam = false;
  /**
   * Shove multiplier for a T-bone, used instead of `contactBoost` when this vehicle hits
   * a player square in the side. Separate because the two hits do opposite things: a
   * nose-to-tail shove hands the player speed down the road, a broadside carries them
   * across it into the scenery.
   */
  broadsideBoost = 1;

  /**
   * Tyre condition, as multipliers on grip and pace. Police deployables drive these down
   * and ease them back to 1 as the damage wears off.
   *
   * These sit *outside* the boost bypass on purpose. Boost is the answer to terrain, and
   * making it the answer to spike strips as well would leave the squad's only ranged
   * weapon meaning nothing to anyone holding a charge.
   */
  tireGrip = 1;
  tireSpeed = 1;

  /**
   * Pursuit multiplier on top speed and acceleration. Police only: the driving layer
   * raises it for units that have been left behind and while a charge is committed.
   */
  drive = 1;

  constructor(
    public params: VehicleParams,
    private boostParams: BoostParams | null = null,
  ) {}

  get speed(): number {
    return length(this.vx, this.vz);
  }

  get forwardSpeed(): number {
    const f = forwardOf(this.heading);
    return this.vx * f.x + this.vz * f.z;
  }

  get obb(): OBB {
    return {
      x: this.x,
      z: this.z,
      halfLength: this.params.halfLength,
      halfWidth: this.params.halfWidth,
      heading: this.heading,
    };
  }

  get boosting(): boolean {
    return this.boostTime > 0;
  }

  /** 0..1 readiness for the HUD bar. */
  get boostCharge(): number {
    if (!this.boostParams) return 0;
    if (this.boostTime > 0) return this.boostTime / this.boostParams.duration;
    if (this.boostCooldown <= 0) return 1;
    return 1 - this.boostCooldown / this.boostParams.cooldown;
  }

  reset(x: number, z: number, heading: number, y = 0): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.heading = heading;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.airborne = false;
    this.justLanded = false;
    this.justLaunched = false;
    this.landingImpact = 0;
    this.steerInput = 0;
    this.yawRate = 0;
    this.boostTime = 0;
    this.boostCooldown = 0;
    this.boostFired = false;
    this.recoveryTimer = 0;
    this.slip = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.climb = 0;
    this.bank = 0;
    this.surface = "asphalt";
    this.offCourse = false;
    this.tireGrip = 1;
    this.tireSpeed = 1;
    this.drive = 1;
  }

  /** External shove (collisions, explosions). */
  applyImpulse(ix: number, iz: number): void {
    this.vx += ix;
    this.vz += iz;
  }

  applySpin(rate: number): void {
    this.yawRate = clamp(this.yawRate + rate, -4, 4);
  }

  update(input: VehicleInput, dt: number, terrain: Terrain): void {
    const p = this.params;
    const t = CONFIG.terrain;
    this.boostFired = false;
    this.justLanded = false;
    this.justLaunched = false;
    this.recoveryTimer = Math.max(0, this.recoveryTimer - dt);

    const ground = terrain.sample(this.x, this.z);
    const raw = t.surfaces[ground.surface];
    this.surface = ground.surface;
    this.offCourse = !ground.onCourse;

    // --- Boost timers ------------------------------------------------------
    let boostAccel = 0;
    if (this.boostParams) {
      const bp = this.boostParams;
      if (input.boost && this.boostTime <= 0 && this.boostCooldown <= 0) {
        this.boostTime = bp.duration;
        this.boostFired = true;
      }
      if (this.boostTime > 0) {
        this.boostTime = Math.max(0, this.boostTime - dt);
        boostAccel = bp.accel;
        if (this.boostTime === 0) this.boostCooldown = bp.cooldown;
      } else if (this.boostCooldown > 0) {
        this.boostCooldown = Math.max(0, this.boostCooldown - dt);
      }
    }

    /*
     * Boost is the answer to terrain, not a generic speed button.
     *
     * While it burns, the surface's penalties are pulled most of the way back toward
     * asphalt and gravity's bite on a climb is cut. That gives it specific moments worth
     * saving it for — dragging through the mud, cresting the big hill, carrying speed
     * into a kicker — instead of being something you mash whenever the meter is full.
     */
    const bypass = this.boostTime > 0 ? t.boostTerrainBypass : 0;
    const toward1 = (v: number) => v + (1 - v) * bypass;
    const surf = {
      grip: toward1(raw.grip),
      drag: toward1(raw.drag),
      maxSpeed: toward1(raw.maxSpeed),
      accel: toward1(raw.accel),
    };
    /*
     * Off the course entirely. Applied after the bypass above, so boost cannot cancel it:
     * the wasteland is not a surface you can power through, it is somewhere you should
     * not be. Tyre damage is outside the bypass for the same reason.
     */
    if (this.offCourse && !this.isPolice) {
      const off = t.offCourse;
      surf.grip *= off.grip;
      surf.drag *= off.drag;
      surf.accel *= off.accel;
      surf.maxSpeed *= off.maxSpeed;
    }

    /*
     * Boost claws back part of any tyre damage. The strip still costs you dearly, but
     * spending the charge to drag yourself out from under one is a real option rather
     * than a rounding error.
     */
    const tyre =
      this.boostTime > 0 && this.boostParams
        ? this.tireSpeed + (1 - this.tireSpeed) * CONFIG.player.boost.damageBypass
        : this.tireSpeed;

    let maxSpeed = (p.maxSpeed + this.paceBonus) * surf.maxSpeed;
    if (this.boostTime > 0 && this.boostParams) maxSpeed += this.boostParams.maxSpeedBonus;
    maxSpeed *= tyre * this.drive;

    // --- Steering ----------------------------------------------------------
    this.steerInput += (clamp(input.steer, -1, 1) - this.steerInput) * damp(p.steerInputResponse, dt);

    const oldForward = forwardOf(this.heading);
    const forwardSpeedBefore = this.vx * oldForward.x + this.vz * oldForward.z;
    const absSpeed = Math.abs(forwardSpeedBefore);

    // Steering authority ramps in with speed (you cannot pivot on the spot) but never
    // vanishes at a crawl, and tapers at top speed so the car stays stable flat out.
    const speedAuthority = 1 - Math.exp(-absSpeed / p.steerSpeedRef);
    const highSpeedTaper = 1 - (1 - p.steerHighSpeedRetain) * clamp(absSpeed / p.maxSpeed, 0, 1);
    const reverseSign = forwardSpeedBefore < -0.5 ? -1 : 1;
    // Mid-air you get a little authority to straighten up for the landing, not enough
    // to steer the jump.
    const airFactor = this.airborne ? t.airSteerFactor : 1;

    this.heading +=
      (this.steerInput * p.steerRateMax * speedAuthority * highSpeedTaper * reverseSign * airFactor +
        this.yawRate) *
      dt;
    this.yawRate *= Math.exp(-7 * dt);

    // --- Re-decompose against the new heading ------------------------------
    const fwd = forwardOf(this.heading);
    const right = rightOf(this.heading);
    let vf = this.vx * fwd.x + this.vz * fwd.z;
    let vl = this.vx * right.x + this.vz * right.z;

    // Rise per unit travelled forward. Positive climbing, negative descending.
    this.climb = ground.gradX * fwd.x + ground.gradZ * fwd.z;
    this.bank = ground.gradX * right.x + ground.gradZ * right.z;

    if (!this.airborne) {
      // --- Engine, brakes, reverse -----------------------------------------
      if (input.throttle > 0) {
        // Full power up to ~half the speed range, then taper into the top end.
        const headroom = clamp((1 - vf / maxSpeed) * 1.9, 0, 1);
        const recovering = this.recoveryTimer > 0 ? CONFIG.player.recovery.accelBoost : 1;
        vf +=
          (p.accel * surf.accel * input.throttle + boostAccel) *
          tyre *
          this.drive *
          headroom *
          recovering *
          this.paceAccel *
          dt;
      }

      if (input.brake > 0) {
        if (vf > 0.5) {
          vf = Math.max(0, vf - p.brakeDecel * input.brake * dt);
        } else {
          vf = Math.max(-p.maxReverseSpeed, vf - p.reverseAccel * input.brake * dt);
        }
      }

      // Gravity along the slope. This is the whole hill system: climbing bleeds speed,
      // descending gives it back, and boost is what buys you a steep climb.
      const climbRelief = this.climb > 0 ? 1 - t.boostSlopeAssist * bypass : 1;
      vf -= t.slopeAccel * this.climb * climbRelief * dt;

      // Coast-down when off the throttle, plus a constant rolling drag that gives the car
      // a sense of mass. Loose surfaces multiply both.
      if (input.throttle <= 0 && input.brake <= 0) {
        vf *= Math.exp(-p.engineDrag * surf.drag * dt);
      }
      const rolling = p.rollingResistance * surf.drag * dt;
      if (vf > 0) vf = Math.max(0, vf - rolling);
      else if (vf < 0) vf = Math.min(0, vf + rolling);

      vf = this.easeToLimit(vf, maxSpeed, p.maxReverseSpeed, dt);

      // --- Grip / drift ------------------------------------------------------
      const hardTurn = Math.abs(this.steerInput) > p.driftSteerThreshold;
      const fastEnough = absSpeed > p.driftSpeedThreshold;
      const base = hardTurn && fastEnough ? p.gripDrift : p.gripNormal;
      vl *= Math.exp(-base * surf.grip * this.tireGrip * dt);
    } else {
      // Airborne: no traction, no engine. Momentum carries the jump.
      vf = this.easeToLimit(vf, maxSpeed + 10, p.maxReverseSpeed, dt);
    }

    /*
     * Oil brings the car round.
     *
     * Grip alone only makes it understeer in a straightish line. Converting some of the
     * sideways slide into yaw is what lets it actually spin, so driving hard - or
     * boosting - on a slick has a genuine worst case rather than just being vague.
     */
    if (this.tireGrip < 0.2 && !this.airborne) {
      const oil = CONFIG.police.hazards.oil;
      const bite = 1 - this.tireGrip / 0.2;
      // Two sources: the slide itself, and how hard you are asking the car to turn. The
      // second is what makes a slick punish aggression rather than merely existing.
      const fromSlide = vl * oil.spinPerSlip;
      const fromSteer = this.steerInput * oil.spinPerSteer * Math.min(1, absSpeed / 18);
      this.yawRate = clamp(
        this.yawRate + (fromSlide + fromSteer) * bite * dt,
        -oil.maxSpin,
        oil.maxSpin,
      );
    }

    this.slip = vl;

    // --- Recompose and integrate -------------------------------------------
    const prevX = this.x;
    const prevZ = this.z;
    this.vx = fwd.x * vf + right.x * vl;
    this.vz = fwd.z * vf + right.z * vl;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    this.updateVertical(dt, terrain, prevX, prevZ, vf);

    // --- Cosmetic body attitude -------------------------------------------
    const speedRatio = clamp(absSpeed / p.maxSpeed, 0, 1);
    const rollTarget = -this.steerInput * speedRatio;
    // Nose lifts under power and on climbs, dips under braking and on descents.
    const pitchTarget = this.airborne
      ? clamp(this.vy * 0.03, -1, 1)
      : clamp((input.throttle - input.brake * 1.4) * 0.6 - this.climb * 1.6, -1, 1);
    const k = damp(7, dt);
    this.leanRoll += (rollTarget - this.leanRoll) * k;
    this.leanPitch += (pitchTarget - this.leanPitch) * k;
  }

  /**
   * Hold forward speed inside the engine's range — but as a ceiling the car settles back
   * to, not a wall it is snapped against.
   *
   * The difference matters entirely because of external impulses. A hard clamp deleted a
   * rocket blast's forward and backward components on the frame they were applied, so a
   * detonation could throw a car sideways and nowhere else, and wrecks slumped in place
   * as obstacles. Easing lets the blast land and then bleed away.
   */
  private easeToLimit(vf: number, maxSpeed: number, maxReverse: number, dt: number): number {
    const t = CONFIG.terrain;
    // Damaged tyres bleed the excess away fast; an undamaged car coasts down gently so a
    // blast or a heavy ram still carries.
    const rate = this.tireSpeed < 0.99 ? t.damagedOverspeedDecay : t.overspeedDecay;
    const decay = Math.exp(-rate * dt);
    if (vf > maxSpeed) return maxSpeed + (vf - maxSpeed) * decay;
    if (vf < -maxReverse) return -maxReverse + (vf + maxReverse) * decay;
    return vf;
  }

  /** Ramp launches, gravity and touchdown. */
  private updateVertical(
    dt: number,
    terrain: Terrain,
    prevX: number,
    prevZ: number,
    forwardSpeed: number,
  ): void {
    const t = CONFIG.terrain;
    const groundHere = terrain.heightAt(this.x, this.z);

    if (!this.airborne) {
      const launch = terrain.checkLaunch(
        prevX,
        prevZ,
        this.x,
        this.z,
        forwardSpeed,
        t.minLaunchSpeed,
      );
      if (launch > 0) {
        this.airborne = true;
        // Boosting into the lip is the difference between a hop and a jump.
        const boosted = this.boostTime > 0 ? t.boostLaunchBonus : 1;
        this.vy = Math.min(launch * boosted, t.maxLaunchSpeed);
        this.y = groundHere;
        this.justLaunched = true;
        return;
      }
      // Glued to the road otherwise; crests do not fling you unless they are ramps.
      this.y = groundHere;
      this.vy = 0;
      return;
    }

    this.vy -= t.gravity * dt;
    this.y += this.vy * dt;

    if (this.y <= groundHere) {
      const impact = Math.max(0, -this.vy);
      this.y = groundHere;
      this.vy = 0;
      this.airborne = false;
      this.justLanded = true;
      this.landingImpact = impact;

      // Landing scrubs speed in proportion to how hard you hit, but never enough to
      // stop the car — a jump should cost you tempo, not the run.
      const loss = clamp(impact * t.landing.speedLossPerVy, 0, t.landing.maxSpeedLoss);
      this.vx *= 1 - loss;
      this.vz *= 1 - loss;
      // A hard landing also kicks the car slightly off line.
      this.applySpin(clamp(impact * 0.012, 0, 0.7) * (this.slip >= 0 ? 1 : -1));
    }
  }
}
