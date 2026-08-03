/**
 * Where the rocket pickups end up.
 *
 * They were positioned from the coarse leg list - the control points the road
 * is splined through, not the road itself - and then built against a world
 * that had only its opening sections. So some sat out past the kerb, some had
 * their height sampled somewhere they were not, and none existed at all beyond
 * the course as it stood at startup.
 */
import { describe, expect, it } from "vitest";
import { makeCourse, buildCourseSegments } from "./course";
import { Terrain } from "./terrain";
import { PickupSystem } from "./pickups";
import { stubRenderer } from "./testRenderer";

/** A car's half-width; a pickup this close to the kerb is a geometry puzzle. */
const KERB_MARGIN = 2.2;

function place(seed: number, sections: number) {
  const course = makeCourse(seed, sections);
  const { segments } = buildCourseSegments(course);
  const terrain = new Terrain(segments);
  const system = new PickupSystem(stubRenderer(), terrain);
  return { system, terrain };
}

describe("rocket pickups", () => {
  it.each([1000, 8919, 24757])("seed %i puts every one on solid road", (seed) => {
    const { system, terrain } = place(seed, 20);
    const items = system.all();
    expect(items.length).toBeGreaterThan(3);
    for (const it of items) {
      const smp = terrain.sample(it.x, it.z);
      expect(smp.onCourse, `pickup at ${it.x.toFixed(0)},${it.z.toFixed(0)}`).toBe(true);
      // Never on a spur: ammunition belongs on the road being driven.
      expect(smp.segment.branch).toBe(false);
    }
  });

  it.each([1000, 8919])("seed %i keeps them clear of the kerb", (seed) => {
    const { system, terrain } = place(seed, 20);
    for (const it of system.all()) {
      const seg = terrain.sample(it.x, it.z).segment;
      const across = Math.abs((it.x - seg.ax) * seg.dz - (it.z - seg.az) * seg.dx);
      expect(seg.halfWidth - across).toBeGreaterThanOrEqual(KERB_MARGIN);
    }
  });

  it("samples height at the point it actually places", () => {
    // The half-buried one on the ramp: measured at one point, drawn at another.
    const { system, terrain } = place(8919, 20);
    for (const it of system.all()) {
      expect(Math.abs(it.y - terrain.heightAt(it.x, it.z))).toBeLessThan(0.01);
    }
  });

  it("is off the middle often enough to still cost a line", () => {
    const { system, terrain } = place(8919, 20);
    const offset = system.all().filter((it) => {
      const seg = terrain.sample(it.x, it.z).segment;
      const across = Math.abs((it.x - seg.ax) * seg.dz - (it.z - seg.az) * seg.dx);
      return across > seg.halfWidth * 0.3;
    });
    // Most ask for a detour; a third sit on the racing line by design.
    expect(offset.length).toBeGreaterThan(system.all().length * 0.4);
  });

  it("keeps placing them as the world grows", () => {
    /*
     * The course is endless, so ammunition has to be too. Built from a fixed
     * list, it simply stopped at the end of the opening course.
     */
    const shortCourse = place(8919, 10);
    const before = shortCourse.system.all().length;

    const longer = buildCourseSegments(makeCourse(8919, 30)).segments;
    shortCourse.terrain.reset(longer);
    shortCourse.system.extendTo(stubRenderer(), shortCourse.terrain);

    expect(shortCourse.system.all().length).toBeGreaterThan(before);
  });

  it("does not duplicate one when the world grows again", () => {
    const { system, terrain } = place(8919, 20);
    const count = system.all().length;
    system.extendTo(stubRenderer(), terrain);
    system.extendTo(stubRenderer(), terrain);
    expect(system.all()).toHaveLength(count);
  });
});
