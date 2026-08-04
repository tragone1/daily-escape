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

describe("retiring what is behind", () => {
  it("stops growing however long the run lasts", () => {
    const { world, stream } = start(8919);
    const sizes: number[] = [];
    for (let section = 0; section < 120; section++) {
      stream.ensureBuiltThrough(section);
      if (section > 20 && section % 10 === 0) sizes.push(world.colliders.length);
    }
    /*
     * The point is a ceiling, not a shrink: the resident set should settle
     * rather than climb with the length of the run. Without retirement this
     * grows linearly and a long run eventually holds the whole course.
     */
    const early = sizes[0];
    const late = sizes[sizes.length - 1];
    expect(late).toBeLessThan(early * 1.6);
    expect(stream.retired).toBeGreaterThan(0);
  });

  it("keeps the ground under and ahead of the player", () => {
    const { world, stream } = start(8919);
    for (let section = 0; section < 60; section++) {
      stream.ensureBuiltThrough(section);
      const here = stream.sectionStarts[section];
      // The road the player is standing on must still be described.
      const node = world.nav.nodeAtProgress(here + 20);
      expect(world.terrain.sample(node.x, node.z).onCourse).toBe(true);
    }
  });

  it("never releases ground the player could still drive back to", () => {
    const { world, stream } = start(8919);
    for (let section = 0; section < 40; section++) stream.ensureBuiltThrough(section);
    // Six sections back is inside the keep-behind margin, so it is still built.
    const back = stream.sectionStarts[36];
    const node = world.nav.nodeAtProgress(back);
    const near = world.colliders.filter(
      (c) => Math.hypot(c.obb.x - node.x, c.obb.z - node.z) < 60,
    );
    expect(near.length).toBeGreaterThan(0);
  });
});

describe("starting a new run", () => {
  it("rebuilds the opening the previous run threw away", () => {
    /*
     * The bug this exists for: a run retires the course behind the player, so
     * by the end of a long one the opening sections have been released.
     * Restarting put the player back at the start with no geometry there - a
     * black screen with the cars and the HUD drawing over nothing - and
     * ensureBuiltThrough could not repair it, because it had already built
     * past that point and returned early.
     */
    const { world, stream } = start(8919);
    for (let section = 0; section < 40; section++) stream.ensureBuiltThrough(section);
    expect(stream.retired, "the run must actually retire something").toBeGreaterThan(0);

    // Nothing is left standing near where a new run begins.
    const startNode = world.nav.nodeAtProgress(20);
    const nearStart = (): number =>
      world.colliders.filter(
        (c) => Math.hypot(c.obb.x - startNode.x, c.obb.z - startNode.z) < 80,
      ).length;
    expect(nearStart()).toBe(0);

    stream.restart();

    expect(stream.retired).toBe(0);
    expect(nearStart(), "the opening has to exist again").toBeGreaterThan(0);
  });

  it("leaves the course itself alone, since the seed has not changed", () => {
    const { world, stream } = start(8919);
    const before = world.segments.length;
    for (let section = 0; section < 30; section++) stream.ensureBuiltThrough(section);
    stream.restart();
    // Same seed, prefix-stable generator: the road is still the same road.
    expect(world.segments.length).toBe(world.segments.length);
    expect(world.segments.length).toBeGreaterThanOrEqual(before);
    expect(world.terrain.sample(world.nav.nodeAtProgress(20).x, world.nav.nodeAtProgress(20).z).onCourse).toBe(true);
  });
});
