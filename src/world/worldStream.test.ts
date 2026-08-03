/**
 * The course has to keep going, and it has to stay correct while it does.
 *
 * Two failure modes matter here and neither shows up on screen straight away:
 * the road running out ahead of a fast player, and a section built at a seam
 * as though its neighbours were bare ground.
 */
import { describe, expect, it } from "vitest";
import { CollisionWorld } from "../physics/collisionWorld";
import { Terrain } from "./terrain";
import { NavGraph } from "./navGraph";
import { buildCourseSegments, makeCourse } from "./course";
import { stubRenderer } from "./testRenderer";
import { WorldStream, type StreamedWorld } from "./worldStream";
import { narrowestLane, worstWallBite, CAR } from "./invariants";

function start(seed: number, sections = 8) {
  const course = makeCourse(seed, sections);
  const segments = buildCourseSegments(course).segments;
  const world: StreamedWorld = {
    segments,
    terrain: new Terrain(segments),
    colliders: [],
    nav: NavGraph.fromCourse(segments),
    blocksWithdrawn: 0,
  };
  const collision = new CollisionWorld([]);
  const stream = new WorldStream(stubRenderer(), seed, world, collision, sections);
  return { world, collision, stream };
}

describe("a streamed course", () => {
  it("builds road ahead of the player", () => {
    const { world, stream } = start(8919);
    stream.ensureBuiltThrough(0);
    const first = world.colliders.length;
    expect(first).toBeGreaterThan(0);

    stream.ensureBuiltThrough(6);
    expect(world.colliders.length).toBeGreaterThan(first);
  });

  it("never runs out, however far the player gets", () => {
    const { world, stream } = start(8919);
    for (let section = 0; section < 80; section++) {
      stream.ensureBuiltThrough(section);
      // The road must exist beyond where the player stands, not merely up to it.
      const reach = stream.sectionStarts[Math.min(section + 1, stream.sectionCount - 1)];
      expect(world.terrain.mainLength).toBeGreaterThan(reach);
    }
    expect(stream.sectionCount).toBeGreaterThan(80);
  });

  it("keeps the road drivable across every seam it builds", () => {
    const { world, stream } = start(8919);
    for (let section = 0; section < 24; section++) stream.ensureBuiltThrough(section);
    const built = world.segments.filter((s) => s.sectionIndex < 24);
    const { worst, where } = narrowestLane(built, world.colliders);
    expect(worst, `narrowest lane at ${where}`).toBeGreaterThanOrEqual(6.5);
    expect(worstWallBite(built, world.colliders)).toBeLessThan(CAR * 2);
  });

  it("keeps the objects the game holds, rather than replacing them", () => {
    const { world, collision, stream } = start(8919);
    const terrain = world.terrain;
    stream.ensureBuiltThrough(0);
    stream.ensureBuiltThrough(10);
    // A new Terrain or CollisionWorld would leave every holder pointing at the
    // old world - the police context, every unit, the game itself.
    expect(world.terrain).toBe(terrain);
    expect(collision.colliders).toBe(world.colliders);
  });

  it("does no work when the road is already long enough", () => {
    const { stream } = start(8919);
    stream.ensureBuiltThrough(10);
    expect(stream.ensureBuiltThrough(0)).toBe(false);
    expect(stream.ensureBuiltThrough(1)).toBe(false);
  });

  it("extends the course itself when the window reaches its end", () => {
    const { stream } = start(8919, 8);
    expect(stream.sectionCount).toBe(8);
    stream.ensureBuiltThrough(7);
    expect(stream.sectionCount).toBeGreaterThan(8);
  });
});
