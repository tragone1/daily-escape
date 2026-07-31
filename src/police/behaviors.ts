/**
 * The pursuit behaviours. Each one answers a single question — "where should this unit be
 * driving right now?" — and hands back either a road-network goal (path to it), a direct
 * point (drive straight at it), or a post to sit on.
 *
 * All of them use plain geometry and range checks. No learning, no steering-behaviour
 * stacks: a player has to be able to read what each car is doing and counter it.
 */

import { CONFIG, type PoliceRole } from "../config";
import { clamp, dist, forwardOf, interceptTime, rightOf } from "../math";
import type { CollisionWorld } from "../physics/collisionWorld";
import type { NavGraph, NavNode } from "../world/navGraph";
import type { Terrain } from "../world/terrain";
import type { Vehicle } from "../vehicle/vehicle";

export type { PoliceRole };

export type Goal =
  | { kind: "direct"; x: number; z: number }
  | { kind: "node"; nodeId: number; x: number; z: number }
  | { kind: "park"; nodeId: number; x: number; z: number };

export interface PursuitContext {
  player: Vehicle;
  nav: NavGraph;
  world: CollisionWorld;
  terrain: Terrain;
  /**
   * Shortest route from the player's current junction to the exit, recomputed once per
   * frame. Because the objective never moves, this is knowable — and it is what lets the
   * blockers set up ahead of the player instead of trailing them.
   */
  escapeRoute: NavNode[];
}

/** Per-unit tuning that varies between members of the same role. */
export interface BehaviorTuning {
  predictionTime?: number;
  routeDepth?: number;
}

/** A station around the player, in the player's own frame. x is across, z is along. */
export interface BoxSlot {
  x: number;
  z: number;
}

/**
 * What `heavyGoal` needs from a role, structurally rather than by name.
 *
 * Three classes share that approach on different numbers, and one of them (the warden)
 * carries nothing else in common with the others — spelling the shape out here beats
 * widening a union every time another role adopts it.
 */
interface FlankConfig {
  readonly flankRange: number;
  readonly flankOffset: number;
  readonly strikeRange: number;
  readonly maxInterceptLead: number;
  /** Present only on the classes that specialise in the broadside. */
  readonly broadside?: {
    readonly alongWindow: number;
    readonly throughDepth: number;
    readonly lead: number;
  };
}

/**
 * Hold a station around the player rather than driving at them.
 *
 * This is the difference between a scrum and a cage. Every unit charging the same point
 * from the same direction produces a lot of contact and very little containment — the
 * collisions cancel, the player is shoved somewhere, and being shoved is being freed.
 * Units on stations match pace instead, and close the offset once they are on it.
 *
 * The forward stations are a brake-check: a car sitting ten units off your nose at your
 * own speed is not something you can drive through, and slowing down is what lets the
 * rest of the box shut.
 */
export function boxGoal(ctx: PursuitContext, slot: BoxSlot, press: number): Goal {
  const player = ctx.player;
  const right = rightOf(player.heading);
  const fwd = forwardOf(player.heading);
  const shrink = 1 - press;

  // Lead the station by the player's own motion so the unit arrives with them, not at
  // where they were.
  const lead = leadPoint(player, 0.25);
  return {
    kind: "direct",
    x: lead.x + right.x * slot.x * shrink + fwd.x * slot.z * shrink,
    z: lead.z + right.z * slot.x * shrink + fwd.z * slot.z * shrink,
  };
}

/**
 * RIG — parks broadside across the narrowest point it can find ahead of you.
 *
 * It does not pursue. `postX`/`postZ` are chosen by the driving layer, which is where the
 * road-width scouting lives; this only says "go there and stop".
 */
export function rigGoal(ctx: PursuitContext, post: NavNode | null): Goal {
  if (!post) return nodeGoal(ctx.nav, ctx.player.x, ctx.player.z);
  return { kind: "park", nodeId: post.id, x: post.x, z: post.z };
}

function nodeGoal(nav: NavGraph, x: number, z: number): Goal {
  const n = nav.nearestNode(x, z);
  return { kind: "node", nodeId: n.id, x: n.x, z: n.z };
}

