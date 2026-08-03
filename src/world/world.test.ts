/**
 * The daily map is never play-tested.
 *
 * A new course is generated every day from that day's seed and goes straight to
 * players; nobody drives it first. So the properties a course must have are
 * asserted here across many seeds instead, and a build that would have shipped a
 * blocked road or a hairpin between two walls fails before anyone sees it.
 *
 * Everything here is a property of the geometry, not a snapshot: none of it
 * breaks because a wall moved, only because a road became undrivable.
 */

import { describe, expect, it } from "vitest";
import { makeCourse } from "./course";
import type { CourseSegment } from "./course";
import { buildWorld } from "./courseBuilder";
import type { StaticCollider } from "../physics/collisionWorld";
import { stubRenderer } from "./testRenderer";

/** Seeds to sweep. Fixed list so a failure is reproducible, spread so it is representative. */
const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

/** The player's own half-width: every clearance question is asked at this radius. */
const CAR = 1.05;
/** Narrowest lane the course may leave, as a span of centre positions. */
const MIN_LANE = 6.5;

interface Built {
  segments: CourseSegment[];
  colliders: StaticCollider[];
}

function build(seed: number): Built {
  const course = makeCourse(seed);
  const world = buildWorld(stubRenderer(), course);
  return { segments: world.segments, colliders: world.colliders };
}

/** Circle-against-box, the same question the collision world answers. */
function blocked(c: StaticCollider, x: number, z: number, radius: number): boolean {
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
function widestLane(seg: CourseSegment, along: number, colliders: StaticCollider[]): number {
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
    // Overhead geometry is not a lane obstruction - the same rule collision uses.
    if (c.baseY > roadY + 2.4) return false;
    if (c.topY < roadY) return false;
    return true;
  });
  let best = 0;
  let run = 0;
  for (let o = -hw; o <= hw; o += 0.25) {
    const x = sx + px * o;
    const z = sz + pz * o;
    if (near.some((c) => blocked(c, x, z, CAR))) run = 0;
    else {
      run += 0.25;
      if (run > best) best = run;
    }
  }
  return best;
}

const wrap = (a: number): number => {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
};

describe("every generated course", () => {
  const built = new Map<number, Built>();
  const get = (seed: number): Built => {
    let b = built.get(seed);
    if (!b) built.set(seed, (b = build(seed)));
    return b;
  };

  it.each(SEEDS)("seed %i leaves a drivable lane everywhere", (seed) => {
    const { segments, colliders } = get(seed);
    let worst = Infinity;
    let worstAt = "";
    for (const seg of segments) {
      if (seg.branch || seg.overlay) continue;
      for (let a = 0; a <= seg.length; a += 2) {
        const lane = widestLane(seg, a, colliders);
        if (lane < worst) {
          worst = lane;
          worstAt = `${seg.section} seg${seg.index}+${a.toFixed(0)}`;
        }
      }
    }
    expect(worst, `narrowest lane at ${worstAt}`).toBeGreaterThanOrEqual(MIN_LANE);
  });

  it.each(SEEDS)("seed %i turns no tighter than it can be driven", (seed) => {
    const { segments } = get(seed);
    const mains = segments.filter((s) => !s.branch && !s.overlay);
    /*
     * RADIUS, not angle. A long sweeping bend and a hairpin can turn through
     * the same number of degrees; what decides whether it can be carried at
     * speed - or whether it arrives as a wall across the windscreen - is how
     * tight it is. The corner that started all this turned 88 degrees in 24
     * units: radius 15. Measured this way it fails by a mile, while the wide
     * bends it used to be confused with pass.
     *
     * Two bars, because run-off is what makes a tight corner survivable: a
     * theme with a shoulder to spill into may be tighter than one walled on
     * both sides.
     */
    let worstWalled = Infinity;
    let worstOpen = Infinity;
    let where = "";
    for (let i = 6; i < mains.length - 6; i++) {
      const turn = Math.abs(wrap(mains[i + 6].heading - mains[i - 6].heading));
      if (turn < 0.01) continue;
      let arc = 0;
      for (let j = i - 6; j < i + 6; j++) arc += mains[j].length;
      const radius = arc / turn;
      if (mains[i].shoulder < 1) {
        if (radius < worstWalled) {
          worstWalled = radius;
          where = `${mains[i].section} seg${mains[i].index}`;
        }
      } else if (radius < worstOpen) {
        worstOpen = radius;
      }
    }
    expect(worstWalled, `tightest walled-in corner at ${where}`).toBeGreaterThan(45);
    expect(worstOpen, "tightest corner with run-off").toBeGreaterThan(25);
  });

  it.each(SEEDS)("seed %i keeps its spurs and their surfaces", (seed) => {
    const { segments } = get(seed);
    const branches = segments.filter((s) => s.branch);
    expect(branches.length).toBeGreaterThan(0);
    // A spur clipped out of existence is an alley the director can still try to
    // seat a car in, and a mouth that opens onto nothing.
    for (const b of branches) {
      expect(b.length).toBeGreaterThan(1);
      expect(b.halfWidth).toBeGreaterThan(1);
    }
  });

  it.each(SEEDS)("seed %i stands no wall on a carriageway", (seed) => {
    const { segments, colliders } = get(seed);
    const mains = segments.filter((s) => !s.branch && !s.overlay);
    let worstBite = 0;
    for (const seg of mains) {
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
          // Overhead or buried: the same rule collision uses, not a guess.
          if (c.baseY > y + 2.4) continue;
          if (c.topY < y) continue;
          const inner = Math.abs(dx * px + dz * pz) - c.obb.halfWidth;
          const bite = seg.halfWidth - inner;
          if (bite > worstBite) worstBite = bite;
        }
      }
    }
    // A wall may kiss the kerb line; it may not stand a car's width into the road.
    expect(worstBite).toBeLessThan(CAR * 2);
  });
});

describe("the course as a whole", () => {
  it("is deterministic for a given seed", () => {
    const a = makeCourse(4242);
    const b = makeCourse(4242);
    expect(a.legs.length).toBe(b.legs.length);
    expect(a.legs[40]).toEqual(b.legs[40]);
    expect(a.sectionStarts).toEqual(b.sectionStarts);
  });

  it("gives different seeds different courses", () => {
    const a = makeCourse(1);
    const b = makeCourse(2);
    expect(a.legs[30]).not.toEqual(b.legs[30]);
  });
});
