/**
 * A single police unit: the driving layer that turns a behaviour's goal into steering
 * and throttle, follows routes through the street graph, and digs itself out when stuck.
 *
 * Recovery is layered because a pursuit AI that gets wedged on a corner ruins a run:
 *   1. slow for a moment      -> reverse out at an angle
 *   2. still slow after that  -> keep reversing, re-plan
 *   3. slow for several sec.  -> teleport to a road node away from the player
 */

import type { Renderer } from "../gfx/renderer";

import { CONFIG, type PoliceRole } from "../config";
import { clamp, dist, forwardOf, headingOf, wrapAngle } from "../math";
import { CarView, policeStyle } from "../vehicle/carView";
import { Vehicle, type VehicleInput } from "../vehicle/vehicle";
import type { NavGraph, NavNode } from "../world/navGraph";
import {
  goalFor,
  type BehaviorTuning,
  type PursuitContext,
  type WardenAttack,
} from "./behaviors";

const ROLE_ACCENT: Record<PoliceRole, [number, number, number]> = {
  patrol: [0.15, 0.35, 0.95],
  heavy: [0.1, 0.75, 0.7],
  elite: [0.95, 0.05, 0.5],
  interceptor: [0.75, 0.15, 0.85],
  rammer: [0.95, 0.2, 0.15],
  blocker: [0.98, 0.65, 0.05],
  // Blood orange on charcoal. It should not look like the rest of the squad, because
  // trading paint with it is not the same decision as trading paint with the rest.
  juggernaut: [1.0, 0.28, 0.04],
  // Hot amber on charcoal: the keeper has to be identifiable at a glance, at speed,
  // against a night palette — you need to know which one you cannot simply shove aside.
  warden: [1.0, 0.5, 0.02],
};

export class PoliceCar {
  readonly vehicle: Vehicle;
  readonly view: CarView;

  private path: NavNode[] = [];
  private pathIndex = 0;
  /** Waypoint currently being driven to; kept across re-plans to avoid route flip-flop. */
  private committed: NavNode | null = null;
  private goalNodeId = -1;
  private replanTimer = 0;

  private repostTimer = 0;
  private stuckTimer = 0;
  private stuckTotal = 0;

  /** Seconds left spinning driverless after a rocket blast. */
  private disabledTimer = 0;
  /** Wrecked by a rocket: out of the run for good, but still a solid obstacle. */
  private wrecked = false;

  // Warden attack cycle. postX/postZ remember the gate it is meant to be holding.
  private postX: number | null = null;
  private postZ = 0;
  private wardenAttack: WardenAttack | null = null;
  private wardenTimer = 0;
  private wardenAttackCount = 0;
  private reverseTimer = 0;
  /** Latched turn direction for near-180-degree corrections; 0 = not turning around. */
  private turnSign = 0;

  /**
   * Charge state. `chargeTimer` counts down through the wind-up and then the run itself;
   * `charging` is false during the wind-up and true once it has committed.
   */
  private chargeTimer = 0;
  private chargeCooldown = 0;
  private charging = false;
  private readonly baseContactBoost: number;

