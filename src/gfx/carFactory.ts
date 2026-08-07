/**
 * Car bodies, lofted rather than boxed.
 *
 * Every vehicle used to be one box with a smaller box on top. These builders
 * produce real silhouettes from the same nothing-to-download philosophy: a
 * body is a loft through a handful of cross-section frames - nose low and
 * tapered, belt line rising over the arches, tail cut high or square - and a
 * glass cabin is a second loft with raked front and rear. Flat normals keep
 * the faceted look the game owns; what changes is that the facets now describe
 * a car.
 *
 * Everything here returns raw Geometry for the renderer's `custom` shape, in
 * the vehicle's local space: +z is the nose, y = 0 is the ground plane.
 */

import type { Geometry } from "./primitives";

/** One cross-section of a loft: at `z`, a slab from y0 to y1, `hw` half-wide. */
export interface Frame {
  z: number;
  hw: number;
  y0: number;
  y1: number;
}

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  /** One flat-shaded quad; the normal comes from the winding. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = this.positions.length / 3;
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 4; k++) this.normals.push(nx, ny, nz);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Loft a solid through the frames: right and left walls, top and bottom,
   * and caps at both ends. The workhorse of every body panel here.
   */
  loft(frames: Frame[]): void {
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      // Right wall (+x), then left, then top, then bottom.
      this.quad(a.hw, a.y0, a.z, a.hw, a.y1, a.z, b.hw, b.y1, b.z, b.hw, b.y0, b.z);
      this.quad(-a.hw, a.y1, a.z, -a.hw, a.y0, a.z, -b.hw, b.y0, b.z, -b.hw, b.y1, b.z);
      this.quad(-a.hw, a.y1, a.z, -b.hw, b.y1, b.z, b.hw, b.y1, b.z, a.hw, a.y1, a.z);
      this.quad(-a.hw, a.y0, a.z, a.hw, a.y0, a.z, b.hw, b.y0, b.z, -b.hw, b.y0, b.z);
    }
    const f = frames[0];
    const l = frames[frames.length - 1];
    // Nose cap faces +z? No - frames run tail(-z) to nose(+z); first cap faces -z.
    this.quad(-f.hw, f.y0, f.z, f.hw, f.y0, f.z, f.hw, f.y1, f.z, -f.hw, f.y1, f.z);
    this.quad(l.hw, l.y0, l.z, -l.hw, l.y0, l.z, -l.hw, l.y1, l.z, l.hw, l.y1, l.z);
  }

  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    // loft() gives walls along z plus caps; for an axis-aligned box that is all six faces.
    this.loft([
      { z: cz - hz, hw: hx, y0: cy - hy, y1: cy + hy },
      { z: cz + hz, hw: hx, y0: cy - hy, y1: cy + hy },
    ]);
    // Off-centre boxes need their x offset applied after the loft, which
    // builds about x = 0: shift the vertices this call just appended.
    if (cx !== 0) {
      // A one-segment loft appends six quads of four vertices each.
      const start = this.positions.length - 24 * 3;
      for (let i = start; i < this.positions.length; i += 3) this.positions[i] += cx;
    }
  }

  geometry(): Geometry {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: this.positions.length / 3 > 65535
        ? new Uint32Array(this.indices)
        : new Uint16Array(this.indices),
    };
  }
}

/** What a vehicle body looks like, independent of colour. */
export interface BodyKit {
  /** The painted body shell. */
  body: Geometry;
  /** The glass cabin. */
  glass: Geometry;
  /** Dark trim: bumpers, grille, rockers, wheel wells. */
  trim: Geometry;
  /** Where the wheels sit: [x, y(axle), z] per wheel, front pair first. */
  wheels: [number, number, number][];
  wheelRadius: number;
  wheelWidth: number;
  /** Where the roof light bar sits, if the role carries one. */
  barY: number;
  barZ: number;
  /** Headlight and taillight centres, mirrored over x. */
  headlight: [number, number, number];
  taillight: [number, number, number];
  /** Top of the tail deck, so a spoiler can actually sit on it. */
  tailTopY: number;
  /** The shell floor, where skirts and splitters belong. */
  floorY: number;
}

/**
 * The shared construction: a lower shell whose belt line and nose describe the
 * personality, a glass house with raked screens, dark rockers and bumpers, and
 * four wheels pushed to the corners. All parameterised per silhouette.
 */
