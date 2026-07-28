/**
 * Collision maths for the arcade driving model.
 *
 * Buildings and barriers are axis-aligned boxes (AABB); cars are oriented boxes (OBB).
 * Overlap tests use the separating-axis theorem and return the minimum translation
 * vector, which lets us push cars out of geometry analytically instead of relying on a
 * rigid-body solver. Cars therefore can never flip, tunnel or gain vertical energy.
 */

import { forwardOf, rightOf } from "../math";

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface OBB {
  x: number;
  z: number;
  halfLength: number;
  halfWidth: number;
  heading: number;
}

export interface Hit {
  /** Unit vector pointing out of the obstacle, toward the moving body. */
  nx: number;
  nz: number;
  /** Penetration depth along the normal. */
  depth: number;
}

export function aabbContains(b: AABB, x: number, z: number): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** Cheap broad-phase: does a circle of `r` around (x,z) reach this box at all? */
export function circleNearAABB(b: AABB, x: number, z: number, r: number): boolean {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz <= r * r;
}

/** Projection radius of an OBB onto a unit axis. */
function obbRadius(o: OBB, ax: number, az: number): number {
  const f = forwardOf(o.heading);
  const r = rightOf(o.heading);
  return (
    o.halfLength * Math.abs(f.x * ax + f.z * az) + o.halfWidth * Math.abs(r.x * ax + r.z * az)
  );
}

/**
 * OBB vs AABB. Returns the push-out for the OBB, or null when separated.
 * Four candidate axes are enough for two boxes in 2D.
 */
export function obbVsAABB(o: OBB, b: AABB): Hit | null {
  const bcx = (b.minX + b.maxX) / 2;
  const bcz = (b.minZ + b.maxZ) / 2;
  const bex = (b.maxX - b.minX) / 2;
  const bez = (b.maxZ - b.minZ) / 2;

  const dx = o.x - bcx;
  const dz = o.z - bcz;

  const f = forwardOf(o.heading);
  const r = rightOf(o.heading);
  const axes: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [f.x, f.z],
    [r.x, r.z],
  ];

  let bestDepth = Infinity;
  let bestX = 0;
  let bestZ = 0;

  for (const [ax, az] of axes) {
    const radiusA = bex * Math.abs(ax) + bez * Math.abs(az);
    const radiusB = obbRadius(o, ax, az);
    const centerDelta = dx * ax + dz * az;
    const overlap = radiusA + radiusB - Math.abs(centerDelta);
    if (overlap <= 0) return null;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      // Normal always points from the obstacle toward the OBB.
      const sign = centerDelta < 0 ? -1 : 1;
      bestX = ax * sign;
      bestZ = az * sign;
    }
  }

  return { nx: bestX, nz: bestZ, depth: bestDepth };
}

/** OBB vs OBB. Returns the push-out for box `a` (normal points from b toward a). */
export function obbVsOBB(a: OBB, b: OBB): Hit | null {
  const dx = a.x - b.x;
  const dz = a.z - b.z;

  const fa = forwardOf(a.heading);
  const ra = rightOf(a.heading);
  const fb = forwardOf(b.heading);
  const rb = rightOf(b.heading);
  const axes: Array<[number, number]> = [
    [fa.x, fa.z],
    [ra.x, ra.z],
    [fb.x, fb.z],
    [rb.x, rb.z],
  ];

  let bestDepth = Infinity;
  let bestX = 0;
  let bestZ = 0;

  for (const [ax, az] of axes) {
    const radiusA = obbRadius(a, ax, az);
    const radiusB = obbRadius(b, ax, az);
    const centerDelta = dx * ax + dz * az;
    const overlap = radiusA + radiusB - Math.abs(centerDelta);
    if (overlap <= 0) return null;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      const sign = centerDelta < 0 ? -1 : 1;
      bestX = ax * sign;
      bestZ = az * sign;
    }
  }

  return { nx: bestX, nz: bestZ, depth: bestDepth };
}

/**
 * Segment vs OBB. The segment is transformed into the box's local frame and then run
 * through the same slab test, so oriented walls block line of sight exactly like
 * axis-aligned ones do.
 */
export function segmentVsOBB(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  o: OBB,
): number | null {
  const f = forwardOf(o.heading);
  const r = rightOf(o.heading);
  const localX = (x: number, z: number) => (x - o.x) * r.x + (z - o.z) * r.z;
  const localZ = (x: number, z: number) => (x - o.x) * f.x + (z - o.z) * f.z;

  return segmentVsAABB(
    localX(x0, z0),
    localZ(x0, z0),
    localX(x1, z1),
    localZ(x1, z1),
    { minX: -o.halfWidth, maxX: o.halfWidth, minZ: -o.halfLength, maxZ: o.halfLength },
  );
}

/**
 * Segment vs AABB (slab method). Returns the entry parameter t in [0,1], or null.
 * Used for police line-of-sight and camera occlusion.
 */
export function segmentVsAABB(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  b: AABB,
): number | null {
  const dx = x1 - x0;
  const dz = z1 - z0;

  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) < 1e-8) {
    if (x0 < b.minX || x0 > b.maxX) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (b.minX - x0) * inv;
    let t2 = (b.maxX - x0) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  // Z slab
  if (Math.abs(dz) < 1e-8) {
    if (z0 < b.minZ || z0 > b.maxZ) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (b.minZ - z0) * inv;
    let t2 = (b.maxZ - z0) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin;
}
