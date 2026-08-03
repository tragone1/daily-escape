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
import { narrowestLane, worstWallBite, CAR } from "./invariants";

/** Narrowest lane the course may leave, as a span of centre positions. */
const MIN_LANE = 6.5;

/** Seeds to sweep. Fixed list so a failure is reproducible, spread so it is representative. */
const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

interface Built {
  segments: CourseSegment[];
  colliders: StaticCollider[];
}

function build(seed: number): Built {
  const course = makeCourse(seed);
  const world = buildWorld(stubRenderer(), course);
  return { segments: world.segments, colliders: world.colliders };
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
    const { worst, where } = narrowestLane(segments, colliders);
    expect(worst, `narrowest lane at ${where}`).toBeGreaterThanOrEqual(MIN_LANE);
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
    // A wall may kiss the kerb line; it may not stand a car's width into the road.
    expect(worstWallBite(segments, colliders)).toBeLessThan(CAR * 2);
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