function makeKit(opts: {
  halfLength: number;
  halfWidth: number;
  /** Ride height: bottom of the shell. */
  floor: number;
  /** Top of the lower body at the doors. */
  belt: number;
  /** Roof height. */
  roof: number;
  /** Nose height as a fraction of belt; low is sporty. */
  noseDrop: number;
  /** Tail height as a fraction of belt; high is a trunk, low is a fastback. */
  tailDrop: number;
  /** Cabin length as a fraction of body, and where it sits (0 mid, + rearward). */
  cabinLen: number;
  cabinShift: number;
  /** Windscreen rake, as a fraction of the cabin's length. Fractions keep the
   * loft monotonic whatever the wheelbase: rakes in absolute units folded the
   * coupe's short cabin inside-out and drew fins where the glass should be. */
  rake: number;
  /** Rear screen rake, as a fraction of the cabin's length. */
  rearRake: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Wheelbase as a fraction of length. */
  wheelbase: number;
}): BodyKit {
  const L = opts.halfLength;
  const W = opts.halfWidth;
  const floor = opts.floor;
  const belt = opts.belt;

  const body = new Builder();
  /*
   * The shell, tail to nose. The belt rises subtly toward the arches and the
   * nose steps down twice - once at the base of the windscreen, once into the
   * bumper - which is what reads as "car" from the chase camera instead of
   * "box": a silhouette with a shoulder, not a slab.
   */
  const noseY = belt * (1 - opts.noseDrop) + floor * opts.noseDrop;
  const tailY = belt * (1 - opts.tailDrop) + floor * opts.tailDrop;
  body.loft([
    { z: -L, hw: W * 0.86, y0: floor + 0.06, y1: tailY },
    { z: -L * 0.92, hw: W * 0.97, y0: floor, y1: tailY },
    { z: -L * 0.45, hw: W, y0: floor, y1: belt },
    { z: L * 0.28, hw: W, y0: floor, y1: belt },
    { z: L * 0.55, hw: W * 0.985, y0: floor, y1: noseY + (belt - noseY) * 0.45 },
    { z: L * 0.92, hw: W * 0.94, y0: floor, y1: noseY },
    { z: L, hw: W * 0.84, y0: floor + 0.06, y1: noseY - 0.04 },
  ]);

  /*
   * The glass house. Slightly narrower than the shell, raked at both ends;
   * with glass specular and the sky's fresnel it reads as a windscreen even
   * with no texture anywhere near it.
   */
  const cabinHalf = (L * opts.cabinLen) / 2;
  const cabinMid = -L * opts.cabinShift;
  const cabinFull = cabinHalf * 2;
  const glass = new Builder();
  glass.loft([
    { z: cabinMid - cabinHalf, hw: W * 0.8, y0: belt - 0.06, y1: belt + 0.02 },
    { z: cabinMid - cabinHalf + cabinFull * opts.rearRake, hw: W * 0.76, y0: belt - 0.02, y1: opts.roof },
    { z: cabinMid + cabinHalf - cabinFull * opts.rake, hw: W * 0.78, y0: belt - 0.02, y1: opts.roof },
    { z: cabinMid + cabinHalf, hw: W * 0.82, y0: belt - 0.06, y1: belt + 0.02 },
  ]);

  const trim = new Builder();
  // Bumpers: dark, slightly proud of the shell at both ends.
  trim.box(0, floor + 0.16, L - 0.06, W * 0.98, 0.17, 0.16);
  trim.box(0, floor + 0.16, -L + 0.06, W * 0.98, 0.17, 0.16);
  // Grille.
  trim.box(0, (floor + noseY) / 2, L - 0.02, W * 0.5, (noseY - floor) * 0.26, 0.05);
  // Rocker panels under the doors, tying the shell to the ground visually.
  trim.box(W * 0.99, floor + 0.05, 0, 0.03, 0.07, L * 0.5);
  trim.box(-W * 0.99, floor + 0.05, 0, 0.03, 0.07, L * 0.5);

  const axle = opts.wheelRadius;
  const wz = L * opts.wheelbase;
  const wx = W * 0.82;
  // Wheel wells: dark recesses so the wheels sit IN the body, not beside it.
  for (const z of [wz, -wz]) {
    for (const x of [wx, -wx]) {
      trim.box(x, axle + 0.02, z, opts.wheelWidth * 0.46, opts.wheelRadius * 0.9, opts.wheelRadius * 1.05);
    }
  }

  return {
    body: body.geometry(),
    glass: glass.geometry(),
    trim: trim.geometry(),
    wheels: [
      [wx, axle, wz], [-wx, axle, wz],
      [wx, axle, -wz], [-wx, axle, -wz],
    ],
    wheelRadius: opts.wheelRadius,
    wheelWidth: opts.wheelWidth,
    barY: opts.roof + 0.1,
    barZ: cabinMid,
    headlight: [W * 0.6, (floor + noseY) * 0.62, L + 0.01],
    taillight: [W * 0.55, tailY - 0.16, -L - 0.02],
    tailTopY: tailY,
    floorY: floor,
  };
}

export type CarVariant = "coupe" | "sedan" | "interceptor" | "suv" | "rig";