/** Lead the target slightly so a ram connects instead of clipping the rear bumper. */
function leadPoint(player: Vehicle, seconds: number) {
  return { x: player.x + player.vx * seconds, z: player.z + player.vz * seconds };
}

/**
 * Where to aim to actually collide with a moving player, given our own top speed.
 * Falls back to a modest lead when the player is simply uncatchable from here.
 */
export function interceptPoint(self: Vehicle, player: Vehicle, maxLead: number) {
  const dx = player.x - self.x;
  const dz = player.z - self.z;
  // Use top speed rather than current speed: the unit will be accelerating into the hit.
  const t = interceptTime(dx, dz, player.vx, player.vz, self.params.maxSpeed);
  const lead = t === null ? 0.35 : clamp(t, 0, maxLead);
  return leadPoint(player, lead);
}

/**
 * Walk `distance` along the player's route to the exit and return the junction you land
 * on, never the terminal node (that one sits inside the exit corridor, past the gate).
 *
 * This is the counter to a player who simply beelines for the ramp. Extrapolating raw
 * velocity in a straight line points at the inside of a building as soon as the player
 * turns a corner, so units aiming that way end up trailing. Measuring the lead *along the
 * road network* puts them on the tarmac the player is actually going to use.
 */
function routeNodeAhead(ctx: PursuitContext, distance: number): NavNode | null {
  const route = ctx.escapeRoute;
  if (route.length === 0) return null;
  const last = Math.max(0, route.length - 2);

  let px = ctx.player.x;
  let pz = ctx.player.z;
  let travelled = 0;
  for (let i = 0; i <= last; i++) {
    const n = route[i];
    travelled += Math.hypot(n.x - px, n.z - pz);
    px = n.x;
    pz = n.z;
    if (travelled >= distance) return n;
  }
  return route[last];
}

/**
 * STANDARD PATROL — sits on your bumper. Follows the route network until it has a clear
 * view, then drives straight at you and tries to shunt you. The baseline unit.
 */
export function patrolGoal(self: Vehicle, ctx: PursuitContext): Goal {
  const shared = CONFIG.police.shared;
  const d = dist(self.x, self.z, ctx.player.x, ctx.player.z);
  const visible = ctx.world.lineOfSight(self.x, self.z, ctx.player.x, ctx.player.z);

  if (visible && d < shared.directPursuitRange) {
    const lead = leadPoint(ctx.player, d < CONFIG.police.patrol.ramRange ? 0.12 : 0.35);
    return { kind: "direct", x: lead.x, z: lead.z };
  }
  return nodeGoal(ctx.nav, ctx.player.x, ctx.player.z);
}

/**
 * HEAVY PURSUIT — the same two-stage approach as the rammer but on a bigger, slower
 * chassis. It commits earlier and from further out because it cannot correct late, and
 * once it is alongside its mass does the work.
 *
 * The juggernaut runs the identical logic on its own, longer ranges: the behaviour that
 * suits a heavy chassis is the behaviour that suits a heavier one.
 */
