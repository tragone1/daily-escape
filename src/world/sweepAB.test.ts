/**
 * The quality the racing-line sweep actually delivers.
 *
 * `world.test.ts` asserts the SAFETY floor - that no course is undrivable.
 * This pins something different and tighter: the standard the sweep holds
 * itself to in practice, so a future change that quietly degrades the roads
 * while staying legal still fails.
 *
 * It exists because the sweep's sampling was coarsened for performance, which
 * is exactly the kind of change that trades quality for speed without saying
 * so. Measured A/B at the time: the fine sweep withdrew 115 props across these
 * seeds and left a narrowest lane of 7.5; the coarse one withdraws 87 and
 * leaves 7.25. A quarter of a unit, against a car 2.1 wide.
 */
import { describe, expect, it } from "vitest";
import { makeCourse } from "./course";
import { buildWorld } from "./courseBuilder";
import { stubRenderer } from "./testRenderer";
import { narrowestLane } from "./invariants";

const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 7919);

describe("racing-line quality", () => {
  it.each(SEEDS)("seed %i keeps a comfortable lane, not merely a legal one", (seed) => {
    const world = buildWorld(stubRenderer(), makeCourse(seed));
    const { worst, where } = narrowestLane(world.segments, world.colliders);
    /*
     * Audited at a quarter unit across and two along - finer than the sweep
     * itself samples, so this measures the OUTPUT rather than agreeing with
     * the method that produced it.
     */
    expect(worst, `narrowest at ${where}`).toBeGreaterThanOrEqual(7);
  });
});
