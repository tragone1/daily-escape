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
import { makeCourse, buildCourseSegments } from "./course";
import type { CourseSegment } from "./course";
import { buildWorld } from "./courseBuilder";
import type { StaticCollider } from "../physics/collisionWorld";
import { stubRenderer } from "./testRenderer";
import type { Renderer } from "../gfx/renderer";
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

/**
 * A barrier has to lie along the thing it is closing.
 *
 * The boundary is sealed by short blocks, chained to their neighbours where
 * they have one. Any piece that runs across the boundary instead of along it
 * leaves a stub poking out of an otherwise flush face, and beside the smooth
 * wall rail that is a corner with two prongs and a pocket between them - a car
 * that clips it wedges instead of sliding off. The chained pieces already
 * refuse to form more than about fifty degrees off the road; a piece that never
 * found a partner was exempt from that rule and was laid pointing at world
 * north regardless of which way its wall ran, which put the median one 46
 * degrees across its own boundary and the worst of them 90.
 */
describe("the boundary seal", () => {
  it("lays its lone pieces along their walls, not across them", () => {
    /*
     * A POPULATION, not a worst case, and deliberately so.
     *
     * A lone piece is one that found nobody to chain to, so a handful of them
     * genuinely do sit by themselves against a wall they meet at a right angle -
     * at an alley mouth that is the correct place for one to be, and no bar on
     * the worst single piece can tell that apart from a stub. What the defect
     * did was tilt EVERY piece, so it shows up in the middle of the
     * distribution and nowhere else: measured over these seeds the median piece
     * sat 32.8 degrees across the nearest wall that agreed with it best, and
     * with the heading taken from the boundary it was built on that falls to
     * 1.4. The top of the distribution is almost unchanged - 89.7 to 84.3 -
     * which is exactly the signature of a fix that moved the rule and not the
     * geometry of the odd genuine corner.
     */
    const off: number[] = [];
    for (const seed of SEEDS) {
      const { colliders } = build(seed);
      const lone = colliders.filter((c) => c.source === "sealLone");
      const fence = colliders.filter(
        (c) => c.source === "wallRail" || c.source === "sealLink" || c.source === "sealLone",
      );
      for (const c of lone) {
        let best = Infinity;
        for (const f of fence) {
          if (f === c) continue;
          if (Math.hypot(f.obb.x - c.obb.x, f.obb.z - c.obb.z) > 6) continue;
          // A block is symmetric about its long axis, so half a turn is no turn.
          let d = Math.abs(wrap(c.obb.heading - f.obb.heading));
          if (d > Math.PI / 2) d = Math.PI - d;
          if (d < best) best = d;
        }
        // Nothing within reach to form a corner with, so nothing to snag on.
        if (Number.isFinite(best)) off.push(best * (180 / Math.PI));
      }
    }
    // If these stop being emitted the test must not quietly pass on nothing.
    expect(off.length).toBeGreaterThan(500);
    off.sort((a, b) => a - b);
    expect(off[off.length >> 1]).toBeLessThan(10);
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

/**
 * The blocks in the road have to sit on it.
 *
 * A station block is 1.4 times as deep as it is wide, and it was stood upright
 * whatever the road was doing underneath. On a gradient that buries its uphill
 * bottom edge by half its depth times the grade and lifts the downhill edge off
 * the surface by the same - which is why they looked right on the flat and
 * partly sunk on every hill.
 *
 * Measured against the ribbon that is actually DRAWN rather than against
 * `terrain.heightAt`: the sampler blends heights across segment ownership and
 * the ribbon does not, so the sampler is the wrong thing to hold the geometry
 * to. The two disagree by more than the defect being measured.
 */
interface PropBox {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  ry: number;
  rx: number;
}

/** A renderer that keeps the boxes, which is the only way to see a rotation. */
function boxRecorder(): { renderer: Renderer; boxes: PropBox[] } {
  const boxes: PropBox[] = [];
  const make = (spec: Record<string, unknown>) => {
    const rotation = { x: 0, y: 0, z: 0 };
    const entry: PropBox = { w: 0, h: 0, d: 0, x: 0, y: 0, z: 0, ry: 0, rx: 0 };
    if (spec.kind === "box") {
      entry.w = spec.width as number;
      entry.h = spec.height as number;
      entry.d = spec.depth as number;
      // Written after the position, so read them back lazily.
      Object.defineProperty(entry, "ry", { get: () => rotation.y });
      Object.defineProperty(entry, "rx", { get: () => rotation.x });
      boxes.push(entry);
    }
    const position = {
      x: 0,
      y: 0,
      z: 0,
      set(x: number, y: number, z: number) {
        entry.x = x;
        entry.y = y;
        entry.z = z;
      },
    };
    return {
      position,
      rotation,
      parent: null,
      isStatic: false,
      alpha: 1,
      scaling: { x: 1, y: 1, z: 1, set() {} },
      dispose() {},
      isEnabled: () => true,
      setEnabled() {},
    };
  };
  const renderer = {
    createMesh: (s: Record<string, unknown>) => make(s),
    createNode: () => make({ kind: "node" }),
    bake: () => {},
    bakeGrouped: () => {},
    disposeChunk: () => {},
    disposeChunkGroup: () => 0,
    forgetBaked: () => {},
  };
  return { renderer: renderer as unknown as Renderer, boxes };
}

/** Height of the drawn ribbon: planar along each segment, flat across its width. */
function ribbonHeight(segments: CourseSegment[], x: number, z: number): number {
  let best = -Infinity;
  for (const sg of segments) {
    if (sg.branch || sg.overlay) continue;
    const rx = x - sg.ax;
    const rz = z - sg.az;
    const along = rx * sg.dx + rz * sg.dz;
    if (along < 0 || along > sg.length) continue;
    if (Math.abs(rx * sg.dz - rz * sg.dx) > sg.halfWidth) continue;
    const y = sg.ay + sg.grade * along;
    if (y > best) best = y;
  }
  return best;
}

describe("the blocks in the road", () => {
  it("stand on the surface rather than sunk into it", () => {
    const buried: number[] = [];
    for (const seed of [1000, 8919, 24757, 40595]) {
      const course = makeCourse(seed);
      const { segments } = buildCourseSegments(course);
      const { renderer, boxes } = boxRecorder();
      buildWorld(renderer, course);
      // A station block is the box whose depth is exactly 1.4x its width.
      const props = boxes.filter((b) => Math.abs(b.d - b.w * 1.4) < 1e-9 && b.w > 1);
      expect(props.length).toBeGreaterThan(50);
      for (const b of props) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const lx = (sx * b.w) / 2;
            const ly = -b.h / 2;
            const lz = (sz * b.d) / 2;
            // The composed rotation is Ry*Rx*Rz, and a block takes no roll.
            const y1 = ly * Math.cos(b.rx) - lz * Math.sin(b.rx);
            const z1 = ly * Math.sin(b.rx) + lz * Math.cos(b.rx);
            const wx = b.x + lx * Math.cos(b.ry) + z1 * Math.sin(b.ry);
            const wz = b.z - lx * Math.sin(b.ry) + z1 * Math.cos(b.ry);
            const road = ribbonHeight(segments, wx, wz);
            // A corner overhanging the kerb has no road under it to sink into.
            if (Number.isFinite(road)) buried.push(road - (b.y + y1));
          }
        }
      }
    }
    expect(buried.length).toBeGreaterThan(2000);
    buried.sort((a, b) => a - b);
    /*
     * A percentile, because the tail is honest. A block straddling a sharp
     * change of grade cannot lie flat on both sides of it, and no single tilt
     * will make it - the worst corner is 0.35 and that is geometry, not a bug.
     * What the defect did was tilt every block on every hill, so it shows up
     * across the whole population: p99 was 0.512 upright and is 0.073 lying on
     * the slope, with p90 going from 0.183 to 0.015.
     */
    /*
     * Re-baselined for the chord fit. Pitched to its own segment's grade a
     * block was already close - p99 0.073, worst 0.349, the tail being blocks
     * straddling a change of grade. Seated on the heights where its front and
     * back edges actually land, the same population measures p90 0.012,
     * p99 0.046, worst 0.253: the visible edges are flush by construction and
     * what error remains hides under the middle of the block.
     */
    expect(buried[Math.floor(buried.length * 0.99)]).toBeLessThan(0.1);
  });
});

/**
 * Nothing may stand in the shadow of a jump.
 *
 * A ramp lip is a raised bar with a drop behind it: a block within a few
 * car-lengths of one is hidden until the lip is crossed, at which point the
 * player is airborne and committed. One daily course put a block six point
 * eight units past a lip - reported as "a block sunk in the road", experienced
 * as a wall materialising mid-flight. The builder now refuses those stations;
 * this holds it to that.
 */
describe("ramp landings", () => {
  it.each(SEEDS)("seed %i keeps its landings clear of blocks", (seed) => {
    const { segments, colliders } = build(seed);
    const lips = segments.filter((s) => !s.branch && !s.overlay && s.ramp > 0);
    const props = colliders.filter((c) => c.source === "spineProp");
    for (const lip of lips) {
      for (const p of props) {
        const dx = p.obb.x - lip.bx;
        const dz = p.obb.z - lip.bz;
        // Only the landing side. A block short of the lip is met on the
        // ground, seen the whole way in, and steered around before the jump.
        if (dx * lip.dx + dz * lip.dz <= 0) continue;
        const d = Math.hypot(dx, dz);
        expect(d, `block ${d.toFixed(1)} past the lip at seg${lip.index}`).toBeGreaterThan(25);
      }
    }
  });
});