export function heavyGoal(
  self: Vehicle,
  ctx: PursuitContext,
  cfg: FlankConfig = CONFIG.police.heavy,
): Goal {
  const player = ctx.player;
  const d = dist(self.x, self.z, player.x, player.z);
  const visible = ctx.world.lineOfSight(self.x, self.z, player.x, player.z);

  const broadside = "broadside" in cfg ? cfg.broadside : null;

  if (visible && d < cfg.strikeRange) {
    /*
     * A specialist waits for the angle. Driving at the intercept the moment the player is
     * inside `strikeRange` means committing from wherever it happens to be, which from
     * behind is a rear-end - and nose-to-tail is the one contact that hands the player
     * speed. So it only commits once it is abeam, and then it aims *through* the far
     * side rather than at the player, which is what makes the contact normal lateral.
     */
    if (broadside) {
      const right = rightOf(player.heading);
      const fwd = forwardOf(player.heading);
      const along = (self.x - player.x) * fwd.x + (self.z - player.z) * fwd.z;
      const side = (self.x - player.x) * right.x + (self.z - player.z) * right.z >= 0 ? 1 : -1;
      if (Math.abs(along) <= broadside.alongWindow) {
        const lead = leadPoint(player, broadside.lead);
        return {
          kind: "direct",
          x: lead.x - right.x * broadside.throughDepth * side,
          z: lead.z - right.z * broadside.throughDepth * side,
        };
      }
      // Not abeam yet: keep pacing it on the flank rather than lunging early.
      const aim = interceptPoint(self, player, cfg.maxInterceptLead);
      return {
        kind: "direct",
        x: aim.x + right.x * cfg.flankOffset * side,
        z: aim.z + right.z * cfg.flankOffset * side,
      };
    }
    const aim = interceptPoint(self, player, cfg.maxInterceptLead);
    return { kind: "direct", x: aim.x, z: aim.z };
  }

  if (visible && d < cfg.flankRange) {
    const right = rightOf(player.heading);
    const fwd = forwardOf(player.heading);
    const side = (self.x - player.x) * right.x + (self.z - player.z) * right.z >= 0 ? 1 : -1;
    const aim = interceptPoint(self, player, cfg.maxInterceptLead);
    return {
      kind: "direct",
      x: aim.x + right.x * cfg.flankOffset * side + fwd.x * 3,
      z: aim.z + right.z * cfg.flankOffset * side + fwd.z * 3,
    };
  }

  return nodeGoal(ctx.nav, player.x, player.z);
}

/**
 * ELITE — route-leads like an interceptor but on a short horizon, and closes to a ram
 * rather than a block. Fast and unpleasant; used sparingly and late.
 */
export function eliteGoal(self: Vehicle, ctx: PursuitContext): Goal {
  const cfg = CONFIG.police.elite;
  const player = ctx.player;
  const d = dist(self.x, self.z, player.x, player.z);

  if (d < cfg.commitRange && ctx.world.lineOfSight(self.x, self.z, player.x, player.z)) {
    const aim = interceptPoint(self, player, 1.6);
    return { kind: "direct", x: aim.x, z: aim.z };
  }

  const travel = clamp(
    player.speed * cfg.predictionTime,
    CONFIG.police.interceptor.minPrediction,
    CONFIG.police.interceptor.maxPredictionDistance,
  );
  const post = routeNodeAhead(ctx, travel);
  if (post) return { kind: "node", nodeId: post.id, x: post.x, z: post.z };
  return nodeGoal(ctx.nav, player.x, player.z);
}

/**
 * INTERCEPTOR — never aims at where you are. It extrapolates your current velocity
 * forward, snaps that guess to the nearest junction, and races there to be sitting in the
 * road when you arrive. Only once it is on top of you does it switch to blocking.
 *
 * The squad runs two of these on different horizons: a short one that keeps stealing the
 * next junction, and a long one that commits to a cut-off several blocks away.
 */
export function interceptorGoal(
  self: Vehicle,
  ctx: PursuitContext,
  tuning: BehaviorTuning,
): Goal {
  const cfg = CONFIG.police.interceptor;
  const player = ctx.player;
  const d = dist(self.x, self.z, player.x, player.z);

  if (d < cfg.commitRange && ctx.world.lineOfSight(self.x, self.z, player.x, player.z)) {
    const lead = leadPoint(player, 0.55);
    return { kind: "direct", x: lead.x, z: lead.z };
  }

  // How far the player will get in the prediction window, measured along the roads they
  // would actually drive rather than as the crow flies.
  const horizon = tuning.predictionTime ?? cfg.predictionTime;
  const travel = clamp(player.speed * horizon, cfg.minPrediction, cfg.maxPredictionDistance);
  const post = routeNodeAhead(ctx, travel);
  if (post) return { kind: "node", nodeId: post.id, x: post.x, z: post.z };

  // No route available (player somewhere the graph cannot reach): fall back to the old
  // straight-line guess so the unit still does something sensible.
  const f = forwardOf(player.heading);
  return nodeGoal(ctx.nav, player.x + f.x * 40, player.z + f.z * 40);
}

