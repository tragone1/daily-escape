/**
 * Collision resolution for the arcade model.
 *
 * Cars are pushed out of geometry along the minimum translation vector, then the velocity
 * component heading into the surface is removed (with a little bounce) while the sliding
 * component is preserved. That combination is what makes clipping a wall scrub speed and
 * nudge you straight rather than stopping you dead or launching you.
 *
 * Static geometry is oriented (so walls can follow a curving, sloping road) and has a
 * height. A car flying over a low barrier genuinely passes over it.
 */

import { CONFIG } from "../config";
import { clamp } from "../math";
import type { Vehicle } from "../vehicle/vehicle";
import type { OBB } from "./collision";
import { obbVsOBB, segmentVsOBB } from "./collision";
import { SpatialGrid } from "./spatialGrid";

export interface StaticCollider {
  obb: OBB;
  /** World Y of the top face. A car above this passes over instead of colliding. */
  topY: number;
  /** Broad-phase bounding radius around obb centre. */
  radius: number;
  /** Tall enough to block line of sight and the chase camera. */
  occludes: boolean;
}

export interface Impact {
  /** Closing speed along the contact normal, u/s. */
  speed: number;
  x: number;
  z: number;
  kind: "static" | "car";
}

/** 2D cross product; sign tells us which way an angled impact should rotate the car. */
function cross2(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/** Vertical slack before a car counts as "over" an obstacle. */
const CLEAR_MARGIN = 0.6;

/**
 * Slack added to broad-phase queries. The grid is exact for a static query — items are
 * bucketed by every cell their bounding circle touches — so this only has to cover how
 * far the two-pass push-out can shift a car after the query was taken.
 */
const CELL_MARGIN = 3;

export class CollisionWorld {
  readonly occluders: StaticCollider[];
  private readonly solidGrid: SpatialGrid<StaticCollider>;
  private readonly occluderGrid: SpatialGrid<StaticCollider>;
  /** Scratch buffers, reused so the per-frame collision work allocates nothing. */
  private readonly nearby: StaticCollider[] = [];
  private readonly nearbyRay: StaticCollider[] = [];
  private readonly nearbyPath: StaticCollider[] = [];

  constructor(readonly colliders: StaticCollider[]) {
    this.occluders = colliders.filter((c) => c.occludes);
    this.solidGrid = new SpatialGrid(colliders);
    this.occluderGrid = new SpatialGrid(this.occluders);
  }

  /**
   * Resolve a car against all static geometry. Two passes so inside corners (where two
   * pieces meet) settle instead of ping-ponging.
   */
  resolveStatic(v: Vehicle): Impact | null {
    const c = CONFIG.collision;
    const reach = v.params.halfLength + 1.0;
    let strongest: Impact | null = null;

    // One broad-phase query for both passes: the push-out never moves a car far enough
    // to bring a different collider into range.
    const candidates = this.solidGrid.queryCircle(v.x, v.z, reach + CELL_MARGIN, this.nearby);

    for (let pass = 0; pass < 2; pass++) {
      for (const solid of candidates) {
        // Airborne over a low obstacle: no contact at all.
        if (v.y > solid.topY - CLEAR_MARGIN) continue;

        const dx = v.x - solid.obb.x;
        const dz = v.z - solid.obb.z;
        const range = reach + solid.radius;
        if (dx * dx + dz * dz > range * range) continue;

        const hit = obbVsOBB(v.obb, solid.obb);
        if (!hit) continue;

        v.x += hit.nx * hit.depth;
        v.z += hit.nz * hit.depth;

        const vn = v.vx * hit.nx + v.vz * hit.nz;
        if (vn < 0) {
          const impactSpeed = -vn;

          // Split velocity into normal / tangential, then rebuild.
          const tx = v.vx - hit.nx * vn;
          const tz = v.vz - hit.nz * vn;
          const bounce = -vn * c.restitution;
          v.vx = tx * c.wallFriction + hit.nx * bounce;
          v.vz = tz * c.wallFriction + hit.nz * bounce;

          // Glancing blows turn the car to run along the wall.
          const fwdX = Math.sin(v.heading);
          const fwdZ = Math.cos(v.heading);
          const align = cross2(fwdX, fwdZ, hit.nx, hit.nz);
          v.applySpin(clamp(-align * impactSpeed * c.spinFactor, -c.maxSpin, c.maxSpin));

          const severity = clamp(impactSpeed / v.params.maxSpeed, 0, 1);
          const keep = 1 - c.buildingSpeedLoss * severity * v.impactResistance;
          v.vx *= keep;
          v.vz *= keep;

          if (pass === 0 && impactSpeed > c.minImpactSpeed) {
            if (!strongest || impactSpeed > strongest.speed) {
              strongest = { speed: impactSpeed, x: v.x, z: v.z, kind: "static" };
            }
          }
        }
      }
    }

    return strongest;
  }

  /** Resolve two cars against each other, mass-weighted. */
  resolveCars(a: Vehicle, b: Vehicle): Impact | null {
    const c = CONFIG.collision;
    // Cars at very different heights (one mid-jump) do not touch.
    if (Math.abs(a.y - b.y) > 2.4) return null;

    const hit = obbVsOBB(a.obb, b.obb);
    if (!hit) return null;

    // A boosting player barges: whatever they are hitting keeps only a fraction of its
    // mass for the exchange, which is what makes a parked roadblock answerable.
    const aBarge = a.isPolice ? 1 : a.boosting ? c.boostBargeScale : 1;
    const bBarge = b.isPolice ? 1 : b.boosting ? c.boostBargeScale : 1;
    const ma = a.params.mass * a.pushResistance * bBarge;
    const mb = b.params.mass * b.pushResistance * aBarge;
    const total = ma + mb;
    // Lighter car gets moved more.
    const shareA = mb / total;
    const shareB = ma / total;

    a.x += hit.nx * hit.depth * shareA;
    a.z += hit.nz * hit.depth * shareA;
    b.x -= hit.nx * hit.depth * shareB;
    b.z -= hit.nz * hit.depth * shareB;

    const rvx = a.vx - b.vx;
    const rvz = a.vz - b.vz;
    const vn = rvx * hit.nx + rvz * hit.nz;

    // A fixed extra shove on top of the elastic response, so contact always reads as
    // a hit even when both cars are travelling at similar speeds — heavily damped when
    // it is one police car hitting another, so a charging juggernaut cannot blow its own
    // squad off you and hand the player the gap it was sent to close.
    const friendly = a.isPolice && b.isPolice;
    /*
     * Settle rather than ricochet once the player has stopped.
     *
     * The fixed shove is there so contact during a chase reads as forceful; against a
     * stationary player it just scatters the ring the squad has built. Damping it - and
     * the bounce with it - is what lets a pin actually hold.
     */
    const player = a.isPolice ? (b.isPolice ? null : b) : a;
    const settling = player !== null && player.speed < c.pinSettleSpeed;
    const shove =
      c.carImpulse *
      Math.max(a.contactBoost, b.contactBoost) *
      (friendly ? c.policeImpulseScale : 1) *
      (settling ? c.pinShoveScale : 1);
    const bounce = settling ? c.pinRestitution : c.restitution;
    if (vn < 0) {
      const j = (-vn * (1 + bounce) + shove) / total;
      a.vx += hit.nx * j * mb;
      a.vz += hit.nz * j * mb;
      b.vx -= hit.nx * j * ma;
      b.vz -= hit.nz * j * ma;

      const impactSpeed = -vn;
      const severity = clamp(impactSpeed / a.params.maxSpeed, 0, 1);
      const keepA = 1 - c.carSpeedLoss * severity * a.impactResistance;
      a.vx *= keepA;
      a.vz *= keepA;

      const spin = clamp(
        cross2(Math.sin(a.heading), Math.cos(a.heading), hit.nx, hit.nz) *
          impactSpeed *
          c.spinFactor *
          0.8,
        -c.maxSpin,
        c.maxSpin,
      );
      a.applySpin(-spin * a.impactResistance);
      b.applySpin(spin * 0.6);

      if (impactSpeed > c.minImpactSpeed) {
        return {
          speed: impactSpeed,
          x: (a.x + b.x) / 2,
          z: (a.z + b.z) / 2,
          kind: "car",
        };
      }
    } else {
      // Already separating but still overlapping — just push apart gently.
      const j = shove * 0.3;
      a.vx += hit.nx * j * shareA;
      a.vz += hit.nz * j * shareA;
      b.vx -= hit.nx * j * shareB;
      b.vz -= hit.nz * j * shareB;
    }

    return null;
  }

  /** True when nothing tall blocks the straight line between two points. */
  lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    const candidates = this.occluderGrid.query(
      Math.min(x0, x1),
      Math.min(z0, z1),
      Math.max(x0, x1),
      Math.max(z0, z1),
      this.nearbyRay,
    );
    for (const solid of candidates) {
      if (segmentVsOBB(x0, z0, x1, z1, solid.obb) !== null) return false;
    }
    return true;
  }

  /**
   * Distance along a ray before it hits something, capped at `maxDist`.
   * Used to keep the chase camera out of walls and to steer police away from geometry.
   */
  raycastDistance(x0: number, z0: number, dx: number, dz: number, maxDist: number): number {
    const x1 = x0 + dx * maxDist;
    const z1 = z0 + dz * maxDist;
    let best = maxDist;
    const candidates = this.occluderGrid.query(
      Math.min(x0, x1),
      Math.min(z0, z1),
      Math.max(x0, x1),
      Math.max(z0, z1),
      this.nearbyRay,
    );
    for (const solid of candidates) {
      const t = segmentVsOBB(x0, z0, x1, z1, solid.obb);
      if (t !== null && t * maxDist < best) best = t * maxDist;
    }
    return best;
  }

  /**
   * Distance to the first solid thing along a ray, capped at `maxDist`.
   *
   * Against *solid* colliders rather than tall occluders, because the question this
   * answers is "how much room is there to drive through here", and a guard rail is very
   * much in the way of that while being invisible to line-of-sight.
   */
  raySolid(x0: number, z0: number, dx: number, dz: number, maxDist: number, carHeight = 1.1): number {
    const x1 = x0 + dx * maxDist;
    const z1 = z0 + dz * maxDist;
    let best = maxDist;
    const candidates = this.solidGrid.query(
      Math.min(x0, x1),
      Math.min(z0, z1),
      Math.max(x0, x1),
      Math.max(z0, z1),
      this.nearbyPath,
    );
    for (const solid of candidates) {
      if (solid.topY < carHeight) continue;
      const t = segmentVsOBB(x0, z0, x1, z1, solid.obb);
      if (t !== null && t * maxDist < best) best = t * maxDist;
    }
    return best;
  }

  /**
   * How much driveable room there is across the road at a point — the gap between the
   * first solid thing to the left and the first to the right.
   *
   * This is what "tight" actually means, and it is a local property: a section's nominal
   * width barely varies along its length, but junction caps, props, spur mouths and the
   * inside of a bend all pinch the real gap. Scouting on nominal width picked spots no
   * better than at random; scouting on this picks the pinch points.
   */
  freeWidth(x: number, z: number, heading: number, maxDist = 70): number {
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);
    return this.raySolid(x, z, rx, rz, maxDist) + this.raySolid(x, z, -rx, -rz, maxDist);
  }

  /**
   * Can a car actually drive from A to B, or is there something solid across the line?
   *
   * Distinct from `lineOfSight`, which only considers tall occluders — a guard rail is
   * two units high, so it blocks a car completely while blocking sight not at all. That
   * gap is what let police spawn in the run-off on the far side of a rail: the spot was
   * clear, the player was visible, and the unit spent the whole encounter driving into a
   * fence. This is the test that question actually needed.
   */
  canReach(x0: number, z0: number, x1: number, z1: number, carHeight = 1.1): boolean {
    const candidates = this.solidGrid.query(
      Math.min(x0, x1),
      Math.min(z0, z1),
      Math.max(x0, x1),
      Math.max(z0, z1),
      this.nearbyPath,
    );
    for (const solid of candidates) {
      // Kerbs and low debris are driveable over; anything taller is a wall to this car.
      if (solid.topY < carHeight) continue;
      if (segmentVsOBB(x0, z0, x1, z1, solid.obb) !== null) return false;
    }
    return true;
  }

  /** Nearest free spot for a respawn: true when nothing solid is within `radius`. */
  isClear(x: number, z: number, radius: number): boolean {
    for (const solid of this.solidGrid.queryCircle(x, z, radius + CELL_MARGIN, this.nearby)) {
      const dx = x - solid.obb.x;
      const dz = z - solid.obb.z;
      const range = radius + solid.radius;
      if (dx * dx + dz * dz > range * range) continue;
      const probe: OBB = { x, z, halfLength: radius, halfWidth: radius, heading: 0 };
      if (obbVsOBB(probe, solid.obb)) return false;
    }
    return true;
  }
}
