/**
 * What touching a police car costs you.
 *
 * This is here because the answer used to be "nothing, if you touch it at the
 * edge". The elastic response only charged for the closing speed along the
 * contact normal, and in a side-swipe that normal points across the road while
 * both cars travel along it - so the normal component was near zero and the
 * two cars slid through each other with a polite nudge. Measured before the
 * fix: a head-on at 1.5 units of lateral offset cost 34% of the player's
 * speed, and the same hit at 1.8 cost exactly 0%.
 *
 * The tests are written in terms of what a player experiences - forward speed
 * kept - rather than in terms of impulses, because forward speed is the thing
 * the whole game is scored on.
 */
import { describe, expect, it } from "vitest";
import { CollisionWorld } from "./collisionWorld";
import { Vehicle } from "../vehicle/vehicle";
import { CONFIG } from "../config";

/** Two cars nose to nose, offset sideways by `offset`, closing at 40 u/s. */
function headOn(offset: number): { forwardKept: number; sideways: number } {
  const world = new CollisionWorld([]);
  const player = new Vehicle(CONFIG.player.vehicle, { ...CONFIG.player.boost });
  const cop = new Vehicle(CONFIG.police.patrol.vehicle, { ...CONFIG.player.boost });
  cop.isPolice = true;

  // Facing +Z; the cop comes the other way, displaced along X.
  player.reset(0, 0, 0, 0);
  player.vx = 0;
  player.vz = 20;
  cop.reset(offset, 22, Math.PI, 0);
  cop.vx = 0;
  cop.vz = -20;

  const before = player.vz;
  let worst = before;
  let sideways = 0;
  for (let i = 0; i < 120; i++) {
    world.resolveCars(player, cop);
    player.x += player.vx / 60;
    player.z += player.vz / 60;
    cop.x += cop.vx / 60;
    cop.z += cop.vz / 60;
    worst = Math.min(worst, player.vz);
    sideways = Math.max(sideways, Math.abs(player.vx));
  }
  return { forwardKept: worst / before, sideways };
}

const COMBINED_HALF_WIDTH =
  CONFIG.player.vehicle.halfWidth + CONFIG.police.patrol.vehicle.halfWidth;

describe("hitting a police car", () => {
  it("stops a square head-on dead and throws you back", () => {
    const { forwardKept } = headOn(0);
    expect(forwardKept).toBeLessThan(0);
  });

  it("costs real speed on a glancing blow", () => {
    // The case that used to cost nothing at all.
    const { forwardKept, sideways } = headOn(1.8);
    expect(forwardKept).toBeLessThan(0.6);
    // ...and throws you off your line rather than letting you slide past.
    expect(sideways).toBeGreaterThan(2);
  });

  it("still costs something when only the edges meet", () => {
    const { forwardKept, sideways } = headOn(COMBINED_HALF_WIDTH - 0.06);
    expect(forwardKept).toBeLessThan(0.97);
    expect(sideways).toBeGreaterThan(1);
  });

  it("gets worse the deeper the overlap, with no cliff", () => {
    /*
     * The original failure was not that grazes were cheap - it was that the
     * cost fell off a cliff: 34% at 1.5 and 0% at 1.8. A monotone curve is the
     * property worth holding onto, because it is what makes the outcome feel
     * earned rather than arbitrary.
     */
    const deep = headOn(1.8).forwardKept;
    const mid = headOn(1.95).forwardKept;
    const edge = headOn(2.05).forwardKept;
    expect(deep).toBeLessThan(mid);
    expect(mid).toBeLessThan(edge);
  });

  it("does not touch you at all once the cars genuinely miss", () => {
    // Just past the sum of the half-widths there is no contact to charge for.
    const { forwardKept, sideways } = headOn(COMBINED_HALF_WIDTH + 0.1);
    expect(forwardKept).toBeCloseTo(1, 5);
    expect(sideways).toBe(0);
  });
});