/**
 * RAMMER — closes in, swings out to whichever flank it is already nearest, matches your
 * pace alongside, then turns in. The two-stage approach is what makes it feel different
 * from the chaser rather than just being a second tailgater.
 */
export function rammerGoal(self: Vehicle, ctx: PursuitContext): Goal {
  const cfg = CONFIG.police.rammer;
  const player = ctx.player;
  const d = dist(self.x, self.z, player.x, player.z);
  const visible = ctx.world.lineOfSight(self.x, self.z, player.x, player.z);

  if (visible && d < cfg.strikeRange) {
    // Aim where the player *will* be, not where they are. Chasing the current position
    // means permanently arriving a car length late; solving the intercept is what turns
    // the rammer from an irritant into something that reliably connects.
    const aim = interceptPoint(self, player, cfg.maxInterceptLead);
    return { kind: "direct", x: aim.x, z: aim.z };
  }

  if (visible && d < cfg.flankRange) {
    const right = rightOf(player.heading);
    const fwd = forwardOf(player.heading);
    const side = (self.x - player.x) * right.x + (self.z - player.z) * right.z >= 0 ? 1 : -1;
    const lead = leadPoint(player, 0.4);
    return {
      kind: "direct",
      x: lead.x + right.x * cfg.flankOffset * side + fwd.x * 3,
      z: lead.z + right.z * cfg.flankOffset * side + fwd.z * 3,
    };
  }

  return nodeGoal(ctx.nav, player.x, player.z);
}

/**
 * BLOCKER — the unit that thinks a move ahead.
 *
 * It takes the player's shortest route to the exit and walks `routeDepth` junctions along
 * it, then parks there. Negative depths index from the exit end, so -2 means "the last
 * junction before the ramp" — that unit is effectively guarding the finish line all run.
 * Once you get close it stops being scenery and body-blocks.
 */
export function blockerGoal(self: Vehicle, ctx: PursuitContext, tuning: BehaviorTuning): Goal {
  const cfg = CONFIG.police.blocker;
  const player = ctx.player;
  const d = dist(self.x, self.z, player.x, player.z);

  if (d < cfg.engageRange && ctx.world.lineOfSight(self.x, self.z, player.x, player.z)) {
    const lead = leadPoint(player, 0.45);
    return { kind: "direct", x: lead.x, z: lead.z };
  }

  const route = ctx.escapeRoute;
  if (route.length === 0) return nodeGoal(ctx.nav, player.x, player.z);

  // Never post on the final node: that one sits inside the exit corridor, past the gate,
  // where a parked car is out of the play area entirely (and can be shunted through the
  // finish). Clamping here also means that as the player closes in and the route gets
  // short, the picket collapses onto the last junction instead of piling into the ramp.
  const lastPostable = Math.max(0, route.length - 2);
  const depth = tuning.routeDepth ?? 2;
  const index = depth < 0 ? route.length + depth : depth;
  const post = route[clamp(index, 0, lastPostable)];
  return { kind: "park", nodeId: post.id, x: post.x, z: post.z };
}

export function goalFor(
  role: PoliceRole,
  self: Vehicle,
  ctx: PursuitContext,
  tuning: BehaviorTuning,
): Goal {
  switch (role) {
    case "rig":
      // Handled by the driving layer, which owns the scouting; never reached.
      return nodeGoal(ctx.nav, ctx.player.x, ctx.player.z);
    case "patrol":
      return patrolGoal(self, ctx);
    case "heavy":
      return heavyGoal(self, ctx);
    case "juggernaut":
      return heavyGoal(self, ctx, CONFIG.police.juggernaut);
    case "elite":
      return eliteGoal(self, ctx);
    case "interceptor":
      return interceptorGoal(self, ctx, tuning);
    case "rammer":
      return rammerGoal(self, ctx);
    case "blocker":
      return blockerGoal(self, ctx, tuning);
    case "warden":
      // Same hunter as the juggernaut, on its own numbers. It used to hold a gate and
      // attack in leashed bursts, which never connected.
      return heavyGoal(self, ctx, CONFIG.police.warden);
  }
}
