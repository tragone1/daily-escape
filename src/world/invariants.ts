/**
 * The properties a finished course must have, in one place.
 *
 * Shared by the whole-course tests and the windowed-build tests, because the
 * contract for building in windows is that the result satisfies the same rules
 * - not that it is byte-identical. It cannot be byte-identical: sealing the
 * boundary, laying cliff rails and checking the racing line all consult what
 * has already been built, so a course assembled in a different order is a
 * different arrangement of the same guarantees. Those guarantees are these.
 */

import type { CourseSegment } from "./course";
import type { StaticCollider } from "../physics/collisionWorld";

/** The player's own half-width: every clearance question is asked at this radius. */
export const CAR = 1.05;
/** Height a car needs to pass beneath something. */
export const CAR_HEIGHT = 2.4;

/** Circle against box, the same question the collision world answers. */
export function blocks(c: StaticCollider, x: number, z: number, radius: number): boolean {
  const dx = x - c.obb.x;
  const dz = z - c.obb.z;
  const fx = Math.sin(c.obb.heading);
  const fz = Math.cos(c.obb.heading);
  const along = Math.abs(dx * fx + dz * fz) - c.obb.halfLength;
  const across = Math.abs(dx * fz - dz * fx) - c.obb.halfWidth;
  if (along <= 0 && across <= 0) return true;
  const oa = Math.max(0, along);
  const oc = Math.max(0, across);
  return oa * oa + oc * oc <= radius * radius;
}

/** Widest run of lateral offsets the car's centre could hold at one station. */
export function widestLane(
  seg: CourseSegment,
  along: number,
  colliders: StaticCollider[],
): number {
  const sx = seg.ax + seg.dx * along;
  const sz = seg.az + seg.dz * along;
  const px = seg.dz;
  const pz = -seg.dx;
  const hw = seg.halfWidth;
  const roadY = seg.ay + (seg.by - seg.ay) * (along / seg.length);
  const near = colliders.filter((c) => {
    const dx = c.obb.x - sx;
    const dz = c.obb.z - sz;
    const reach = c.radius + hw + CAR + 1;
    if (dx * dx + dz * dz > reach * reach) return false;
    // Overhead or buried geometry is not a lane obstruction - the rule collision uses.
    if (c.baseY > roadY + CAR_HEIGHT) return false;
    if (c.topY < roadY) return false;
    return true;
  });
  let best = 0;
  let run = 0;
  for (let o = -hw; o <= hw; o += 0.25) {
    const x = sx + px * o;
    const z = sz + pz * o;
    if (near.some((c) => blocks(c, x, z, CAR))) run = 0;
    else {
      run += 0.25;
      if (run > best) best = run;
    }
  }
  return best;
}

export interface LaneReport {
  worst: number;
  where: string;
}

/** The narrowest lane anywhere on the course's main road. */
export function narrowestLane(
  segments: CourseSegment[],
  colliders: StaticCollider[],
): LaneReport {
  let worst = Infinity;
  let where = "";
  for (const seg of segments) {
    if (seg.branch || seg.overlay) continue;
    for (let a = 0; a <= seg.length; a += 2) {
      const lane = widestLane(seg, a, colliders);
      if (lane < worst) {
        worst = lane;
        where = `${seg.section} s${seg.sectionIndex} seg${seg.index}+${a.toFixed(0)}`;
      }
    }
  }
  return { worst, where };
}

/** Deepest a wall stands inside a carriageway, in units past the kerb line. */
export function worstWallBite(
  segments: CourseSegment[],
  colliders: StaticCollider[],
): number {
  let worst = 0;
  for (const seg of segments) {
    if (seg.branch || seg.overlay) continue;
    for (let a = 0; a <= seg.length; a += 4) {
      const sx = seg.ax + seg.dx * a;
      const sz = seg.az + seg.dz * a;
      const px = seg.dz;
      const pz = -seg.dx;
      const y = seg.ay + (seg.by - seg.ay) * (a / seg.length);
      for (const c of colliders) {
        if (c.source !== "branchWallChunk" && c.source !== "wallRail") continue;
        const dx = c.obb.x - sx;
        const dz = c.obb.z - sz;
        if (dx * dx + dz * dz > (c.radius + seg.halfWidth + 2) ** 2) continue;
        if (Math.abs(dx * seg.dx + dz * seg.dz) > c.obb.halfLength) continue;
        if (c.baseY > y + CAR_HEIGHT) continue;
        if (c.topY < y) continue;
        const inner = Math.abs(dx * px + dz * pz) - c.obb.halfWidth;
        const bite = seg.halfWidth - inner;
        if (bite > worst) worst = bite;
      }
    }
  }
  return worst;
}
