/**
 * A behavioural fingerprint of the pursuit.
 *
 * Exists for one job: to make a refactor prove it changed nothing. The police
 * AI is two and a half thousand lines with a lot of dead weight in it, and
 * dead weight can only be cut safely if there is something that notices when
 * live code goes with it. Random draws are seeded, so the same inputs give the
 * same chase every time and the hash below is stable.
 *
 * It asserts no particular arrangement of cars - only that the arrangement does
 * not change when it was not meant to. Update the expected value deliberately,
 * never to make a red test green.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PoliceManager } from "./policeManager";
import { CollisionWorld } from "../physics/collisionWorld";
import { Vehicle } from "../vehicle/vehicle";
import { CONFIG } from "../config";
import { makeCourse, buildCourseSegments, setActiveCourse } from "../world/course";
import { buildWorld } from "../world/courseBuilder";
import { Terrain } from "../world/terrain";
import { NavGraph } from "../world/navGraph";
import { stubRenderer } from "../world/testRenderer";

/** A small deterministic generator, so a chase replays exactly. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const realRandom = Math.random;
beforeEach(() => {
  Math.random = seeded(12345);
});
afterEach(() => {
  Math.random = realRandom;
});

/** Which behaviour modes actually ran, so coverage is a fact rather than a hope. */
export interface ChaseRun {
  print: string;
  modes: Set<string>;
}

function runChase(steps: number): string {
  return chase(steps).print;
}

function chase(steps: number, startSection = 0): ChaseRun {
  const course = makeCourse(8919, 16);
  // The director reads the ACTIVE course for its alleys, as the game does.
  setActiveCourse(course);
  const { segments } = buildCourseSegments(course);
  const world = buildWorld(stubRenderer(), course);
  const terrain = new Terrain(segments);
  const nav = NavGraph.fromCourse(segments);
  const collision = new CollisionWorld(world.colliders);
  const police = new PoliceManager(stubRenderer(), nav, terrain);

  const player = new Vehicle(CONFIG.player.vehicle, { ...CONFIG.player.boost });
  const startNode = nav.nodeAtProgress(60);
  player.reset(startNode.x, startNode.z, 0, startNode.y);

  const ctx = police.buildContext({ player, nav, world: collision, terrain });
  const dt = 1 / 60;
  const starts = course.sectionStarts;
  let progress = Math.max(60, starts[Math.min(startSection, starts.length - 1)] + 40);
  const modes = new Set<string>();

  for (let step = 0; step < steps; step++) {
    // Rail the player forward so the only variable is what the police do.
    progress += 38 * dt;
    const a = nav.nodeAtProgress(progress);
    const b = nav.nodeAtProgress(progress + 6);
    player.x = a.x;
    player.z = a.z;
    player.y = a.y;
    player.heading = Math.atan2(b.x - a.x, b.z - a.z);
    // `speed` is derived from the velocity, so setting the velocity is what
    // makes the player look like they are travelling at all.
    player.vx = Math.sin(player.heading) * 38;
    player.vz = Math.cos(player.heading) * 38;
    police.update(dt, ctx, step * dt, startSection + Math.floor(step / 600));

    // Record which branches the run actually exercised.
    for (const u of police.units) {
      if (!u.active) continue;
      if (u.ambushAt) modes.add("alley-wait");
      if (u.welded) modes.add("welded");
      if (u.role === "rig") modes.add("rig");
      if (u.blocking) modes.add("slide-block");
      modes.add(`role:${u.role}`);
    }
  }

  // Fingerprint: where everyone ended up, rounded so floating-point noise
  // between platforms cannot fail the test on its own.
  const parts: string[] = [];
  for (const u of police.units) {
    if (!u.active) continue;
    parts.push(
      `${u.role}:${u.vehicle.x.toFixed(1)}:${u.vehicle.z.toFixed(1)}:${u.vehicle.speed.toFixed(1)}`,
    );
  }
  parts.sort();
  return { print: `${parts.length}|${parts.join(",")}`, modes };
}

/*
 * A fingerprint of the chase, to refactor against.
 *
 * Re-taken when the squad was taught to close the angles around a slowed
 * player. That is a deliberate behaviour change, so the value moved with it -
 * the cars really do go somewhere different now. Anything that moves this
 * value WITHOUT intending to has changed the pursuit by accident.
 */
const BASELINE =
  "7|patrol:-10.4:81.7:21.4,patrol:-159.4:152.7:45.6,patrol:-20.6:20.5:23.9," +
  "patrol:-45.0:25.0:35.8,patrol:-62.1:70.4:21.6,patrol:-71.2:59.9:35.7," +
  "patrol:-76.7:98.6:21.9";

describe("the pursuit", () => {
  it("is unchanged by refactoring", () => {
    expect(runChase(400)).toBe(BASELINE);
  });

  it("plays out the same way twice", () => {
    const a = runChase(400);
    const b = runChase(400);
    expect(b).toBe(a);
  });

  it("actually dispatches cars", () => {
    const print = runChase(400);
    const count = Number(print.split("|")[0]);
    expect(count).toBeGreaterThan(3);
  });
});

describe("what the fingerprint actually covers", () => {
  it("exercises the modes a refactor could break", () => {
    /*
     * Recorded because a fingerprint only proves what it runs. Cutting the
     * juggernaut out, an earlier version of this test stayed green while the
     * alley launch lost the branch that computed its own timing - no unit had
     * entered an alley in four hundred frames. Coverage is asserted now
     * rather than assumed.
     */
    const { modes } = chase(2400, 6);
    const seen = [...modes].sort();
    expect(seen, `saw: ${seen.join(", ")}`).toContain("alley-wait");
    expect(seen, `saw: ${seen.join(", ")}`).toContain("rig");
    expect(seen.filter((m) => m.startsWith("role:")).length).toBeGreaterThan(3);
  });
});
