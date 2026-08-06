/**
 * Building a course in windows must give a world as good as building it whole.
 *
 * Not byte-identical - it cannot be. Sealing the boundary, laying cliff rails
 * and checking the racing line all consult what has already been built, so a
 * course assembled in a different order is a different arrangement of the same
 * guarantees. Those guarantees are what is asserted here, because a window
 * built as though the rest of the world did not exist looks perfectly fine on
 * its own and only goes wrong at the seams - which is exactly where the
 * chokepoints and the walls across roads came from.
 */
import { describe, expect, it } from "vitest";
import { makeCourse, buildCourseSegments } from "./course";
import { buildWorld, emitSections, EMIT_ALL, type PlacedProp } from "./courseBuilder";
import { stubRenderer } from "./testRenderer";
import { narrowestLane, worstWallBite, CAR } from "./invariants";
import type { StaticCollider } from "../physics/collisionWorld";

const SEEDS = [1000, 8919, 24757];
const MIN_LANE = 6.5;

/** Assemble a course the way a streamed world does: windows, into one set. */
function buildWindowed(seed: number, step: number): StaticCollider[] {
  const course = makeCourse(seed);
  const into: StaticCollider[] = [];
  /*
   * Shared across windows, exactly as the stream shares it. This is half the
   * point of the harness: a block placed by one window and narrowed by the
   * next window's wall can only be withdrawn if the later sweep can reach it,
   * and it reaches it through this list.
   */
  const props: PlacedProp[] = [];
  for (let from = 0; from < course.sectionCount; from += step) {
    buildWorld(stubRenderer(), course, emitSections(from, from + step), into, "world", undefined, props);
  }
  return into;
}

describe("windowed building", () => {
  it.each(SEEDS)("seed %i still leaves a drivable lane everywhere", (seed) => {
    const course = makeCourse(seed);
    const { segments } = buildCourseSegments(course);
    const colliders = buildWindowed(seed, 5);
    const { worst, where } = narrowestLane(segments, colliders);
    expect(worst, `narrowest lane at ${where}`).toBeGreaterThanOrEqual(MIN_LANE);
  });

  it.each(SEEDS)("seed %i stands no wall on a carriageway", (seed) => {
    const course = makeCourse(seed);
    const { segments } = buildCourseSegments(course);
    const colliders = buildWindowed(seed, 5);
    expect(worstWallBite(segments, colliders)).toBeLessThan(CAR * 2);
  });

  it("builds about as much as a whole-course pass", () => {
    const course = makeCourse(8919);
    const whole = buildWorld(stubRenderer(), course, EMIT_ALL);
    const windowed = buildWindowed(8919, 5);
    /*
     * Order-dependent passes make the exact count differ; a large gap would
     * mean a window is skipping or duplicating work rather than arranging it
     * differently.
     */
    const ratio = windowed.length / whole.colliders.length;
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  it("emits nothing outside its window", () => {
    const course = makeCourse(8919);
    const { segments } = buildCourseSegments(course);
    const win = buildWorld(stubRenderer(), course, emitSections(3, 6));
    const inWindow = segments.filter((s) => s.sectionIndex >= 3 && s.sectionIndex < 6);
    const pad = 400;
    const minX = Math.min(...inWindow.map((s) => s.ax)) - pad;
    const maxX = Math.max(...inWindow.map((s) => s.ax)) + pad;
    const minZ = Math.min(...inWindow.map((s) => s.az)) - pad;
    const maxZ = Math.max(...inWindow.map((s) => s.az)) + pad;
    const strays = win.colliders.filter(
      (c) => c.obb.x < minX || c.obb.x > maxX || c.obb.z < minZ || c.obb.z > maxZ,
    );
    expect(strays.length).toBe(0);
  });

  it("covers every section, whatever the window size", () => {
    for (const step of [3, 5, 8]) {
      const colliders = buildWindowed(8919, step);
      expect(colliders.length).toBeGreaterThan(8000);
    }
  });
});
