/**
 * Elevated third-person chase camera.
 *
 * Two details do most of the work:
 *  1. The camera orbits a *smoothed* heading rather than the car's live heading. A
 *     collision spin or a hard drift therefore does not whip the view around.
 *  2. The rig position is damped with a frame-rate independent factor, and pushed
 *     forward when a building would come between the camera and the car.
 */

import { Vec3 } from "../gfx/math3d";
import type { Renderer } from "../gfx/renderer";

import { CONFIG } from "../config";
import { clamp, damp, forwardOf, wrapAngle } from "../math";
import type { CollisionWorld } from "../physics/collisionWorld";
import type { Terrain } from "../world/terrain";
import type { Vehicle } from "../vehicle/vehicle";

export class ChaseCamera {
  private heading = 0;
  private pos = new Vec3();
  private target = new Vec3();
  private shake = 0;
  private shakeSeed = Math.random() * 100;

  constructor(
    private renderer: Renderer,
    private world: CollisionWorld,
    private terrain: Terrain,
  ) {
    renderer.camera.fov = CONFIG.camera.fov;
  }

  /** Snap straight behind the car — used on spawn and on the manual reset key. */
  reset(vehicle: Vehicle): void {
    this.heading = vehicle.heading;
    this.shake = 0;
    const desired = this.desiredPosition(vehicle);
    this.pos.copyFrom(desired);
    this.target.copyFrom(this.desiredTarget(vehicle));
    this.renderer.camera.position.copyFrom(this.pos);
    this.renderer.camera.target.copyFrom(this.target);
  }

  addShake(amount: number): void {
    this.shake = Math.min(CONFIG.camera.maxShake, this.shake + amount);
  }

  private desiredTarget(vehicle: Vehicle): Vec3 {
    const c = CONFIG.camera;
    const f = forwardOf(vehicle.heading);
    // Look further up the road the faster you go, so fast sections read earlier.
    const speedRatio = clamp(vehicle.speed / vehicle.params.maxSpeed, 0, 1);
    const ahead = c.lookAhead + c.lookAheadPerSpeed * speedRatio;
    return new Vec3(vehicle.x + f.x * ahead, vehicle.y + c.lookHeight, vehicle.z + f.z * ahead);
  }

  private desiredPosition(vehicle: Vehicle): Vec3 {
    const c = CONFIG.camera;
    const speedRatio = clamp(vehicle.speed / vehicle.params.maxSpeed, 0, 1);
    const back = c.distance + c.speedPullback * speedRatio;
    const f = forwardOf(this.heading);

    let px = vehicle.x - f.x * back;
    let pz = vehicle.z - f.z * back;

    // Pull in if a building would occlude the car.
    const dx = px - vehicle.x;
    const dz = pz - vehicle.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.001) {
      const hit = this.world.raycastDistance(vehicle.x, vehicle.z, dx / len, dz / len, len);
      if (hit < len) {
        const safe = Math.max(4, hit - c.wallPadding);
        px = vehicle.x + (dx / len) * safe;
        pz = vehicle.z + (dz / len) * safe;
      }
    }

    // Ride with the terrain, and rise a little on big jumps to keep the car framed.
    const lift = vehicle.airborne ? c.airLift : 0;
    // Slopes are the reason this is not simply car height + offset. Behind the car the
    // ground is higher on a descent and lower on a climb, so the rig has to clear the
    // terrain under *itself* or it skims the road and loses sight of the car entirely.
    const groundBehind = this.terrain.heightAt(px, pz);
    const y = Math.max(vehicle.y + c.height + lift, groundBehind + c.slopeClearance);
    return new Vec3(px, y, pz);
  }

  update(vehicle: Vehicle, dt: number): void {
    const c = CONFIG.camera;

    // Ease the orbit heading toward the car's heading along the shortest arc.
    this.heading += wrapAngle(vehicle.heading - this.heading) * damp(c.headingDamp, dt);

    const desiredPos = this.desiredPosition(vehicle);
    const desiredTarget = this.desiredTarget(vehicle);

    const kp = damp(c.positionDamp, dt);
    const kt = damp(c.targetDamp, dt);
    this.pos.lerpTo(desiredPos, kp);
    this.target.lerpTo(desiredTarget, kt);
    this.pos.y = Math.max(vehicle.y + c.minHeight, this.pos.y);

    // Shake is applied on top of the smoothed rig so it never accumulates.
    this.shake = Math.max(0, this.shake - c.shakeDecay * dt * (0.4 + this.shake));
    let ox = 0;
    let oy = 0;
    if (this.shake > 0.001) {
      this.shakeSeed += dt * 47;
      ox = Math.sin(this.shakeSeed * 1.7) * this.shake;
      oy = Math.sin(this.shakeSeed * 2.3 + 1.1) * this.shake * 0.7;
    }

    this.renderer.camera.position.set(this.pos.x + ox, this.pos.y + oy, this.pos.z);
    this.renderer.camera.target.copyFrom(this.target);

    /*
     * Speed is a lens, not just a number. The field of view opens with pace -
     * a few degrees between walking and flat out - and kicks wider under
     * boost, which is most of why boost FEELS like ignition rather than a
     * stat change. The lean is one more whisper: a degree and a half of roll
     * into a hard corner, from the same smoothed input the body uses, so the
     * horizon banks with you and never twitches.
     */
    const speedRatio = clamp(vehicle.speed / vehicle.params.maxSpeed, 0, 1);
    const boostT = vehicle.boosting ? 1 : 0;
    const fovTarget = c.fov + speedRatio * speedRatio * 0.1 + c.fovBoostBonus * boostT;
    this.renderer.camera.fov += (fovTarget - this.renderer.camera.fov) * damp(6, dt);

    const rollTarget = vehicle.airborne ? 0 : -vehicle.leanRoll * 0.028 * speedRatio;
    this.renderer.camera.roll += (rollTarget - this.renderer.camera.roll) * damp(5, dt);
  }
}
