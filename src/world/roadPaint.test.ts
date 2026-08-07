/**
 * Paint has to sit on the road, not above it.
 *
 * The centre-line dashes and the ramp lips are positioned by a hand-written
 * constant, and that constant is relative to a surface that has moved twice.
 * When the road was a half-unit slab centred on the height a segment reports,
 * its top face stood at +0.25 and the paint was written to land on that. The
 * slab was later dropped so its top face lands on the reported height, and the
 * spine became a zero-thickness ribbon at exactly that height - but the paint
 * constants were not re-based either time. Every dash on the course spent that
 * whole period hovering a quarter of a unit above the tarmac, which is invisible
 * on the flat and unmistakable at the crest of a hill.
 *
 * Nothing caught it because nothing was looking. A vertical offset is not the
 * kind of thing a build breaks on: it type-checks, it renders, it just floats.
 * So this measures the geometry that was actually handed to the renderer against
 * the ground the simulation puts the car on, which is the one comparison that
 * would have failed the day the road moved.
 */

import { describe, expect, it } from "vitest";
import { makeCourse } from "./course";
import { buildWorld } from "./courseBuilder";
import type { Renderer } from "../gfx/renderer";

interface BoxSpec {
  kind: string;
  width?: number;
  height?: number;
  depth?: number;
}

interface Placed {
  spec: BoxSpec;
  x: number;
  y: number;
  z: number;
}

/**
 * A renderer that keeps what it was given.
 *
 * The ordinary stub throws meshes away, which is right for tests about
 * colliders and lane widths - but the defect here lives entirely in geometry
 * that never becomes a collider, so it can only be seen by holding on to it.
 */
function recordingRenderer(): { renderer: Renderer; placed: Placed[] } {
  const placed: Placed[] = [];
  const mesh = (spec: BoxSpec) => {
    const entry: Placed = { spec, x: 0, y: 0, z: 0 };
    placed.push(entry);
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
    return {
      position,
      rotation: { x: 0, y: 0, z: 0 },
      scaling: { x: 1, y: 1, z: 1, set() {} },
      parent: null,
      isStatic: true,
      alpha: 1,
      dispose() {},
      isEnabled: () => true,
      setEnabled() {},
    };
  };
  const renderer = {
    createMesh: (spec: BoxSpec) => mesh(spec),
    createNode: () => mesh({ kind: "node" }),
    bake: () => {},
    bakeGrouped: () => {},
    disposeChunk: () => {},
    disposeChunkGroup: () => 0,
    forgetBaked: () => {},
  } as unknown as Renderer;
  return { renderer, placed };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** The centre-line dash, identified by the shape it is built from. */
const isDash = (p: Placed): boolean =>
  p.spec.kind === "box" && near(p.spec.width ?? 0, 0.5) && near(p.spec.height ?? 0, 0.12) && near(p.spec.depth ?? 0, 4.5);

/** The yellow bar across a jump. Width varies with the road, so key on the rest. */
const isRampLip = (p: Placed): boolean =>
  p.spec.kind === "box" && near(p.spec.height ?? 0, 0.5) && near(p.spec.depth ?? 0, 2.2);

const SEEDS = Array.from({ length: 8 }, (_, i) => 1000 + i * 7919);

/**
 * How far a marking may bed into the road.
 *
 * It must bed in at all - backface culling is off, so a marking landed exactly
 * flush has its underside coplanar with the road and shimmers against it. The
 * ceiling is loose enough not to care about the exact figure and tight enough
 * that the 0.25 the paint was stranded by cannot come back.
 */
const MIN_BED = 0.002;
const MAX_BED = 0.2;

describe("paint on the road", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: no centre-line dash floats above the tarmac`, () => {
      const { renderer, placed } = recordingRenderer();
      const world = buildWorld(renderer, makeCourse(seed));
      const dashes = placed.filter(isDash);
      // If the shape ever changes this test would silently pass on nothing.
      expect(dashes.length).toBeGreaterThan(50);

      let worstFloat = -Infinity;
      let worstBury = -Infinity;
      for (const d of dashes) {
        // The box is centred on its origin, so the underside is half a height down.
        const bottom = d.y - (d.spec.height ?? 0) / 2;
        const road = world.terrain.heightAt(d.x, d.z);
        worstFloat = Math.max(worstFloat, bottom - road);
        worstBury = Math.max(worstBury, road - bottom);
      }
      expect(worstFloat, "a dash is hovering over the road").toBeLessThanOrEqual(-MIN_BED);
      expect(worstBury, "a dash has sunk into the road").toBeLessThanOrEqual(MAX_BED);
    });
  }

  it("the ramp lip sits on the road too - it was stranded by the same commit", () => {
    for (const seed of SEEDS) {
      const { renderer, placed } = recordingRenderer();
      const world = buildWorld(renderer, makeCourse(seed));
      for (const lip of placed.filter(isRampLip)) {
        const bottom = lip.y - (lip.spec.height ?? 0) / 2;
        const road = world.terrain.heightAt(lip.x, lip.z);
        expect(bottom - road, `seed ${seed}`).toBeLessThanOrEqual(-MIN_BED);
        expect(road - bottom, `seed ${seed}`).toBeLessThanOrEqual(MAX_BED);
      }
    }
  });
});