  private input: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: false };

  /** Units stay dormant until the director wakes them. */
  active = false;

  /** Drop the unit onto a route node and wake it up. */
  placeAt(x: number, z: number, heading: number, y = 0): void {
    this.reset();
    this.vehicle.reset(x, z, heading, y);
    this.active = true;
    this.view.setEnabled(true);
  }

  deactivate(): void {
    this.active = false;
    this.view.setEnabled(false);
  }

  constructor(
    r: Renderer,
    readonly role: PoliceRole,
    private spawn: { x: number; z: number; heading: number },
    private tuning: BehaviorTuning = {},
  ) {
    const roleCfg = CONFIG.police[role] as {
      vehicle: typeof CONFIG.police.patrol.vehicle;
      impactResistance?: number;
      pushResistance?: number;
      contactBoost?: number;
    };
    const params = roleCfg.vehicle;
    this.vehicle = new Vehicle(params, { ...CONFIG.police.boost });
    // Heavier classes shrug off hits and shove harder; handled as vehicle modifiers so
    // the collision solver keeps a single code path for every car in the game.
    this.vehicle.impactResistance = roleCfg.impactResistance ?? 1;
    this.vehicle.pushResistance = roleCfg.pushResistance ?? 1;
    this.vehicle.contactBoost = roleCfg.contactBoost ?? 1;
    this.baseContactBoost = this.vehicle.contactBoost;
    this.vehicle.offCourseImmune = true;
    this.vehicle.reset(spawn.x, spawn.z, spawn.heading);
    this.view = new CarView(
      r,
      policeStyle(ROLE_ACCENT[role], role === "warden" || role === "juggernaut"),
      params.halfLength,
      params.halfWidth,
    );
  }

  /** The warden sits on a wider post than the light blockers do. */
  private get parkRadius(): number {
    return this.role === "warden"
      ? CONFIG.police.warden.parkRadius
      : CONFIG.police.blocker.parkRadius;
  }

  reset(): void {
    this.vehicle.reset(this.spawn.x, this.spawn.z, this.spawn.heading);
    this.path = [];
    this.committed = null;
    this.pathIndex = 0;
    this.goalNodeId = -1;
    this.replanTimer = 0;
    this.stuckTimer = 0;
    this.stuckTotal = 0;
    this.reverseTimer = 0;
    this.turnSign = 0;
    this.chargeTimer = 0;
    this.chargeCooldown = 0;
    this.charging = false;
    this.vehicle.contactBoost = this.baseContactBoost;
    this.vehicle.drive = 1;
    this.disabledTimer = 0;
    this.wardenAttack = null;
    this.wardenTimer = 0;
    this.wardenAttackCount = 0;
    this.postX = null;
    if (this.wrecked) {
      this.wrecked = false;
      this.view.setWrecked(false);
    }
    const roleCfg = CONFIG.police[this.role] as { pushResistance?: number };
    this.vehicle.pushResistance = roleCfg.pushResistance ?? 1;
  }

  distanceToPlayer(player: Vehicle): number {
    return dist(this.vehicle.x, this.vehicle.z, player.x, player.z);
  }

  get disabled(): boolean {
    return this.disabledTimer > 0;
  }

  /** Wrecked units no longer chase, and no longer count toward pinning the player. */
  get destroyed(): boolean {
    return this.wrecked;
  }

  /** Knocked out of the fight by an explosion: coasts and spins, no driver input. */
  disable(seconds: number): void {
    if (this.wrecked) return;
    this.disabledTimer = Math.max(this.disabledTimer, seconds);
  }

  /**
   * Destroyed outright. The hulk keeps its collider and stays where it comes to rest, so
   * blowing open a roadblock leaves real debris in the road behind you.
   */
  destroy(): void {
    if (this.wrecked) return;
    this.wrecked = true;
    // A hulk still has mass, but nobody is holding it in place any more. Without this a
    // wrecked heavy was a permanent wall, so spending the rocket on a roadblock could
    // build you a better one.
    this.vehicle.pushResistance = CONFIG.player.rocket.wreckPushResistance;
    this.disabledTimer = 0;
    this.path = [];
    this.committed = null;
    this.goalNodeId = -1;
    this.view.setWrecked(true);
  }

  update(dt: number, ctx: PursuitContext): void {
    const shared = CONFIG.police.shared;
    const v = this.vehicle;

    // A wreck: no driver, ever again. Let it coast to a stop and stay there.
    if (this.wrecked) {
      this.input.throttle = 0;
      this.input.brake = 0;
      this.input.steer = 0;
      this.input.boost = false;
      v.update(this.input, dt, ctx.terrain);
      // Scrub the blast off hard, but only the blast: below `wreckCoastSpeed` this stops
      // applying, so a hulk the player is shoving aside still moves freely.
      const rocket = CONFIG.player.rocket;
      if (v.speed > rocket.wreckCoastSpeed) {
        const k = Math.exp(-rocket.wreckDrag * dt);
        v.vx *= k;
        v.vz *= k;
      }
      return;
    }

    // Blown off the road: no steering, no throttle, just carry the momentum.
    if (this.disabledTimer > 0) {
      this.disabledTimer -= dt;
      this.input.throttle = 0;
      this.input.brake = 0;
      this.input.steer = 0;
      this.input.boost = false;
      // Clear pursuit state so it re-plans cleanly once the driver recovers.
      this.path = [];
      this.committed = null;
      this.goalNodeId = -1;
      this.stuckTimer = 0;
      this.stuckTotal = 0;
      v.update(this.input, dt, ctx.terrain);
      return;
    }

    this.replanTimer -= dt;
    this.repostTimer -= dt;
    this.updateCharge(dt, ctx);
    this.updateCatchUp(ctx);
    if (this.role === "warden") this.updateWardenAttack(dt, ctx);

    // A committed charge overrides goal selection entirely: it is already pointed at the
    // player and it is not going to reconsider halfway through.
    const goal = this.charging
      ? ({ kind: "direct", x: ctx.player.x + ctx.player.vx * 0.3, z: ctx.player.z + ctx.player.vz * 0.3 } as const)
      : goalFor(this.role, v, ctx, this.tuning, this.wardenAttack);

    let steerTargetX: number;
    let steerTargetZ: number;
    // Speed ceiling for the corner we are approaching; Infinity means "no limit".
    let cornerLimit = Infinity;
    // Distance to the post we are meant to sit on, or Infinity when not parking.
    let parkDistance = Infinity;

    if (goal.kind === "direct") {
      this.path = [];
      this.goalNodeId = -1;
      steerTargetX = goal.x;
      steerTargetZ = goal.z;
    } else {
      // A blocker holds its post between re-posts so it commits to a junction instead of
      // shuffling every time the player's route flickers between equal-length options.
      const holdPost = goal.kind === "park" && this.repostTimer > 0 && this.goalNodeId >= 0;
      const targetNodeId = holdPost ? this.goalNodeId : goal.nodeId;
      if (goal.kind === "park" && !holdPost) {
        this.repostTimer = CONFIG.police.blocker.repostInterval;
      }

      if (targetNodeId !== this.goalNodeId || this.replanTimer <= 0 || this.path.length === 0) {
        this.replan(ctx.nav, targetNodeId);
        this.replanTimer = shared.replanInterval;
      }
      const wp = this.currentWaypoint(shared.waypointRadius);
      steerTargetX = wp ? wp.x : goal.x;
      steerTargetZ = wp ? wp.z : goal.z;
      cornerLimit = this.cornerSpeedLimit();

      if (goal.kind === "park") {
        const post = ctx.nav.nodes[targetNodeId];
        this.postX = post.x;
        this.postZ = post.z;
        parkDistance = dist(v.x, v.z, post.x, post.z);
        // Slow down on the approach. Arriving at 40+ meant sailing straight past the
        // post and then having to turn around, which repeatedly wedged units against
        // walls and took them out of the run entirely.
        const cfg = CONFIG.police.blocker;
        if (parkDistance < cfg.approachDistance) {
          cornerLimit = Math.min(cornerLimit, cfg.approachSpeed);
        }
      }
    }

    this.driveToward(steerTargetX, steerTargetZ, cornerLimit, parkDistance, dt, ctx);
    v.update(this.input, dt, ctx.terrain);
  }

  /**
   * The charge.
   *
   * Line up, hold for the telegraph, then commit: extra pace and a much heavier shove for
   * a little over a second. Everything the hit itself does is handled by the ordinary
   * collision solver — this only decides *when* a unit throws itself at you, and makes
   * sure you can see it coming first.
   */
  private updateCharge(dt: number, ctx: PursuitContext): void {
    const cfg = CONFIG.police.charge;
    const v = this.vehicle;
    this.chargeCooldown -= dt;

    if (this.chargeTimer > 0) {
      this.chargeTimer -= dt;
      if (!this.charging && this.chargeTimer <= cfg.chargeTime) {
        // Wind-up over: commit.
        this.charging = true;
        v.contactBoost = this.baseContactBoost * cfg.contactBoost;
      }
      if (this.chargeTimer <= 0) {
        this.charging = false;
        this.chargeCooldown = cfg.cooldown;
        v.contactBoost = this.baseContactBoost;
      }
      // Telegraph brightens through the wind-up, then sits at full through the run.
      this.view.setCharge(
        this.charging ? 1 : clamp(1 - (this.chargeTimer - cfg.chargeTime) / cfg.telegraphTime, 0, 1),
      );
      return;
    }

    this.view.setCharge(0);
    if (this.chargeCooldown > 0) return;
    if (!(cfg.roles as readonly string[]).includes(this.role)) return;

    const player = ctx.player;
    const d = this.distanceToPlayer(player);
    if (d < cfg.minRange || d > cfg.maxRange) return;
    const err = Math.abs(wrapAngle(headingOf(player.x - v.x, player.z - v.z) - v.heading));
    if (err > cfg.maxHeadingError) return;
    if (!ctx.world.lineOfSight(v.x, v.z, player.x, player.z)) return;

    this.chargeTimer = cfg.telegraphTime + cfg.chargeTime;
    this.charging = false;
  }

  /**
   * Closing speed. A unit that is a long way off gets faster; one that is already on you
   * gets nothing. This is what stops "you passed them once" from meaning "they are out of
   * the run", which is how a straight-line driver used to escape the entire squad.
   */
  private updateCatchUp(ctx: PursuitContext): void {
    const cfg = CONFIG.police.shared.catchUp;
    const player = ctx.player;
    const v = this.vehicle;
    const charge = this.charging ? CONFIG.police.charge.speedBonus : 0;

    // Only units the player has *left* get the help. A car coming the other way is
    // already going to meet you; handing it closing speed as well just turns every
    // head-on into an unavoidable wall.
    const behind =
      player.speed > 6
        ? (v.x - player.x) * player.vx + (v.z - player.z) * player.vz < 0
        : false;
    if (!behind) {
      v.drive = 1 + charge;
      return;
    }

    const d = this.distanceToPlayer(player);
    const t = clamp((d - cfg.nearDistance) / (cfg.farDistance - cfg.nearDistance), 0, 1);
    v.drive = 1 + t * cfg.maxBonus + charge;
  }

  /**
   * Warden attack cycle: hold the gate, commit to an attack when the player comes into
   * range, break off, regroup, then commit again with the *other* attack. Alternating is
   * what stops one memorised approach line from beating it every run.
   */
  private updateWardenAttack(dt: number, ctx: PursuitContext): void {
    const cfg = CONFIG.police.warden;
    const v = this.vehicle;
    this.wardenTimer -= dt;

    if (this.wardenAttack !== null) {
      // Leash: a keeper that chases you halfway across the city has abandoned the goal.
      // Breaking off once it strays too far from its post is what keeps the ramp shut.
      const strayed =
        this.postX !== null &&
        dist(v.x, v.z, this.postX, this.postZ) > cfg.leashRange;
      if (this.wardenTimer <= 0 || strayed) {
        // Break off and regroup before the next commitment.
        this.wardenAttack = null;
        this.wardenTimer = cfg.recoverTime;
        this.replanTimer = 0;
        this.repostTimer = 0;
      }
      return;
    }

    if (this.wardenTimer > 0) return; // still recovering

    const inRange = this.distanceToPlayer(ctx.player) < cfg.engageRange;
    if (inRange && ctx.world.lineOfSight(v.x, v.z, ctx.player.x, ctx.player.z)) {
      this.wardenAttack = this.wardenAttackCount % 2 === 0 ? "charge" : "sweep";
      this.wardenAttackCount++;
      this.wardenTimer = cfg.attackTime;
      this.path = [];
      this.committed = null;
      this.goalNodeId = -1;
    }
  }

  /**
   * How fast we can afford to be travelling when we reach the current waypoint, based on
   * how sharp the turn after it is. Without this, units arrive at junctions flat out and
   * understeer into the corner building.
   */
  private cornerSpeedLimit(): number {
    const v = this.vehicle;
    const wp = this.path[this.pathIndex];
    const next = this.path[this.pathIndex + 1];
    if (!wp || !next) return Infinity;

    const inX = wp.x - v.x;
    const inZ = wp.z - v.z;
    const outX = next.x - wp.x;
    const outZ = next.z - wp.z;
    const inLen = Math.hypot(inX, inZ) || 1;
    const outLen = Math.hypot(outX, outZ) || 1;
    const turn = Math.acos(
      clamp((inX * outX + inZ * outZ) / (inLen * outLen), -1, 1),
    );

    const cfg = CONFIG.police.shared;
    if (turn < cfg.cornerTurnThreshold) return Infinity;
    // Only start braking once the junction is actually close.
    if (inLen > cfg.cornerLookahead) return Infinity;
    return cfg.cornerEntrySpeed;
  }

  /** Steering + throttle for a target point, including the stuck-recovery override. */
  private driveToward(
    tx: number,
    tz: number,
    cornerLimit: number,
    parkDistance: number,
    dt: number,
    ctx: PursuitContext,
  ): void {
    const shared = CONFIG.police.shared;
    const v = this.vehicle;

    const desired = headingOf(tx - v.x, tz - v.z);
    const err = wrapAngle(desired - v.heading);
    const speed = v.speed;

    // --- Stuck bookkeeping -------------------------------------------------
    // A blocker sitting on its post is stationary on purpose, so it must not count as
    // stuck — otherwise the recovery logic would reverse it off its post and eventually
    // teleport it away, which is exactly the opposite of its job.
    const parked = parkDistance < this.parkRadius;
    if (speed < shared.stuckSpeed && !parked) {
      this.stuckTimer += dt;
      this.stuckTotal += dt;
    } else {
      this.stuckTimer = 0;
      this.stuckTotal = Math.max(0, this.stuckTotal - dt * 2);
    }

    // Wandering off the drivable ribbon counts double: a unit ploughing through the
    // scenery is both useless and ugly, so it gets recycled quickly. Unless the player is
    // out there too — following someone into the wasteland is the job, and recycling
    // units for doing it would hand the player a way to shake the whole squad.
    if (!ctx.player.offCourse && !ctx.terrain.sample(v.x, v.z).onCourse) {
      this.stuckTotal += dt * 2;
    }

    if (this.stuckTotal > shared.respawnAfterStuck) {
      this.respawn(ctx);
      return;
    }

    if (this.reverseTimer <= 0 && this.stuckTimer > shared.stuckTime) {
      this.reverseTimer = shared.reverseTime;
    }

    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      // Back out on a curve so the nose swings toward where we actually want to go.
      // Vehicle already inverts steering in reverse, hence the sign flip here.
      this.input.throttle = 0;
      this.input.brake = 1;
      this.input.steer = clamp(-err / shared.steerFullLockAngle, -1, 1);
      this.input.boost = false;
      // Force a fresh route once we are moving again.
      this.replanTimer = 0;
      return;
    }

    // --- Normal driving ----------------------------------------------------
    const avoid = this.probeObstacles(ctx);
    const absErr = Math.abs(err);

    // Commit to a turn direction once the target is far enough behind us. Without this,
    // an error hovering near +/-PI flips sign every frame and the car saws the wheel
    // instead of turning: it ends up driving straight at the thing behind it.
    if (this.turnSign === 0) {
      if (absErr > shared.commitTurnAngle) this.turnSign = err >= 0 ? 1 : -1;
    } else if (absErr < shared.releaseTurnAngle) {
      this.turnSign = 0;
    }

    const steerBase =
      this.turnSign !== 0 ? this.turnSign : clamp(err / shared.steerFullLockAngle, -1, 1);
    const steer = clamp(steerBase + avoid.steerBias, -1, 1);

    let throttle = avoid.throttleScale;
    let brake = 0;

    if (absErr > 2.2 && speed < 8 && avoid.aheadBlocked) {
      // Facing the wrong way *and* boxed in: reverse out. On open road we simply drive
      // round in an arc instead — reversing there produced units moonwalking down
      // streets at a crawl.
      throttle = 0;
      brake = 1;
    } else if (absErr > shared.cornerBrakeAngle && speed > shared.cornerBrakeMinSpeed) {
      throttle = 0;
      brake = 0.65;
    } else if (speed > cornerLimit) {
      // Scrub off speed before the junction rather than during it.
      throttle = 0;
      brake = 0.5;
    } else if (absErr > shared.throttleEaseAngle) {
      throttle = Math.min(throttle, 0.45);
    }

    // Arrived at a post: sit on it. Coasting down rather than holding the brake avoids
    // the vehicle model rolling into reverse once it has stopped.
    if (parkDistance < this.parkRadius) {
      throttle = 0;
      brake = speed > 3 ? 1 : 0;
    }

    this.input.throttle = throttle;
    this.input.brake = brake;
    this.input.steer = steer;
    this.input.boost = this.wantsBoost(absErr, speed, parkDistance, ctx);
  }

  /**
   * Pursuit boost: only when trailing badly, pointed the right way and already rolling.
   * Gated this tightly so it reads as a unit winding up on a straight rather than
   * rubber-banding out of nowhere.
   */
  private wantsBoost(
    headingError: number,
    speed: number,
    parkDistance: number,
    ctx: PursuitContext,
  ): boolean {
    const cfg = CONFIG.police.boost;
    if (parkDistance < Infinity) return false;
    if (headingError > cfg.maxHeadingError) return false;
    // The warden boosts *into* its attack rather than to close distance — a two-tonne
    // SUV arriving fast is the whole point of the encounter.
    if (this.charging) return speed > 6;
    if (this.role === "warden" && this.wardenAttack !== null) return speed > 8;
    if (speed < cfg.minSpeed) return false;
    return this.distanceToPlayer(ctx.player) > cfg.minDistance;
  }

  /**
   * Three short rays (left / ahead / right) that steer the car away from geometry it is
   * about to scrape. Waypoint steering alone aims at junction centres, which is fine in
   * open road but grinds units along corners on the way in and out; the feelers turn
   * that into a smooth arc and double as lane-centring on straights.
   */
  private probeObstacles(ctx: PursuitContext): {
    steerBias: number;
    throttleScale: number;
    aheadBlocked: boolean;
  } {
    const cfg = CONFIG.police.shared;
    const v = this.vehicle;
    const reach = cfg.avoidFeelerBase + v.speed * cfg.avoidFeelerPerSpeed;

    const probe = (offset: number): number => {
      const a = v.heading + offset;
      return ctx.world.raycastDistance(v.x, v.z, Math.sin(a), Math.cos(a), reach) / reach;
    };

    const left = probe(-cfg.avoidAngle);
    const right = probe(cfg.avoidAngle);
    const ahead = probe(0);

    return {
      steerBias: (right - left) * cfg.avoidStrength,
      // Back off the throttle when there is something close directly in front.
      throttleScale: ahead < 0.5 ? 0.35 + ahead : 1,
      aheadBlocked: ahead < 0.45,
    };
  }

  private replan(nav: NavGraph, goalNodeId: number): void {
    const v = this.vehicle;

    // Finish the leg we are already on before re-routing. Two routes across a grid are
    // frequently the same length, so re-deriving the entry node every replan made units
    // flip between equal-cost options and saw back and forth at a junction. Committing
    // to the current waypoint also reads better: pursuit cars commit to a block.
    let start = this.committed;
    if (!start || dist(v.x, v.z, start.x, start.z) < CONFIG.police.shared.waypointRadius) {
      const dirX = v.speed > 3 ? v.vx : Math.sin(v.heading);
      const dirZ = v.speed > 3 ? v.vz : Math.cos(v.heading);
      start = nav.nearestNodeAhead(v.x, v.z, dirX, dirZ);
    }

    const path = nav.findPath(start.id, goalNodeId);
    if (path.length === 0) {
      // Committed node cannot reach the goal (should not happen on this map) — fall back.
      const fallback = nav.nearestNode(v.x, v.z);
      this.path = nav.findPath(fallback.id, goalNodeId);
    } else {
      this.path = path;
    }
    this.pathIndex = 0;
    this.goalNodeId = goalNodeId;
  }

  private currentWaypoint(radius: number): NavNode | null {
    const v = this.vehicle;
    const f = forwardOf(v.heading);

    while (this.pathIndex < this.path.length) {
      const node = this.path[this.pathIndex];
      const dx = node.x - v.x;
      const dz = node.z - v.z;
      const d = Math.hypot(dx, dz);
      const hasNext = this.pathIndex + 1 < this.path.length;

      // Reached it, or drove past it — either way move on. The "drove past" case matters
      // when a ram or a wide line carries a unit beyond the junction: without it, the
      // unit turns around to touch a waypoint it has already cleared.
      const overshot = hasNext && d < radius * 2.5 && dx * f.x + dz * f.z < 0;
      if (d < radius || overshot) {
        if (!hasNext) break;
        this.pathIndex++;
        continue;
      }
      this.committed = node;
      return node;
    }
    const last = this.path.length > 0 ? this.path[this.path.length - 1] : null;
    this.committed = last;
    return last;
  }

  /** Drop the unit back onto a road node, far enough away not to be a cheap shot. */
  private respawn(ctx: PursuitContext): void {
    const shared = CONFIG.police.shared;
    const player = ctx.player;

    let best: NavNode | null = null;
    let bestD = Infinity;
    for (const n of ctx.nav.nodes) {
      const d = dist(n.x, n.z, player.x, player.z);
      if (d < shared.respawnMinDistance) continue;
      if (!ctx.world.isClear(n.x, n.z, 3)) continue;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }

    const node = best ?? ctx.nav.nodes[0];
    const heading = headingOf(player.x - node.x, player.z - node.z);
    this.vehicle.reset(node.x, node.z, heading, node.y);
    this.path = [];
    this.committed = null;
    this.pathIndex = 0;
    this.goalNodeId = -1;
    this.replanTimer = 0;
    this.stuckTimer = 0;
    this.stuckTotal = 0;
    this.reverseTimer = 0;
    this.turnSign = 0;
  }

  syncView(dt: number, elapsed: number, groundY = 0): void {
    this.view.sync(this.vehicle, dt, elapsed, this.input.brake > 0, this.disabled, groundY);
  }
}
