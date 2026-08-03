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
import { clamp, rightOf } from "../math";
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
  /** Which builder placed it. Diagnostic: it is what makes a choke traceable. */
  source?: string;
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

    /*
     * SLIDE, DO NOT SNAG.
     *
     * Position is resolved against every collider - a car may never end up
     * inside geometry - but the VELOCITY response is applied once, from the
     * deepest contact of the frame. It used to run per collider per pass, and
     * wall chunks deliberately overlap at their joints, so brushing a seam
     * charged the tangential friction four times over: 0.82^4 is a 55% speed
     * cut for touching a wall you were already sliding along. That was the
     * snag - not the geometry, the bookkeeping.
     */
    let deepest = 0;
    let hnx = 0;
    let hnz = 0;
    // Widest angle between contact normals this frame: near zero along a flat
    // wall, large in a genuine corner. It decides whether being stuck is the
    // geometry catching the car or the car having driven into a trap.
    let firstNx = 0;
    let firstNz = 0;
    let normalSpread = 0;
    let sumNx = 0;
    let sumNz = 0;

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

        if (hit.depth >= deepest) {
          deepest = hit.depth;
          hnx = hit.nx;
          hnz = hit.nz;
        }
        // Depth-weighted average of every contact normal this frame. A wall
        // built from many small pieces gives a different normal per piece;
        // averaging them recovers the direction the SURFACE actually faces,
        // so a toothed barrier answers like the smooth wall it approximates.
        if (pass === 0) {
          sumNx += hit.nx * hit.depth;
          sumNz += hit.nz * hit.depth;
        }
        if (pass === 0) {
          if (firstNx === 0 && firstNz === 0) {
            firstNx = hit.nx;
            firstNz = hit.nz;
          } else {
            const dot = clamp(firstNx * hit.nx + firstNz * hit.nz, -1, 1);
            normalSpread = Math.max(normalSpread, Math.acos(dot));
          }
        }
      }
    }

    if (deepest > 0) {
      // Respond to the averaged surface direction rather than to whichever
      // single piece happened to be deepest.
      const sumLen = Math.hypot(sumNx, sumNz);
      if (sumLen > 0.0001) {
        hnx = sumNx / sumLen;
        hnz = sumNz / sumLen;
      }
      const vn = v.vx * hnx + v.vz * hnz;
      if (vn < 0) {
        const impactSpeed = -vn;
        const speed = Math.hypot(v.vx, v.vz) || 1;

        /*
         * Friction scales with how square the contact is. Running along a
         * wall barely loses anything; driving into one still costs. A flat
         * multiplier treated a graze and a head-on the same, which is why
         * hugging a barrier bled speed until the car stopped.
         */
        const squareness = clamp(impactSpeed / speed, 0, 1);
        const friction = c.wallFrictionGrazing + (c.wallFriction - c.wallFrictionGrazing) * squareness;

        // Split velocity into normal / tangential, then rebuild.
        const tx = v.vx - hnx * vn;
        const tz = v.vz - hnz * vn;
        const bounce = -vn * c.restitution;
        v.vx = tx * friction + hnx * bounce;
        v.vz = tz * friction + hnz * bounce;

        // Glancing blows turn the car to run along the wall.
        const fwdX = Math.sin(v.heading);
        const fwdZ = Math.cos(v.heading);
        const align = cross2(fwdX, fwdZ, hnx, hnz);
        v.applySpin(clamp(-align * impactSpeed * c.spinFactor, -c.maxSpin, c.maxSpin));

        const severity = clamp(impactSpeed / v.params.maxSpeed, 0, 1);
        const keep = 1 - c.buildingSpeedLoss * severity * v.impactResistance;
        v.vx *= keep;
        v.vz *= keep;

        /*
         * Slide assist: a stalled contact gets a shove ALONG the surface in
         * whichever direction the car already faces, so geometry deflects
         * instead of pinning. Fades out as speed returns.
         */
        const after = Math.hypot(v.vx, v.vz);
        /*
         * NOT WHILE THE POLICE HAVE YOU. The assist exists to stop geometry
         * catching a car that is sliding along it - never to break a hold.
         * If anything on wheels is leaning on this car, the wall is their
         * ally and the car stays where it is put.
         */
        if (v.pressedByCar > 0) {
          v.wedgeTimer = 0;
        } else if (after < c.wallSlideAssistSpeed) {
          const tanX = -hnz;
          const tanZ = hnx;
          let dir = fwdX * tanX + fwdZ * tanZ >= 0 ? 1 : -1;
          const fade = 1 - after / c.wallSlideAssistSpeed;
          /*
           * WEDGED: pinned in a corner where the surfaces oppose whichever way
           * the car points, the tangent shove alone just holds it there. After
           * half a second the assist alternates direction and adds a shove
           * back out along the contact normal - the same thing a player does
           * by reversing, without the player having to do it.
           */
          /*
           * CORNER-AWARE. Along a flat wall - every contact normal pointing
           * much the same way - a car that has stopped is CAUGHT, and the
           * assist escalates until it slides free. Where the normals fan out
           * the car has driven into a genuine corner, and being stuck there
           * is a fair consequence: no escalation, just the gentle slide.
           */
          /*
           * Along a flat wall a stopped car is CAUGHT and frees itself
           * quickly. Where the normals fan out it has driven into a corner
           * and is held - but not forever: geometry can form a pocket no
           * driver aimed for (two barrier systems meeting at the road edge),
           * and sitting there at full throttle for good is never right. A
           * corner therefore holds for a full second and a half before the
           * same escape applies.
           */
          const flatWall = normalSpread < c.wallCornerAngle;
          v.wedgeTimer = after < 6 ? v.wedgeTimer + 1 / 60 : 0;
          const freeAt = flatWall ? 0.4 : 1.5;
          let esc = 1;
          if (v.wedgeTimer > freeAt) {
            if (Math.floor(v.wedgeTimer * 1.5) % 2 === 1) dir = -dir;
            esc = Math.min(3.5, 1.6 + v.wedgeTimer);
            v.vx += hnx * c.wallSlideAssist * esc * 0.5;
            v.vz += hnz * c.wallSlideAssist * esc * 0.5;
          }
          v.vx += tanX * dir * c.wallSlideAssist * fade * esc;
          v.vz += tanZ * dir * c.wallSlideAssist * fade * esc;
        }

        if (impactSpeed > c.minImpactSpeed) {
          strongest = { speed: impactSpeed, x: v.x, z: v.z, kind: "static" };
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

    // Mark both: while cars are in contact the wall assist stands down, so a
    // car held against a barrier stays held.
    a.pressedByCar = CONFIG.collision.wallAssistHoldOff;
    b.pressedByCar = CONFIG.collision.wallAssistHoldOff;

    // A boosting player barges: whatever they are hitting keeps only a fraction of its
    // mass for the exchange, which is what makes a parked roadblock answerable.
    const aBarge = a.isPolice ? 1 : a.boosting ? c.boostBargeScale : 1;
    const bBarge = b.isPolice ? 1 : b.boosting ? c.boostBargeScale : 1;
    // A jammed body is anchored machinery: effectively infinite mass, the other
    // party absorbs the whole separation.
    const ma = a.jam ? 1e9 : a.params.mass * a.pushResistance * bBarge;
    const mb = b.jam ? 1e9 : b.params.mass * b.pushResistance * aBarge;
    const total = ma + mb;
    // Lighter car gets moved more.
    const shareA = mb / total;
    const shareB = ma / total;

    /*
     * Against a jammed (anchored, infinite-mass) body the separation is metered:
     * resolving the full overlap in one frame, while a wall resolves its own side,
     * is the squeeze that fires cars out of the world. A quarter unit per frame
     * eases the trapped car to the surface instead.
     */
    const jamCap = a.jam || b.jam ? Math.min(1, 0.25 / Math.max(0.25, hit.depth)) : 1;
    a.x += hit.nx * hit.depth * shareA * jamCap;
    a.z += hit.nz * hit.depth * shareA * jamCap;
    b.x -= hit.nx * hit.depth * shareB * jamCap;
    b.z -= hit.nz * hit.depth * shareB * jamCap;

    const rvx = a.vx - b.vx;
    const rvz = a.vz - b.vz;
    const vn = rvx * hit.nx + rvz * hit.nz;

    // A fixed extra shove on top of the elastic response, so contact always reads as
    // a hit even when both cars are travelling at similar speeds — heavily damped when
    // it is one police car hitting another, so a charging juggernaut cannot blow its own
    // squad off you and hand the player the gap it was sent to close.
    // A plowing juggernaut is nobody's friend: its squadmates take the full hit
    // and scatter like ants, which is the entire visual promise of the class.
    const friendly = a.isPolice && b.isPolice && !a.plow && !b.plow;
    /*
     * Settle rather than ricochet once the player has stopped.
     *
     * The fixed shove is there so contact during a chase reads as forceful; against a
     * stationary player it just scatters the ring the squad has built. Damping it - and
     * the bounce with it - is what lets a pin actually hold.
     */
    const player = a.isPolice ? (b.isPolice ? null : b) : a;
    const settling = player !== null && player.speed < c.pinSettleSpeed;
    /*
     * A T-bone is its own hit.
     *
     * The impulse runs along the contact normal, so when that normal lies across the
     * player's own axis the shove carries them sideways - into the wall, the scenery, or
     * the rest of the squad - rather than down the road. The armoured classes are built
     * to land exactly that and nothing else, so they get their weight there instead of on
     * the general shove, which at any size just hands the player speed and a way out.
     */
    let boost = Math.max(a.contactBoost, b.contactBoost);
    if (player !== null && !friendly) {
      const striker = player === a ? b : a;
      if (striker.broadsideBoost > 1) {
        const right = rightOf(player.heading);
        // 1 when the hit is dead on the flank, 0 when it is nose or tail.
        const flank = Math.abs(hit.nx * right.x + hit.nz * right.z);
        if (flank > c.broadsideAlignment) {
          boost = Math.max(boost, striker.broadsideBoost * flank);
        }
      }
    }
    /*
     * Against a jammed juggernaut nothing bounces and nothing is thrown: the trap
     * closes and the contact SETTLES, which is the difference between "pinned to the
     * wall" and "hit into the wall and back out again".
     */
    const jammed = a.jam || b.jam;
    const shove =
      (jammed ? 0 : c.carImpulse) *
      boost *
      (friendly ? c.policeImpulseScale : 1) *
      (settling ? c.pinShoveScale : 1);
    const bounce = jammed ? 0 : settling ? c.pinRestitution : c.restitution;
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
