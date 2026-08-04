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
import { CONFIG } from "../config";
import type { Renderer } from "../gfx/renderer";

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

/**
 * The glowing ring has to lie on the road it marks.
 *
 * It is twelve units across and was held level with the world, so on a slope it
 * simply cut into the tarmac - at a gradient of 0.24 the uphill rim sat about a
 * unit under the surface and roughly half the glow was inside the road, which
 * is what "a rocket half in the ground" looks like from the driver's seat.
 * Nothing measured it, because the stub renderer throws the mesh away.
 */
interface Ring {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

/** A renderer that keeps the ring meshes, which is the only way to see this. */
function ringRecorder(): { renderer: Renderer; rings: Ring[] } {
  const rings: Ring[] = [];
  const make = (spec: { kind: string; diameterTop?: number }) => {
    const entry: Ring = { x: 0, y: 0, z: 0, rx: 0, rz: 0 };
    // The rocket itself is built from cylinders too; the ring is the wide one.
    if (spec.kind === "cylinder" && (spec.diameterTop ?? 0) >= CONFIG.pickups.radius * 2) {
      rings.push(entry);
    }
    const rotation = { x: 0, y: 0, z: 0 };
    const position = {
      x: 0,
      y: 0,
      z: 0,
      set(x: number, y: number, z: number) {
        position.x = x;
        position.y = y;
        position.z = z;
        entry.x = x;
        entry.y = y;
        entry.z = z;
      },
    };
    // The ring's tilt is written after its position, so read it back lazily.
    Object.defineProperty(entry, "rx", { get: () => rotation.x, configurable: true });
    Object.defineProperty(entry, "rz", { get: () => rotation.z, configurable: true });
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
    createMesh: (spec: { kind: string; diameterTop?: number }) => make(spec),
    createNode: () => make({ kind: "node" }),
    bake: () => {},
    bakeGrouped: () => {},
    disposeChunk: () => {},
    disposeChunkGroup: () => 0,
    forgetBaked: () => {},
  };
  return { renderer: renderer as unknown as Renderer, rings };
}

/** How far the deepest point of the ring's rim sits below the road. */
function worstBurial(rings: Ring[], terrain: Terrain, radius: number): number {
  let worst = 0;
  for (const ring of rings) {
    for (let i = 0; i < 32; i++) {
      const phi = (i / 32) * Math.PI * 2;
      const a = radius * Math.cos(phi);
      const b = radius * Math.sin(phi);
      // The composed rotation is Ry*Rx*Rz, and the ring never takes a yaw.
      const x1 = a * Math.cos(ring.rz);
      const y1 = a * Math.sin(ring.rz);
      const y2 = y1 * Math.cos(ring.rx) - b * Math.sin(ring.rx);
      const z2 = y1 * Math.sin(ring.rx) + b * Math.cos(ring.rx);
      const buried = terrain.heightAt(ring.x + x1, ring.z + z2) - (ring.y + y2);
      if (buried > worst) worst = buried;
    }
  }
  return worst;
}

describe("the pickup ring", () => {
  it.each([1000, 8919, 24757, 40595])("seed %i keeps it out of the tarmac", (seed) => {
    const course = makeCourse(seed, 20);
    const { segments } = buildCourseSegments(course);
    const terrain = new Terrain(segments);
    const { renderer, rings } = ringRecorder();
    new PickupSystem(renderer, terrain);
    expect(rings.length).toBeGreaterThan(3);
    /*
     * Not zero: the ring is a rigid disc six units in radius and the road rolls
     * underneath it, so on a crest the rim follows a chord rather than the
     * surface. What is ruled out is the systematic burial that came of holding
     * it level - held level it reached a full unit under on the steepest
     * ground, and lying on the slope the residual is curvature alone.
     */
    expect(worstBurial(rings, terrain, CONFIG.pickups.radius)).toBeLessThan(0.35);
  });
});
