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
import { makeCourse, buildCourseSegments } from "../world/course";
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

function runChase(steps: number): string {
  const course = makeCourse(8919, 12);
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
  let progress = 60;

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
    police.update(dt, ctx, step * dt, Math.floor(step / 600));
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
  return `${parts.length}|${parts.join(",")}`;
}

/*
 * Captured before the juggernaut machinery was cut out of the AI. The whole
 * point of that deletion was that it removed nothing live: every branch of it
 * was already unreachable, its class disabled twice over. If this value moves,
 * something that was running went with it.
 */
const BASELINE =
  "7|patrol:-317.8:261.3:40.4,patrol:-370.7:649.1:37.6,patrol:-44.5:38.7:21.8," +
  "patrol:-45.6:36.3:34.2,patrol:-65.2:72.5:21.7,patrol:-74.2:64.4:35.3," +
  "patrol:-77.4:99.0:22.1";

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