/** The per-silhouette proportions. Same footprint as the collider, always. */
export function kitFor(variant: CarVariant, halfLength: number, halfWidth: number): BodyKit {
  switch (variant) {
    case "coupe":
      // The player: low, wide-shouldered, long hood, fastback tail.
      return makeKit({
        halfLength, halfWidth,
        floor: 0.34, belt: 1.06, roof: 1.52,
        noseDrop: 0.32, tailDrop: 0.1,
        cabinLen: 0.52, cabinShift: 0.22, rake: 0.44, rearRake: 0.34,
        wheelRadius: 0.44, wheelWidth: 0.36, wheelbase: 0.6,
      });
    case "interceptor":
      // The fast pursuit special: lower and sleeker than a patrol sedan.
      return makeKit({
        halfLength, halfWidth,
        floor: 0.33, belt: 1.02, roof: 1.56,
        noseDrop: 0.34, tailDrop: 0.14,
        cabinLen: 0.5, cabinShift: 0.16, rake: 0.46, rearRake: 0.3,
        wheelRadius: 0.44, wheelWidth: 0.36, wheelbase: 0.62,
      });
    case "suv":
      // The heavy: tall, upright, short hood, square tail.
      return makeKit({
        halfLength, halfWidth,
        floor: 0.5, belt: 1.34, roof: 2.08,
        noseDrop: 0.2, tailDrop: 0.02,
        cabinLen: 0.62, cabinShift: 0.12, rake: 0.3, rearRake: 0.14,
        wheelRadius: 0.54, wheelWidth: 0.44, wheelbase: 0.6,
      });
    case "rig":
      // Handled by makeRigKit; this fallback keeps the type total.
      return makeRigKit(halfLength, halfWidth);
    case "sedan":
    default:
      return makeKit({
        halfLength, halfWidth,
        floor: 0.36, belt: 1.12, roof: 1.72,
        noseDrop: 0.26, tailDrop: 0.05,
        cabinLen: 0.55, cabinShift: 0.14, rake: 0.4, rearRake: 0.26,
        wheelRadius: 0.44, wheelWidth: 0.36, wheelbase: 0.6,
      });
  }
}

/**
 * The rig: a cab-over tractor and a box body on six wheels. Its silhouette is
 * its job - a wall across the road should look like one long before it is.
 */
export function makeRigKit(halfLength: number, halfWidth: number): BodyKit {
  const L = halfLength;
  const W = halfWidth;

  const body = new Builder();
  // Cab, tall and flat-faced at the nose.
  body.loft([
    { z: L * 0.42, hw: W * 0.98, y0: 0.5, y1: 2.9 },
    { z: L * 0.98, hw: W * 0.94, y0: 0.5, y1: 2.75 },
    { z: L, hw: W * 0.88, y0: 0.55, y1: 2.3 },
  ]);
  // Box body, slightly taller than the cab roofline, square tail.
  body.loft([
    { z: -L, hw: W, y0: 0.9, y1: 3.15 },
    { z: L * 0.34, hw: W, y0: 0.9, y1: 3.15 },
  ]);
  // Chassis rail tying cab to box.
  body.loft([
    { z: -L, hw: W * 0.7, y0: 0.45, y1: 0.95 },
    { z: L * 0.5, hw: W * 0.7, y0: 0.45, y1: 0.95 },
  ]);

  const glass = new Builder();
  glass.loft([
    { z: L * 0.86, hw: W * 0.86, y0: 1.7, y1: 1.72 },
    { z: L * 0.97, hw: W * 0.84, y0: 1.72, y1: 2.6 },
  ]);

  const trim = new Builder();
  // Full-width push bar: the rig leads with it.
  trim.box(0, 1.0, L + 0.12, W * 1.02, 0.75, 0.14);
  trim.box(0, 0.35, L - 0.05, W * 0.99, 0.16, 0.14);
  // Underride skirts along the box.
  trim.box(W * 0.99, 0.62, -L * 0.35, 0.04, 0.28, L * 0.6);
  trim.box(-W * 0.99, 0.62, -L * 0.35, 0.04, 0.28, L * 0.6);

  const r = 0.56;
  const wheels: [number, number, number][] = [
    [W * 0.85, r, L * 0.62], [-W * 0.85, r, L * 0.62],
    [W * 0.85, r, -L * 0.28], [-W * 0.85, r, -L * 0.28],
    [W * 0.85, r, -L * 0.72], [-W * 0.85, r, -L * 0.72],
  ];
  for (const [x, , z] of wheels) {
    trim.box(x, r + 0.05, z, 0.26, r * 0.9, r * 1.1);
  }

  return {
    body: body.geometry(),
    glass: glass.geometry(),
    trim: trim.geometry(),
    wheels,
    wheelRadius: r,
    wheelWidth: 0.5,
    barY: 3.0,
    barZ: L * 0.7,
    headlight: [W * 0.6, 1.05, L + 0.02],
    taillight: [W * 0.7, 1.2, -L + 0.02],
    tailTopY: 3.15,
    floorY: 0.45,
  };
}
