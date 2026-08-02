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
import { interceptPoint } from "./behaviors";
import {
  boxGoal,
  goalFor,
  rigGoal,
  type BehaviorTuning,
  type BoxSlot,
  type Goal,
  type PursuitContext,
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
  // Hazard yellow on charcoal, like a works vehicle. It is not chasing anybody.
  rig: [0.98, 0.78, 0.06],
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

  private reverseTimer = 0;
  /** Latched turn direction for near-180-degree corrections; 0 = not turning around. */
  private turnSign = 0;
  /** Latched dodge side for a narrow obstacle dead ahead; 0 = nothing to dodge. */
  private dodgeSign = 0;

  /**
   * Charge state. `chargeTimer` counts down through the wind-up and then the run itself;
   * `charging` is false during the wind-up and true once it has committed.
   */
  private chargeTimer = 0;
  private chargeCooldown = 0;
  private charging = false;
  private readonly baseContactBoost: number;

  private input: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: false };

  /** Station handed out by the director; null means "chase normally". */
  boxSlot: BoxSlot | null = null;
  /** While set, the unit is holding in a spur waiting to launch. The mouth it faces. */
  ambushAt: { x: number; z: number } | null = null;
  /** Outward unit vector of the spur (seat toward mouth), set when seated. */
  ambushOut: { x: number; z: number } | null = null;
  /** Mouth and outward axis of the last alley, kept after firing for the slink-back. */
  private lastMouth: { x: number; z: number; ox: number; oz: number } | null = null;
  private ambushWait = 0;
  /** Mouth of the spur it sprang from, held while it is still steering the strike. */
  private springFrom: { x: number; z: number } | null = null;
  /** Outward unit vector through the mouth, set at spring time; null once clear of it. */
  private springExit: { x: number; z: number } | null = null;
  /** Seconds left of holding a struck player against the wall. */
  private pinTimer = 0;
  /** The weld: player's offset in the truck frame, latched at first contact. */
  private glueLocal: { along: number; lateral: number } | null = null;
  /** The collision solver stands down for a welded pair: the weld IS the contact. */
  get welded(): boolean {
    return this.glueLocal !== null;
  }
  /** One backed-up second attempt per ambush, then it is spent for real. */
  private retries = 0;
  /** Exit-phase deadline: geometry that never "clears" must not trap the strike. */
  private exitClock = 0;
  private springPSpd = 0;
  /** Section-scaled aggression, set by the director: quicker, more frequent charges. */
  aggro = 0;
  /**
   * An ambusher that has taken its shot, hit or miss.
   *
   * Only the armoured pair ever set this. They exist to make one strike out of one alley;
   * a spent one that rejoins the chase is just another heavy in the pack, which is the
   * thing they were pulled out of. The director stands them down once out of sight.
   */
  spent = false;
  /** How far the station has been closed in, 0..1. */
  private boxPress = 0;

  /** RIG: the spot it is blocking, and when it may pick a different one. */
  private rigPost: NavNode | null = null;
  private rigTimer = 0;
  private rigScore = Infinity;

  /** Units stay dormant until the director wakes them. */
  active = false;

  /** Park a rig on the spot it was placed at, so it holds rather than scouting anew. */
  parkAt(node: NavNode): void {
    this.rigPost = node;
    this.rigScore = -Infinity;
    this.rigTimer = Infinity;
  }

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
      broadsideBoost?: number;
    };
    const params = roleCfg.vehicle;
    this.vehicle = new Vehicle(params, { ...CONFIG.police.boost });
    // Heavier classes shrug off hits and shove harder; handled as vehicle modifiers so
    // the collision solver keeps a single code path for every car in the game.
    this.vehicle.impactResistance = roleCfg.impactResistance ?? 1;
    this.vehicle.pushResistance = roleCfg.pushResistance ?? 1;
    this.vehicle.contactBoost = roleCfg.contactBoost ?? 1;
    this.vehicle.broadsideBoost = roleCfg.broadsideBoost ?? 1;
    this.baseContactBoost = this.vehicle.contactBoost;
    this.vehicle.isPolice = true;
    this.vehicle.reset(spawn.x, spawn.z, spawn.heading);
    /*
     * The juggernaut is DRAWN at its strike-collider width (one big box), not
     * its resting width. Every other car's visual matches the box that hits
     * you; drawing this one narrow while it catches with the wide strike box
     * meant side latches gripped visibly empty air. The physics params are
     * untouched - this is purely what the mesh looks like.
     */
    const viewHalfWidth =
      role === "juggernaut"
        ? CONFIG.police.escalation.openRoad.ambush.bladeHalfWidth
        : params.halfWidth;
    this.view = new CarView(
      r,
      policeStyle(
        ROLE_ACCENT[role],
        role === "juggernaut" || role === "rig",
      ),
      params.halfLength,
      viewHalfWidth,
      role === "juggernaut",
    );
  }

  /** Rigs sit on a wider post than the light blockers do. */
  private get parkRadius(): number {
    if (this.role === "rig") return CONFIG.police.rig.parkRadius;
    return CONFIG.police.blocker.parkRadius;
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
    this.dodgeSign = 0;
    this.chargeTimer = 0;
    this.chargeCooldown = 0;
    this.charging = false;
    this.boxSlot = null;
    this.boxPress = 0;
    this.ambushAt = null;
    this.ambushOut = null;
    this.lastMouth = null;
    this.ambushWait = 0;
    this.springFrom = null;
    this.springExit = null;
    this.pinTimer = 0;
    this.glueLocal = null;
    this.retries = 0;
    this.exitClock = 0;
    this.spent = false;
    this.rigPost = null;
    this.rigTimer = 0;
    this.rigScore = Infinity;
    this.vehicle.contactBoost = this.baseContactBoost;
    this.vehicle.drive = 1;
    this.disabledTimer = 0;
    if (this.wrecked) {
      this.wrecked = false;
      this.view.setWrecked(false);
    }
    const roleCfg = CONFIG.police[this.role] as { pushResistance?: number };
    this.vehicle.pushResistance = roleCfg.pushResistance ?? 1;
  }

  /**
   * Ambush tuning for this class.
   *
   * The armoured pair run their own, deliberately overtuned set: they get one shot from
   * one alley and nothing else, so it has to land. Everything else uses the shared
   * numbers, which are built to be read and beaten.
   */
  private get ambushTuning() {
    const openRoad = CONFIG.police.escalation.openRoad;
    return openRoad.roles.includes(this.role)
      ? openRoad.ambush
      : CONFIG.police.pacing.ambush;
  }

  /** True for the two classes that exist only to ambush. */
  private get isAmbusher(): boolean {
    return CONFIG.police.escalation.openRoad.roles.includes(this.role);
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
    // Set so that mass * pushResistance lands on `wreckMass` whatever the class weighed.
    // A plain multiplier left the eight-tonne rig heavier than the player even at a tenth,
    // so blowing up a roadblock produced a roadblock.
    this.vehicle.pushResistance =
      CONFIG.player.rocket.wreckMass / Math.max(0.1, this.vehicle.params.mass);
    this.disabledTimer = 0;
    this.path = [];
    this.committed = null;
    this.goalNodeId = -1;
    this.view.setWrecked(true);
  }

  update(dt: number, ctx: PursuitContext): void {
    const shared = CONFIG.police.shared;
    const v = this.vehicle;
    v.plow = false;
    v.jam = false;
    // The strike owns the truck: a charge committing mid-ambush was a second driver
    // fighting the wheel at the moment of contact.
    if (this.isAmbusher && (this.ambushAt || this.springFrom || this.pinTimer > 0)) {
      this.charging = false;
      this.chargeTimer = 0;
    }

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

    /*
     * Spent: the shot is over, hit or miss, and this class does not get a second one.
     * It rolls to a stop rather than turning into another heavy on your bumper, and the
     * director stands it down as soon as you are not looking at it.
     */
    if (this.spent) {
      this.input.throttle = 0;
      this.input.brake = v.speed > 1 ? 1 : 0;
      this.input.steer = 0;
      this.input.boost = false;
      this.view.setCharge(0);
      v.drive = 1;
      v.update(this.input, dt, ctx.terrain);
      return;
    }

    /*
     * A spent ambusher brakes to a natural stop and stays put until the director
     * retires it. Without this it FROZE mid-road: the strike branch re-declared it
     * spent every frame and returned before ever driving the vehicle - a statue
     * parked in the open, which the player met and reasonably called a sitting
     * duck. A decelerating truck reads as a failed charge; a statue reads as a bug.
     */
    if (this.isAmbusher && this.spent) {
      if (v.params.halfWidth > CONFIG.police.juggernaut.vehicle.halfWidth + 0.01) {
        v.params = { ...v.params, halfWidth: CONFIG.police.juggernaut.vehicle.halfWidth };
      }
      /*
       * A missed shot does not leave a truck parked in the middle of the road - it
       * slinks back into the alley it came from and disappears there. Only when the
       * alley is genuinely out of reach does it settle where it stands.
       */
      const m = this.lastMouth;
      if (m) {
        const hx = m.x - m.ox * 12;
        const hz = m.z - m.oz * 12;
        const toHide = dist(v.x, v.z, hx, hz);
        if (toHide > 3 && dist(v.x, v.z, m.x, m.z) < 55) {
          this.input.throttle = v.speed > 11 ? 0 : 0.55;
          this.input.brake = 0;
          this.input.steer = clamp(
            wrapAngle(headingOf(hx - v.x, hz - v.z) - v.heading) /
              CONFIG.police.shared.steerFullLockAngle,
            -1,
            1,
          );
          this.input.boost = false;
          this.view.setCharge(0);
          v.drive = 1;
          v.update(this.input, dt, ctx.terrain);
          return;
        }
      }
      this.input.throttle = 0;
      this.input.brake = v.speed > 0.5 ? 1 : 0;
      this.input.steer = 0;
      this.input.boost = false;
      this.view.setCharge(0);
      v.drive = 1;
      v.update(this.input, dt, ctx.terrain);
      return;
    }

    // Waiting in an alley: sit still, engine running, until the moment is right.
    if (this.ambushAt) {
      this.ambushWait += dt;
      // The player has gone by and the shot never came: stand down rather than pull out
      // behind them and give chase.
      if (this.isAmbusher) {
        const mouth = this.ambushAt;
        // Course progress, not the player's heading frame: on a switchback the mouth
        // reads as "behind" the player's nose while still genuinely up the road.
        const past =
          ctx.terrain.progressAt(ctx.player.x, ctx.player.z) -
          ctx.terrain.progressAt(mouth.x, mouth.z);
        if (past > CONFIG.police.escalation.openRoad.ambush.giveUpPast) {
          this.ambushAt = null;
          this.spent = true;
          return;
        }
      }
      /*
       * One gate for everyone: the fleet's ETA spring. The player's own verdict,
       * session after session, is that the regular cops "sit in the back of the
       * alley and broadside me pretty good" - while every bespoke juggernaut
       * trigger ever built fired early or late. So the juggernaut uses the exact
       * timing that works, and its identity lives in what happens on contact.
       */
      const go = this.readyToSpring(ctx);
      if (go) {
        // Re-arm the wait clock: it now times the poised hold at the mouth, so a
        // player who never comes releases the budget instead of locking it forever.
        this.ambushWait = 0;
        this.springFrom = this.ambushAt;
        // The way out is through the mouth, not toward the target: the unit is still
        // deep in the alley, and any line it picks now must first pass this point.
        const ox = this.ambushAt.x - v.x;
        const oz = this.ambushAt.z - v.z;
        const ol = Math.hypot(ox, oz) || 1;
        this.springExit = { x: ox / ol, z: oz / ol };
        this.exitClock = 1.2;
        // The launch plan was solved for THIS player speed; the burn gears off
        // how far they deviate from it.
        this.springPSpd = Math.max(8, Math.hypot(ctx.player.vx, ctx.player.vz));
        if (this.isAmbusher) {
          if (this.ambushOut) {
            this.lastMouth = {
              x: this.ambushAt.x,
              z: this.ambushAt.z,
              ox: this.ambushOut.x,
              oz: this.ambushOut.z,
            };
          }
        }
        this.ambushAt = null;
      } else {
        /*
         * Pre-stage while armed: creep from the seat depth up to a hold point a car
         * length inside the mouth. A truck launching from deep in the alley needs
         * 1.4 seconds to reach the road, and no half-second-honest gate can predict
         * a player that far out - staged at the mouth its launch is ~0.5s, which is
         * inside the window the timing math genuinely controls.
         */
        // A re-armed truck that is out on the road backs up into its alley first;
        // a seated one waits motionless, exactly like the fleet.
        const out2 = this.ambushOut;
        if (this.isAmbusher && out2) {
          const hx2 = this.ambushAt.x - out2.x * 12;
          const hz2 = this.ambushAt.z - out2.z * 12;
          const toHold2 = dist(v.x, v.z, hx2, hz2);
          const outside =
            (v.x - this.ambushAt.x) * out2.x + (v.z - this.ambushAt.z) * out2.z > -2;
          /*
           * Never retreat THROUGH the player: a reversing truck crossing their path
           * registered hollow contacts with no pin machinery live - the exact
           * "feels like decoration" report. Hold still until they are clear.
           */
          if (outside && dist(v.x, v.z, ctx.player.x, ctx.player.z) < 16) {
            this.input.throttle = 0;
            this.input.brake = v.speed > 0.5 ? 1 : 0;
            this.input.steer = 0;
            this.input.boost = false;
            this.view.setCharge(0);
            v.drive = 1;
            v.update(this.input, dt, ctx.terrain);
            return;
          }
          if (outside && toHold2 > 3) {
            this.input.throttle = 0;
            this.input.brake = 1; // reverse toward the alley
            this.input.steer = clamp(
              -wrapAngle(headingOf(hx2 - v.x, hz2 - v.z) - v.heading - Math.PI) /
                CONFIG.police.shared.steerFullLockAngle,
              -1,
              1,
            );
            this.input.boost = false;
            this.view.setCharge(0);
            v.drive = 1;
            v.update(this.input, dt, ctx.terrain);
            return;
          }
        }
        this.input.throttle = 0;
        this.input.brake = v.speed > 1 ? 1 : 0;
        this.input.steer = 0;
        this.input.boost = false;
        this.view.setCharge(0);
        v.update(this.input, dt, ctx.terrain);
        return;
      }
    }

    this.replanTimer -= dt;
    this.repostTimer -= dt;
    this.updateCharge(dt, ctx);
    this.updateCatchUp(ctx);

    let goal: Goal;
    /** Pace to hold while boxing; Infinity when not on a station. */
    let boxSpeedLimit = Infinity;

    /*
     * Still coming out of the alley: steer the strike rather than committing to the guess.
     *
     * A timed launch is a prediction, and a prediction is usually a near miss — it arrives
     * behind the player, or ahead of them, and either way they drive past. Homing for the
     * first stretch converts the guess into contact, and because it aims at where the
     * player *will* be rather than where they are, that contact lands on the flank at
     * whatever speed they happen to be doing. It is also what lets the ambush work on
     * someone who boosts after it has already committed.
     */
    /*
     * Holding a pin: the strike connected, and the unit's job is now to keep its nose
     * buried in the player and press them into whatever the slam put behind them. No
     * pursuit afterwards - the hold runs its clock, feeds the box-in meter, and ends.
     */
    if (this.pinTimer > 0) {
      const cfg = this.ambushTuning;
      const pd = dist(v.x, v.z, ctx.player.x, ctx.player.z);
      this.pinTimer -= dt;
      /*
       * THE JAM. Once the pin has its prey near and a wall within the blade's reach,
       * the truck stops being a vehicle: velocity zeroed, position latched, infinite
       * effective mass, no restitution. The claw is bolted to the wall and the player
       * is held between them - machinery, exactly as designed. Physics resumes when
       * the pin clock runs out.
       */
      if (pd < 9) {
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        // Wing reach, not nose reach: the claw tips are real and stop at the wall.
        const wallAhead = ctx.world.raycastDistance(v.x, v.z, fx, fz, 7.2);
        if (wallAhead < 7.2) {
          v.jam = true;
          v.plow = true;
          v.contactBoost = 1;
          v.vx = 0;
          v.vz = 0;
          /*
           * THE PIN IS DELIVERED - so the weld dies HERE, by design. The magnet
           * and glue exist to carry the player to the wall; once the blade anchors,
           * it becomes an honest physical box: the truck is an immovable barrier
           * (jam mass, zero bounce) but the player is free to fight - and BOOST is
           * the guaranteed key: boosting against the box pops the anchor within a
           * third of a second. Escape is a decision with a cost, not a grind.
           */
          this.glueLocal = null;
          if (ctx.player.boosting) {
            this.pinTimer = Math.min(this.pinTimer, 0.3);
          }
          /*
           * The claw's grip. A flat collider lets the prey slide along the blade and
           * off the end - so while the jam holds, anything inside the trap zone
           * (between the blade face and the wall, within the wings) is damped hard.
           * Not an impulse, not a bounce: machinery closing. Release comes only when
           * the pin clock runs out.
           */
          this.input.throttle = 0.35;
          this.input.brake = 0;
          this.input.steer = 0;
          this.input.boost = false;
          this.view.setCharge(1);
          return;
        }
      }
      /*
       * The first 1.3 seconds of a pin cannot be broken by range: a graze at fifty
       * units a second is a touch that slides off before the grip forms, and the
       * player reads it as a miss. Locking the early pin lets the magnet and the
       * 1.75x drive reel them back in, so every touch becomes a felt grind.
       */
      /*
       * THE WELD. On first contact the player's position in the truck frame is
       * latched, and from then on they are POSITION-JOINED: dragged toward that
       * exact offset every frame with their velocity set to the truck's. Not a
       * force to fight - a fork stuck in the car. Bouncing is geometrically
       * impossible; release comes only when the pin clock does.
       */
      if (pd < 10) {
        v.jam = true;
        const fx2 = Math.sin(v.heading);
        const fz2 = Math.cos(v.heading);
        const rx2 = Math.cos(v.heading);
        const rz2 = -Math.sin(v.heading);
        if (!this.glueLocal) {
          const relX = ctx.player.x - v.x;
          const relZ = ctx.player.z - v.z;
          const relAlong = relX * fx2 + relZ * fz2;
          const relLat = relX * rx2 + relZ * rz2;
          /*
           * The weld only exists IN THE MOUTH - contact with the body or the back
           * of the truck is ordinary physics, because being magnetised to the
           * outside of a plow is nonsense and the player said so. A mouth catch
           * latches with a BITE: the player is drawn a little INTO the blade
           * pocket, the exaggerated real-life crush where the metal digs in and
           * holds, rather than kissing the surface.
           */
          const frontBite = relAlong > 0 && Math.abs(relLat) < 6.0;
          const sideBite =
            relAlong > -v.params.halfLength && Math.abs(relLat) < 4.6 && pd < 6.0;
          if (frontBite || sideBite) {
            this.glueLocal = {
              along: v.params.halfLength + 1.1,
              lateral: Math.max(-3.0, Math.min(3.0, relLat)),
            };
          }
        }
        if (!this.glueLocal) {
          /* Body contact: no weld; the pin ends unless the mouth finds them. */
        }
        // Latched: the joint itself is applied in applyGlue AFTER v.update - a
        // joint applied before the truck moves lags one frame of drive behind
        // it, and at pin speed that lag was ~3 units of visible interpenetration.
      } else if (this.glueLocal && pd > 13) {
        this.glueLocal = null;
      }
      const gripForming = cfg.pinTime - this.pinTimer < 1.3;
      if (this.pinTimer <= 0 || (!gripForming && pd > cfg.pinLostRange)) {
        this.pinTimer = 0;
        this.springFrom = null;
        this.springExit = null;
        this.spent = true;
        return;
      }
      const pinErr = wrapAngle(
        headingOf(ctx.player.x - v.x, ctx.player.z - v.z) - v.heading,
      );
      // Nose on a wall mid-pin loses the race no matter the speed edge: back off and
      // swing, same as the strike run does.
      if (v.speed < 5 && Math.abs(pinErr) > 0.7) {
        this.input.throttle = 0;
        this.input.brake = 1;
        this.input.steer = pinErr > 0 ? -1 : 1;
        this.input.boost = false;
        v.drive = 1;
        v.update(this.input, dt, ctx.terrain);
        this.applyGlue(v, ctx, dt);
        return;
      }
      this.input.throttle = 1;
      this.input.brake = 0;
      this.input.steer = clamp(pinErr / CONFIG.police.shared.steerFullLockAngle, -1, 1);
      this.input.boost = false;
      // The pin must be able to CATCH as well as hold - 1.15 lost any player who
      // simply kept their foot down.
      v.drive = 1.75;
      v.contactBoost = 7;
      v.plow = true;
      v.applySpin(
        clamp(
          wrapAngle(headingOf(ctx.player.x - v.x, ctx.player.z - v.z) - v.heading),
          -0.8,
          0.8,
        ) * cfg.turnAssist * dt,
      );
      v.update(this.input, dt, ctx.terrain);
      this.applyGlue(v, ctx, dt);
      return;
    }

    /*
     * The ambusher's strike is the fleet's strike - the steered, homing spring the
     * player praises every session - carried out with the blade, the plow and the
     * glue pin. It exits the alley on rails and then the shared homing below owns
     * the run; nothing here predicts, everything adjusts.
     */
    if (
      this.isAmbusher &&
      v.params.halfWidth > CONFIG.police.juggernaut.vehicle.halfWidth + 0.01
    ) {
      // Blade deployed: wings are solid against walls too. If the nose ray finds a
      // wall inside the claw's reach, the truck is held back at the surface.
      const fxW = Math.sin(v.heading);
      const fzW = Math.cos(v.heading);
      const reach = v.params.halfLength + 1.2;
      const wallD = ctx.world.raycastDistance(v.x, v.z, fxW, fzW, reach);
      if (wallD < reach) {
        const push = reach - wallD;
        v.x -= fxW * push;
        v.z -= fzW * push;
        const vn = v.vx * fxW + v.vz * fzW;
        if (vn > 0) {
          v.vx -= fxW * vn;
          v.vz -= fzW * vn;
        }
      }
    }

    if (this.isAmbusher && this.springFrom) {
      const cfg = this.ambushTuning;
      if (this.springExit) {
        const exit = this.springExit;
        /*
         * The exit phase ENDS, whatever the geometry says. A spur whose record makes
         * the "cleared the mouth" dot product unsatisfiable trapped the strike in
         * exit-mode forever: it hit the player with no homing, no pin, no weld ever
         * running - the recurring hollow contact. Deadline, or player-close, or
         * cleared: any of the three hands over to the homing.
         */
        this.exitClock -= dt;
        const cleared =
          (v.x - this.springFrom.x) * exit.x + (v.z - this.springFrom.z) * exit.z > 1.5 ||
          this.exitClock <= 0;
        if (cleared) {
          this.springExit = null;
          /*
           * The claw unfolds HERE, clear of the alley - deploying at fire wrapped a
           * 6.8-wide collider in a 7-wide corridor, and the blade scraping both
           * walls was the mystery brake that bled every launch to a crawl.
           */
          if (cfg.bladeHalfWidth > 0) {
            v.params = { ...v.params, halfWidth: cfg.bladeHalfWidth };
          }
        } else {
          /*
           * Contact DURING the exit still counts: alleys whose geometry never
           * satisfies the cleared test (seat 88's species) meet the player while
           * technically "exiting", and without this latch that contact had no pin,
           * no weld, nothing - the recurring hollow touch. Latch here; the pin
           * branch preempts from the next frame.
           */
          const pdE = dist(v.x, v.z, ctx.player.x, ctx.player.z);
          if (pdE < 7.2 && !this.glueLocal) {
            const fxE = Math.sin(v.heading);
            const fzE = Math.cos(v.heading);
            const rxE = Math.cos(v.heading);
            const rzE = -Math.sin(v.heading);
            const relXE = ctx.player.x - v.x;
            const relZE = ctx.player.z - v.z;
            const relAlongE = relXE * fxE + relZE * fzE;
            const relLatE = relXE * rxE + relZE * rzE;
            const frontBiteE = relAlongE > 0 && Math.abs(relLatE) < 6.0;
            // Side bite: crushing metal keeps whatever it touches - a player who
            // clips our flank grinds along the blade into the pocket.
            const sideBiteE =
              relAlongE > -v.params.halfLength && Math.abs(relLatE) < 4.6 && pdE < 6.0;
            if (frontBiteE || sideBiteE) {
              this.glueLocal = {
                along: v.params.halfLength + 1.1,
                lateral: Math.max(-3.0, Math.min(3.0, relLatE)),
              };
              this.pinTimer = cfg.pinTime;
              if (cfg.bladeHalfWidth > 0) {
                v.params = { ...v.params, halfWidth: cfg.bladeHalfWidth };
              }
            }
          }
          /*
           * The exit phase OWNS the terminal encounter - the gate fires when the
           * player is ~0.85s out and the exit takes ~1.3s, so contact lands here,
           * not in the homing branch. An open-loop exit made the whole strike only
           * as good as the launch calibration: a player who braked to a stop met a
           * truck barrelling across their empty lane, one who boosted crossed
           * behind a truck still nosing out. Same two clocks as the strike:
           * stalled player -> hold HIDDEN mid-alley with the clock pinned (the
           * strike resumes when they do; a receding player reads late, which
           * drives the exit to complete and the homing give-up to run - no
           * statues); running late -> afterburner straight down the alley axis,
           * the one direction that cannot scrape a wall.
           */
          let exThrottle = 1;
          let exBrake = 0;
          const pSpdE = Math.hypot(ctx.player.vx, ctx.player.vz);
          const dxTE = v.x - ctx.player.x;
          const dzTE = v.z - ctx.player.z;
          let schedE = 2;
          let lateE = 0;
          let approachingE = false;
          let lineDistE = 999;
          if (pSpdE > 2) {
            const alongPE = (dxTE * ctx.player.vx + dzTE * ctx.player.vz) / pSpdE;
            const latDE = Math.abs(dxTE * ctx.player.vz - dzTE * ctx.player.vx) / pSpdE;
            const tLevelE = alongPE > 0.5 ? alongPE / pSpdE : 0;
            approachingE = alongPE > 0.5;
            // Accel-honest time to their line - a flat speed guess told a truck
            // holding at rest it could cross instantly, so it released its hold
            // too late and spooled up car-lengths short.
            const aRunE = Math.max(20, v.params.accel * (1 + cfg.launchSpeedBonus) * 0.8);
            // Our real path runs along the alley axis - for an oblique spur the
            // crossing point is farther than the perpendicular distance by
            // 1/sin(angle), and using the short number made every oblique seat
            // read "early" and mistime under dynamics.
            lineDistE = latDE;
            const pdxE = ctx.player.vx / pSpdE;
            const pdzE = ctx.player.vz / pSpdE;
            const denE = exit.x * pdzE - exit.z * pdxE;
            if (Math.abs(denE) > 0.25) {
              const sE = (-dxTE * pdzE + dzTE * pdxE) / denE;
              if (sE > 0) lineDistE = Math.min(sE, latDE * 3);
            }
            const dLatE = Math.max(0, lineDistE - 3.5);
            const tMineE = (Math.sqrt(v.speed * v.speed + 2 * aRunE * dLatE) - v.speed) / aRunE;
            schedE = tLevelE - tMineE;
            lateE = schedE;
          }
          if (schedE > 0.9 && pdE > 14) {
            // Hold at the LIP: a piston poised 10 from the crossing line lunges
            // in ~0.6s; one parked 20 back needs 1.4s of spool and scatters.
            this.exitClock = Math.max(this.exitClock, 0.35);
            if (lineDistE > 12 && v.speed < 16) {
              exThrottle = 0.6;
            } else {
              exThrottle = 0;
              exBrake = 1;
            }
          } else if (schedE > 0.35 && pdE > 12) {
            // The middle band: a knock that slows the player reads moderately
            // early - without this taper the truck crosses car-lengths ahead.
            exThrottle = Math.max(0.3, 1 - (schedE - 0.35) * 1.4);
            this.exitClock = Math.max(this.exitClock, 0.2);
          } else if (lateE < -0.04 && v.speed < 46 && (approachingE || pdE < 25)) {
            // Honest lateness picks WHEN to burn; how hard gears off how much the
            // player has outrun the speed the launch was solved for. A punctual
            // pass burns mildly, a boosting one gets the full afterburner.
            const ratioE = Math.min(2.6, Math.max(1, (pSpdE / this.springPSpd) ** 2));
            const lateF = Math.min(1.6, Math.min(1, (-lateE - 0.04) * 8) * ratioE);
            v.applyImpulse(exit.x * 340 * lateF * dt, exit.z * 340 * lateF * dt);
          }
          const aimX = this.springFrom.x + exit.x * 6;
          const aimZ = this.springFrom.z + exit.z * 6;
          this.input.throttle = exThrottle;
          this.input.brake = exBrake;
          this.input.steer = clamp(
            wrapAngle(headingOf(aimX - v.x, aimZ - v.z) - v.heading) /
              CONFIG.police.shared.steerFullLockAngle,
            -1,
            1,
          );
          this.input.boost = false;
          v.drive = 1 + cfg.launchSpeedBonus;
          v.update(this.input, dt, ctx.terrain);
          return;
        }
      }
    }

    if (this.springFrom) {
      const cfg = this.ambushTuning;
      if (this.isAmbusher) {
        // The blade is live: contact converts to the glue pin, colleagues scatter.
        const pd0 = dist(v.x, v.z, ctx.player.x, ctx.player.z);
        if (pd0 < cfg.pinRange) this.pinTimer = cfg.pinTime;
        /*
         * Latch the weld HERE, at the frame of arrival - waiting for the pin branch
         * gave the collision separation a frame to shove the player past the latch
         * window, and the joint never formed on half of dead-centre hits.
         */
        if (pd0 < 7.2 && !this.glueLocal) {
          const fxL = Math.sin(v.heading);
          const fzL = Math.cos(v.heading);
          const rxL = Math.cos(v.heading);
          const rzL = -Math.sin(v.heading);
          const relXL = ctx.player.x - v.x;
          const relZL = ctx.player.z - v.z;
          const relAlongL = relXL * fxL + relZL * fzL;
          const relLatL = relXL * rxL + relZL * rzL;
          if (relAlongL > v.params.halfLength - 1.6 && Math.abs(relLatL) < 3.6) {
            this.glueLocal = {
              along: v.params.halfLength + 1.1,
              lateral: Math.max(-3.0, Math.min(3.0, relLatL)),
            };
            this.pinTimer = cfg.pinTime;
          }
        }
        v.plow = true;
        v.contactBoost = 7;
      }
      /*
       * The shot exists only while the unit is still across or ahead of the player.
       *
       * `homeDistance` alone kept the strike alive for its full length even when the
       * launch had already missed - and a missed juggernaut homing on an intercept
       * point from behind is indistinguishable from a chaser, which players duly
       * reported. Behind the player by more than a car length, the T-bone is gone,
       * so the run is over: it rolls out, hits whatever its momentum takes it into,
       * and is done. A miss that crosses in *front* keeps its momentum into the far
       * wall, which is the block the near-miss is supposed to read as.
       */
      /*
       * Course progress, not the player's heading frame. The heading-frame test
       * declared a freshly sprung truck "behind" whenever the course bent - it went
       * sprung to spent in one frame without ever moving, which was most of the
       * class's field record. A truck is only truly beaten when it is down-course
       * of the player, and that is a progress question.
       */
      const along =
        ctx.terrain.progressAt(v.x, v.z) -
        ctx.terrain.progressAt(ctx.player.x, ctx.player.z);
      // Fallen behind or crossed twenty ahead: the run is over - but the machine
      // gets ONE backed-up second attempt if its alley still lies ahead of the prey.
      const missed = this.isAmbusher && (along < -14 || along > 20);
      if (missed && this.retries < 3 && this.lastMouth) {
        const mouthLead =
          ctx.terrain.progressAt(this.lastMouth.x, this.lastMouth.z) -
          ctx.terrain.progressAt(ctx.player.x, ctx.player.z);
        if (mouthLead > -6) {
          this.retries++;
          this.springFrom = null;
          this.springExit = null;
          this.pinTimer = 0;
          this.glueLocal = null;
          this.ambushAt = { x: this.lastMouth.x, z: this.lastMouth.z };
          this.ambushOut = { x: this.lastMouth.ox, z: this.lastMouth.oz };
          this.ambushWait = 0;
          return;
        }
      }
      if (missed || dist(v.x, v.z, this.springFrom.x, this.springFrom.z) > cfg.homeDistance) {
        this.springFrom = null;
        this.springExit = null;
        // One alley, one strike. Whatever happened, this unit is finished.
        if (this.isAmbusher) {
          this.spent = true;
          return;
        }
      } else {
        /*
         * Phase one of the launch: get OUT of the alley.
         *
         * Steering straight for the intercept from the waiting spot aimed the run into
         * the alley's mouth corner whenever the target sat at an angle - and this branch
         * bypasses the obstacle feelers, so the unit ground the wall at full launch
         * power and never arrived at all. Until it has crossed the mouth plane it aims
         * a car length past the mouth along the spur's own axis; only then does the
         * intercept homing below take over. The spur is straight, so phase one cannot
         * miss, and the homing has the entire road width to swing the run square.
         */
        if (this.springExit) {
          const exit = this.springExit;
          const cleared =
            (v.x - this.springFrom.x) * exit.x + (v.z - this.springFrom.z) * exit.z > 1.5;
          // Course lead, not straight-line range: a player 50 units away across a
          // switchback wall is NOT in the window, and launching at them is how the
          // truck ends up planted in the far wall as they round the corner.
          const goLead =
            ctx.terrain.progressAt(this.springFrom.x, this.springFrom.z) -
            ctx.terrain.progressAt(ctx.player.x, ctx.player.z);
          if (goLead <= cfg.strikeGo && goLead > -8) {
            if (cleared) this.springExit = null;
          } else {
            /*
             * Target not in the window yet: hold INSIDE the alley, a car length short
             * of the mouth. Poised at the mouth itself it was readable - the player
             * braked on sight and the whole ambush unravelled from sixty units back.
             * In cover it stays a surprise, and the extra length is launch runway.
             */
            this.ambushWait += dt;
            if (this.isAmbusher && this.ambushWait > cfg.maxWait) {
              this.springFrom = null;
              this.springExit = null;
              this.spent = true;
              return;
            }
            const hx = this.springFrom.x - exit.x * 5;
            const hz = this.springFrom.z - exit.z * 5;
            if (dist(v.x, v.z, hx, hz) < 4) {
              this.input.throttle = 0;
              this.input.brake = v.speed > 1 ? 1 : 0;
              this.input.steer = 0;
              this.input.boost = false;
              v.update(this.input, dt, ctx.terrain);
              return;
            }
            this.input.throttle = v.speed < 9 ? 0.5 : 0;
            this.input.brake = v.speed > 10 ? 0.6 : 0;
            this.input.steer = clamp(
              wrapAngle(headingOf(hx - v.x, hz - v.z) - v.heading) /
                CONFIG.police.shared.steerFullLockAngle,
              -1,
              1,
            );
            this.input.boost = false;
            v.drive = 1;
            v.update(this.input, dt, ctx.terrain);
            return;
          }
          if (this.springExit) {
            const aimX = this.springFrom.x + exit.x * 6;
            const aimZ = this.springFrom.z + exit.z * 6;
            this.input.throttle = 1;
            this.input.brake = 0;
            this.input.steer = clamp(
              wrapAngle(headingOf(aimX - v.x, aimZ - v.z) - v.heading) /
                CONFIG.police.shared.steerFullLockAngle,
              -1,
              1,
            );
            this.input.boost = false;
            v.drive = 1 + cfg.launchSpeedBonus;
            v.update(this.input, dt, ctx.terrain);
            return;
          }
        }
        /*
         * Re-attack. A strike that crossed the player's line ends nose-first against
         * the far wall - grinding there at full throttle while the player drives past
         * was every "missed me entirely" report. A missile does not sulk: back off,
         * swing the nose, and come again. The run is still bounded by homeDistance
         * and the behind-check, so this cannot decay into a chase.
         */
        {
          const aimErrNow = wrapAngle(
            headingOf(ctx.player.x - v.x, ctx.player.z - v.z) - v.heading,
          );
          if (v.speed < 5 && Math.abs(aimErrNow) > 0.7) {
            this.input.throttle = 0;
            this.input.brake = 1;
            this.input.steer = aimErrNow > 0 ? -1 : 1;
            this.input.boost = false;
            v.drive = 1;
            v.update(this.input, dt, ctx.terrain);
            return;
          }
        }
        /*
         * Aim *through* them, not at them.
         *
         * An intercept point sits where the player will be, and arriving exactly there
         * means arriving alongside — a scrape, and then you are past each other. Aiming a
         * few metres beyond turns the same approach into a T-bone that carries the player
         * sideways, which is the whole reason the spurs exist.
         */
        /*
         * The ambusher is a MISSILE with one target: it aims at the player's body,
         * re-aimed every frame - if they change direction, it changes direction.
         * (The fleet keeps its intercept forecast below; a forecast is exactly what
         * a swerving player breaks.) And from launch it runs machinery physics:
         * jam set, so contact pushes and digs instead of bouncing - the slam
         * impulse never gets the chance to throw the player clear before the weld.
         */
        /*
         * Schedule error, re-solved every frame: tLevel is when the player draws
         * level with us (their along-track gap over their actual speed), tMine our
         * pessimistic time to cross their line. Positive = we are early, negative =
         * late. Computed before the aim so a late run can also stretch its lead.
         */
        /*
         * Two clocks: the EASE side stays pessimistic about our speed (+14 credit)
         * so a punctual launch never reads early and gets throttled - but that same
         * credit hides real lateness, which is why every boost-away pass read as
         * "barely late" while missing astern by car-lengths. Late detection gets an
         * honest clock instead.
         */
        let strikeSched: number | null = null;
        let strikeLate: number | null = null;
        let strikeApproaching = false;
        let strikeLineDist = 999;
        if (this.isAmbusher) {
          const pSpdS = Math.hypot(ctx.player.vx, ctx.player.vz);
          const dxT = v.x - ctx.player.x;
          const dzT = v.z - ctx.player.z;
          if (pSpdS > 2) {
            const alongP = (dxT * ctx.player.vx + dzT * ctx.player.vz) / pSpdS;
            const latD = Math.abs(dxT * ctx.player.vz - dzT * ctx.player.vx) / pSpdS;
            const tLevel = alongP > 0.5 ? alongP / pSpdS : 0;
            strikeApproaching = alongP > 0.5;
            // Accel-honest time to their line, same kinematics as the launch gate.
            const aRunS = Math.max(20, v.params.accel * (1 + cfg.launchSpeedBonus) * 0.8);
            // Same oblique correction as the exit clock, along our actual velocity.
            let lineDistS = latD;
            if (v.speed > 8) {
              const pdxS = ctx.player.vx / pSpdS;
              const pdzS = ctx.player.vz / pSpdS;
              const vdxS = v.vx / v.speed;
              const vdzS = v.vz / v.speed;
              const denS = vdxS * pdzS - vdzS * pdxS;
              if (Math.abs(denS) > 0.25) {
                const sS = (-dxT * pdzS + dzT * pdxS) / denS;
                if (sS > 0) lineDistS = Math.max(latD, Math.min(sS, latD * 2.5));
              }
            }
            strikeLineDist = lineDistS;
            const dLatS = Math.max(0, lineDistS - 3.5);
            const tMineS = (Math.sqrt(v.speed * v.speed + 2 * aRunS * dLatS) - v.speed) / aRunS;
            strikeSched = tLevel - tMineS;
            strikeLate = strikeSched;
          } else {
            strikeSched = 2; // player stalled: hold, do not overshoot their line
          }
        }
        // Late runs aim further ahead of the player - a stern chase becomes a cut-off.
        const leadT =
          strikeLate !== null && strikeLate < -0.04
            ? 0.08 + Math.min(0.5, (-strikeLate - 0.04) * 1.6)
            : 0.08;
        const lead = this.isAmbusher
          ? { x: ctx.player.x + ctx.player.vx * leadT, z: ctx.player.z + ctx.player.vz * leadT }
          : interceptPoint(v, ctx.player, 1.4);
        const tx = lead.x - v.x;
        const tz = lead.z - v.z;
        const tl = Math.hypot(tx, tz) || 1;
        if (this.isAmbusher) {
          v.jam = true;
          if (tl < 22) v.applyImpulse((tx / tl) * 140 * dt, (tz / tl) * 140 * dt);
        }
        /*
         * Terminal guidance: the through-point shrinks as the range closes. At full
         * depth a player who brakes or swerves late walks the aim point off their far
         * side and the run crosses ahead of them; scaling the depth down with distance
         * converges the aim onto the player themselves, so speeding up, slowing down
         * and turning all lead to the same place - contact.
         */
        const depth = this.isAmbusher ? 1.5 : cfg.strikeDepth * clamp(tl / 45, 0.35, 1);
        const aim = {
          x: lead.x + (tx / tl) * depth,
          z: lead.z + (tz / tl) * depth,
        };
        /*
         * CLOSED-LOOP INTERCEPT: the launch gate solved the rendezvous once, from the
         * seat; nothing after launch re-checked it, so a player who braked, boosted or
         * got knocked mid-approach met a truck still flying the stale solution. The
         * regulator has symmetric authority over the schedule error:
         *   very early -> hard brake (a 0.35-throttle floor cannot stop 35 speed;
         *                 the stop-and-go overshoots proved it),
         *   early      -> ease off and let them arrive,
         *   on time    -> inert, full launch drive,
         *   late       -> afterburner thrust toward the (already stretched) aim -
         *                 every boost-away miss was a stern pass of 4-9 units.
         */
        let strikeThrottle = 1;
        let strikeBrake = 0;
        let strikeDrive = 1 + cfg.launchSpeedBonus;
        if (this.isAmbusher && strikeSched !== null && tl > 12) {
          if (strikeSched > 0.9) {
            strikeDrive = 1;
            if (strikeLineDist > 12 && v.speed < 16) {
              strikeThrottle = 0.6;
            } else {
              strikeThrottle = 0;
              strikeBrake = 1;
            }
          } else if (strikeSched > 0.35) {
            strikeThrottle = Math.max(0.35, 1 - (strikeSched - 0.35) * 1.4);
            strikeDrive = 1 + cfg.chaseSpeed * 0.4;
          }
        }
        // Afterburner: runs on the honest clock and all the way into terminal range -
        // the boost-away misses happened at 7-12 units out, inside the old tl guard.
        if (
          this.isAmbusher &&
          strikeLate !== null &&
          strikeLate < -0.04 &&
          tl > 6 &&
          v.speed < 46 &&
          (strikeApproaching || tl < 25)
        ) {
          const pSpdB = Math.hypot(ctx.player.vx, ctx.player.vz);
          const ratioB = Math.min(2.6, Math.max(1, (pSpdB / Math.max(8, this.springPSpd)) ** 2));
          const late = Math.min(1.6, Math.min(1, (-strikeLate - 0.04) * 8) * ratioB);
          v.applyImpulse((tx / tl) * 340 * late * dt, (tz / tl) * 340 * late * dt);
        }
        this.input.throttle = strikeThrottle;
        this.input.brake = strikeBrake;
        this.input.steer = clamp(
          wrapAngle(headingOf(aim.x - v.x, aim.z - v.z) - v.heading) /
            CONFIG.police.shared.steerFullLockAngle,
          -1,
          1,
        );
        this.input.boost = false;
        v.drive = strikeDrive;
        // The strike gets rails: direct yaw toward the aim, so late swerves are tracked.
        v.applySpin(
          clamp(wrapAngle(headingOf(aim.x - v.x, aim.z - v.z) - v.heading), -0.8, 0.8) *
            cfg.turnAssist *
            dt,
        );
        v.update(this.input, dt, ctx.terrain);
        return;
      }
    }

    if (this.charging) {
      // A committed charge overrides everything: it is already pointed at the player and
      // it is not going to reconsider halfway through.
      goal = { kind: "direct", x: ctx.player.x + ctx.player.vx * 0.3, z: ctx.player.z + ctx.player.vz * 0.3 };
    } else if (this.role === "rig") {
      this.updateRigPost(dt, ctx);
      goal = rigGoal(ctx, this.rigPost);
    } else if (this.boxSlot) {
      // On a station: hold it, then close it.
      const box = CONFIG.police.shared.box;
      const target = boxGoal(ctx, this.boxSlot, this.boxPress);
      const atStation = dist(v.x, v.z, target.x, target.z) < box.pressRange;
      // A slow player gets squeezed harder and further: the box shutting is the cost of
      // having lost your speed, not a separate thing that happens to you.
      const slow = clamp(1 - ctx.player.speed / box.slowPlayerSpeed, 0, 1);
      const rate = box.pressRate * (1 + slow * 1.5);
      const ceiling = box.pressMax + slow * box.slowPressBonus;
      this.boxPress = clamp(this.boxPress + (atStation ? rate : -rate) * dt, 0, Math.min(0.92, ceiling));
      goal = boxGoal(ctx, this.boxSlot, this.boxPress);

      /*
       * Match the player's pace rather than charging the station.
       *
       * This is what makes the front of the box a brake-check instead of a car that
       * overshoots and has to come back. A unit ahead of you deliberately runs a little
       * *slower* than you and lets you close on it; one behind runs a little faster and
       * pushes. Without it the whole box read as ordinary traffic, because everybody
       * arrived at their spot flat out and immediately left it again.
       */
      /*
       * Pace matching only applies once you have *reached* your station.
       *
       * This was a real bug and the reason "they just push me from behind": a unit given a
       * front station while still behind the player had its speed capped at 0.9x the
       * player's, so it could never overtake, and spent the whole encounter shoving them
       * along from the rear. Until it is in position it runs free — overtaking is the job.
       */
      const f = forwardOf(ctx.player.heading);
      const lead = (v.x - ctx.player.x) * f.x + (v.z - ctx.player.z) * f.z;
      const wantsFront = this.boxSlot.z > 0;
      const inPosition = wantsFront ? lead > this.boxSlot.z * 0.6 : lead < this.boxSlot.z * 0.6 + 2;
      // The floor never exceeds the player's own pace by more than a little, so against
      // a stopped player the box comes to rest around them instead of milling through.
      const floor = Math.min(box.minPace, ctx.player.speed + box.paceOverrun);
      boxSpeedLimit = inPosition
        ? Math.max(floor, ctx.player.speed * (wantsFront ? box.leadPace : box.chasePace))
        : Infinity;
    } else {
      this.boxPress = 0;
      goal = goalFor(this.role, v, ctx, this.tuning);
    }

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
        /*
         * The goal's own point, not the node it is anchored to. A rig holding a block
         * tracks across the road to cover the line the player is taking, so its post is a
         * offset from the junction rather than the junction itself; measuring to the node
         * would have it think it had arrived while still a lane away from where it meant
         * to be. Blockers pass the node position through unchanged, so nothing moves for
         * them.
         */
        const post = this.role === "rig" ? goal : ctx.nav.nodes[targetNodeId];
        parkDistance = dist(v.x, v.z, post.x, post.z);
        // Slow down on the approach. Arriving at 40+ meant sailing straight past the
        // post and then having to turn around, which repeatedly wedged units against
        // walls and took them out of the run entirely.
        const cfg = this.role === "rig" ? CONFIG.police.rig : CONFIG.police.blocker;
        if (parkDistance < cfg.approachDistance) {
          cornerLimit = Math.min(cornerLimit, cfg.approachSpeed);
        }
      }
    }

    /*
     * Closing for a hit: match pace and turn in, rather than driving through at full tilt.
     */
    let strikeLimit = Infinity;
    if (goal.kind === "direct" && this.role !== "rig") {
      const st = CONFIG.police.shared.strike;
      const d = this.distanceToPlayer(ctx.player);
      if (d < st.range) {
        const f = forwardOf(ctx.player.heading);
        const playerAlong = ctx.player.vx * f.x + ctx.player.vz * f.z;
        // Only a unit that has genuinely got past and is pulling away is held back.
        // Capping anyone in range instead cost a third of all contact: reined in, they
        // stopped arriving at all.
        const lead = (v.x - ctx.player.x) * f.x + (v.z - ctx.player.z) * f.z;
        if (lead > -st.chaseGrace) {
          strikeLimit = Math.max(st.minPace, playerAlong + st.maxOvertake);
        }

        // The last car length is a turn into them, not a pass beside them: aim at a point
        // beyond the player, on the far side from us.
        if (d < st.turnInRange) {
          const nx = (ctx.player.x - v.x) / Math.max(1, d);
          const nz = (ctx.player.z - v.z) / Math.max(1, d);
          steerTargetX = ctx.player.x + nx * st.turnInDepth;
          steerTargetZ = ctx.player.z + nz * st.turnInDepth;
        }
      }
    }

    this.driveToward(
      steerTargetX,
      steerTargetZ,
      Math.min(cornerLimit, boxSpeedLimit, strikeLimit),
      parkDistance,
      dt,
      ctx,
    );
    v.update(this.input, dt, ctx.terrain);
    // Swing across as soon as it has effectively arrived, rather than only inside the
    // park radius: a rig that coasts to a stop a metre short is still a roadblock, and it
    // should look like one.
    if (this.role === "rig" && v.speed < 4 && parkDistance < this.parkRadius * 1.8) {
      this.parkBroadside(dt, ctx);
    }
  }

  /**
   * Is the player close enough that pulling out now puts us across their nose?
   *
   * Both sides of the comparison are estimates of time-to-the-mouth: theirs from their
   * current speed, ours from a standing start. Matching the two is what turns a car
   * leaving a side road into an interception rather than an obstacle already spent.
   */
  /**
   * The burst trigger. One shot, solved at point-blank range: compute how long this
   * truck's nose needs to reach the road from where it actually sits, predict where
   * the player will be at that exact moment, and fire only when that predicted point
   * is on the mouth. The horizon is well under a second - nothing the player does
   * with brakes or boost moves them far off a half-second prediction - and line of
   * sight gates the whole thing so no switchback can fake it.
   */

  /*
   * The weld joint, applied AFTER the truck's own update so the player sits on
   * the truck's FINAL position each frame. The seat depth is their box projected
   * onto our forward axis - correct at any relative angle, live even if they
   * rotate while pinned - minus a 0.35 crush bite. Fixed offsets and pre-update
   * application both read as the cars clipping through each other.
   */
  private applyGlue(_v: Vehicle, ctx: PursuitContext, dt: number): void {
    this.reseatWeld(ctx.player, dt);
  }

  /*
   * Public because the game loop calls it at the COLLISION phase, after the
   * player's own update has run - the player's drive walks them off the seat
   * every frame (the escape inputs literally steer into the blade), and with
   * the pair's separation solver muted only a re-seat at end of frame keeps
   * the boxes from visibly interpenetrating.
   */
  reseatWeld(
    player: Vehicle,
    dt: number,
    walls?: { raycastDistance(x: number, z: number, dx: number, dz: number, maxDist: number): number },
  ): void {
    const v = this.vehicle;
    const gl = this.glueLocal;
    if (!gl || this.pinTimer <= 0) return;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const rx = Math.cos(v.heading);
    const rz = -Math.sin(v.heading);
    const pfx = Math.sin(player.heading);
    const pfz = Math.cos(player.heading);
    const prx = Math.cos(player.heading);
    const prz = -Math.sin(player.heading);
    const projE =
      player.params.halfLength * Math.abs(pfx * fx + pfz * fz) +
      player.params.halfWidth * Math.abs(prx * fx + prz * fz);
    let seatAlong = Math.max(gl.along, v.params.halfLength + projE - 0.35);
    if (walls) {
      // At the wall the seat must fit BETWEEN blade and wall - seating the
      // player inside the wall just gets them shoved back into the truck by
      // the static solver. If the pocket is tighter than the player, the
      // overshoot goes into the blade (bounded crush), never the wall.
      const probe = seatAlong + projE + 1;
      const gap = walls.raycastDistance(v.x, v.z, fx, fz, probe);
      if (gap < probe) {
        seatAlong = Math.max(v.params.halfLength - 1.2, Math.min(seatAlong, gap - projE - 0.05));
      }
    }
    const tx = v.x + fx * seatAlong + rx * gl.lateral;
    const tz = v.z + fz * seatAlong + rz * gl.lateral;
    /*
     * The along-axis seat is RIGID - a fork, not a spring. The truck advances
     * ~half a unit per frame during the carry, and any fractional pull lags
     * behind that forever (equilibrium ~advance/pull: the visible clipping).
     * Lateral stays smoothed so the latch reads as a grab, not a teleport.
     */
    const exG = tx - player.x;
    const ezG = tz - player.z;
    const eAlong = exG * fx + ezG * fz;
    const eLat = exG * rx + ezG * rz;
    const pullLat = (1 - Math.exp(-22 * dt)) * eLat;
    player.x += fx * eAlong + rx * pullLat;
    player.z += fz * eAlong + rz * pullLat;
    player.vx = v.vx;
    player.vz = v.vz;
  }

  private readyToSpring(ctx: PursuitContext): boolean {
    const cfg = this.ambushTuning;
    if (this.ambushWait > cfg.maxWait) return true;

    const mouth = this.ambushAt as { x: number; z: number };
    const v = this.vehicle;
    const player = ctx.player;

    /*
     * The ambusher gate is EUCLID + LINE OF SIGHT, nothing else. Progress space
     * lies exactly at the junction (the player's position snaps onto the spur's own
     * branch segment and the lead collapses), which silently blocked the gate in
     * its firing window; and the chord cannot lie at these ranges once the mouth
     * can SEE the player - no switchback fits inside sixty units with sight. The
     * fleet keeps the progress path below.
     */
    if (this.isAmbusher) {
      const dM = dist(player.x, player.z, mouth.x, mouth.z);
      if (dM > 110) return false;
      if (!ctx.world.lineOfSight(mouth.x, mouth.z, player.x, player.z)) return false;
      const effSpd = Math.max(8, Math.min(player.speed, player.params.maxSpeed));
      const theirEtaE = dM / effSpd;
      const aRun = Math.max(20, v.params.accel * (1 + cfg.launchSpeedBonus) * 0.8);
      const topRun = Math.max(10, v.params.maxSpeed * cfg.launchSpeedFactor);
      const tAcc = topRun / aRun;
      const dAcc = 0.5 * aRun * tAcc * tAcc;
      /*
       * Lane-aware: the crossing distance is to the PLAYER'S lane, not the road
       * centre. A near-lane player arrives at a shorter runway, a far-lane player
       * a longer one - timing to the centre was why only centre-line passes were
       * being caught.
       */
      const outX = this.ambushOut ? this.ambushOut.x : 0;
      const outZ = this.ambushOut ? this.ambushOut.z : 0;
      const laneDepth = Math.max(2, Math.min(14, (player.x - mouth.x) * outX + (player.z - mouth.z) * outZ));
      const rw = dist(v.x, v.z, mouth.x, mouth.z) + laneDepth;
      const ourEtaE =
        0.15 + (rw <= dAcc ? Math.sqrt((2 * rw) / aRun) : tAcc + (rw - dAcc) / topRun);
      // A shot that is already stale at first sight lands behind the player every
      // time - hold instead; a no-show is invisible, a tail-graze is a complaint.
      if (theirEtaE < ourEtaE + cfg.leadTime - 0.6) return false;
      return theirEtaE <= ourEtaE + cfg.leadTime;
    }
    const lead =
      ctx.terrain.progressAt(mouth.x, mouth.z) -
      ctx.terrain.progressAt(player.x, player.z);
    if (lead < -8) return false;
    if (lead < cfg.springRange) return true;

    /*
     * The ambusher launches from a DEEP seat at rest: its time to the road is
     * acceleration-dominated, and the cruise-speed estimate under-reads it by a
     * third of a second - which, against a straight, predictable player, was a
     * clean miss behind them every time. Physics, not cruise math.
     */
    let ourEta: number;
    const runway = dist(v.x, v.z, mouth.x, mouth.z) + 7;
    if (this.isAmbusher) {
      const a = Math.max(20, v.params.accel * (1 + cfg.launchSpeedBonus) * 0.8);
      const top = Math.max(10, v.params.maxSpeed * cfg.launchSpeedFactor);
      const tAccel = top / a;
      const dAccel = 0.5 * a * tAccel * tAccel;
      ourEta =
        0.15 + (runway <= dAccel ? Math.sqrt((2 * runway) / a) : tAccel + (runway - dAccel) / top);
    } else {
      ourEta = (runway - 7) / Math.max(6, v.params.maxSpeed * cfg.launchSpeedFactor);
    }
    const theirEta = lead / Math.max(8, player.speed);
    return theirEta <= ourEta + cfg.leadTime;
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
        this.chargeCooldown = cfg.cooldown * (1 - this.aggro);
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

    this.chargeTimer = cfg.telegraphTime * (1 - this.aggro * 0.5) + cfg.chargeTime;
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
   * Pick somewhere worth blocking: the narrowest point on the player's route inside the
   * scouting window.
   *
   * Width is the whole heuristic, and it is the difference between a roadblock and a
   * parked lorry. Nine metres across the middle of the wide off-road section leaves two
   * lanes either side and reads as scenery; the same nine metres across a downtown block
   * is most of the road.
   */
  private updateRigPost(dt: number, ctx: PursuitContext): void {
    const cfg = CONFIG.police.rig;
    this.rigTimer -= dt;
    const playerProgress = ctx.terrain.progressAt(ctx.player.x, ctx.player.z);
    /*
     * Once posted, it holds. Full stop.
     *
     * It used to re-scout the moment the player got past, on the reasoning that a block
     * behind you is not a block. True, but the cure was worse: the new spot is always
     * *ahead* of the player, so a passed rig would pull out and drive up the road past
     * them to reach it — a nine-metre transport overtaking you is not a roadblock, and it
     * was the single least readable thing in the squad. A rig that has been beaten has
     * been beaten; the director retires it once you are clear.
     */
    if (this.rigPost) return;
    this.rigTimer = cfg.repickInterval;
    let best: NavNode | null = null;
    let bestScore = Infinity;

    for (let d = cfg.scoutMin; d <= cfg.scoutMax; d += 14) {
      const node = ctx.nav.nodeAtProgress(playerProgress + d);
      const seg = ctx.terrain.sample(node.x, node.z).segment;
      // Real room to drive through, not the section's nominal width - the latter barely
      // varies inside a section, so scouting on it chose spots no better than at random.
      const width = ctx.world.freeWidth(node.x, node.z, seg.heading);
      // Somewhere it can block, not somewhere it can seal.
      if (width < cfg.minBlockWidth) continue;
      // Width dominates, heavily: the whole unit is the choice of where to stand, and a
      // rig across the wide off-road flats is scenery. Distance is only a tiebreak, but
      // it has to count for something, because a rig that never arrives has blocked
      // nothing either.
      const score = width * 2 + d * 0.04 + (width < cfg.preferredWidth ? -25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    // Do not abandon a good spot for a marginally better one once committed.
    if (best && (!this.rigPost || bestScore < this.rigScore - 6)) {
      this.rigPost = best;
      this.rigScore = bestScore;
    }
  }

  /**
   * Swing broadside once parked. A rig pointing down the road is a car in your lane; a
   * rig across it is a wall.
   */
  private parkBroadside(dt: number, ctx: PursuitContext): void {
    const v = this.vehicle;
    const seg = ctx.terrain.sample(v.x, v.z).segment;
    // Either perpendicular will do; take whichever is the shorter swing from here.
    const across = seg.heading + Math.PI / 2;
    const a = wrapAngle(across - v.heading);
    const b = wrapAngle(across + Math.PI - v.heading);
    const err = Math.abs(a) < Math.abs(b) ? a : b;
    const step = CONFIG.police.rig.turnRate * dt;
    v.heading += clamp(err, -step, step);
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
    // Holding station on top of the player is the job, not a fault. Without this the
    // stuck detector reversed the squad out of its own box and then teleported it away.
    const pinning = this.distanceToPlayer(ctx.player) < shared.pinningRange;
    if (speed < shared.stuckSpeed && !parked && !pinning) {
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
    if (!pinning && !ctx.player.offCourse && !ctx.terrain.sample(v.x, v.z).onCourse) {
      this.stuckTotal += dt * 2;
    }

    /*
     * Teleporting a wedged unit back into play is fine when nobody is looking and
     * indefensible when they are. In view, it keeps working the reverse-out instead — a
     * car struggling against a wall is at worst untidy, where the same car blinking out
     * of existence is plainly broken.
     */
    const watched =
      this.distanceToPlayer(ctx.player) < CONFIG.police.pacing.keepVisibleRange &&
      ctx.world.lineOfSight(ctx.player.x, ctx.player.z, v.x, v.z);
    if (this.stuckTotal > shared.respawnAfterStuck && !watched) {
      this.respawn(ctx);
      return;
    }

    if (this.reverseTimer <= 0 && this.stuckTimer > shared.stuckTime && !pinning) {
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

    /*
     * Arrived at a post: sit on it. Coasting down rather than holding the brake avoids
     * the vehicle model rolling into reverse once it has stopped.
     *
     * A rig settles into a much tighter radius than a blocker, because its post is not a
     * fixed point — it tracks across the road to cover your line. Parked broadside, the
     * only direction it can drive is along its own axis, which is across the carriageway,
     * so leaving it a little room to roll is exactly the shuffle that closes your gap.
     * Stopping at the full park radius froze it a lane away from where it meant to be.
     */
    const stopWithin =
      this.role === "rig" ? CONFIG.police.rig.holdStopWithin : this.parkRadius;
    if (parkDistance < stopWithin) {
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
    // The armoured pair boost *into* the broadside rather than to close distance — two
    // tonnes arriving fast is the whole point of the encounter.
    if (this.charging) return speed > 6;
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

    /*
     * A prop block dead ahead is narrower than the fan: the side rays pass either
     * side of it and report clear, the bias cancels to zero, and the unit drives
     * into the same block forever - reversing out and driving straight back in.
     * When the centre is blocked and the sides cannot break the tie, commit to a
     * side and hold the commitment until the nose is genuinely clear; flip-flopping
     * per frame is how the block wins.
     */
    let bias = (right - left) * cfg.avoidStrength;
    if (ahead < 0.55 && Math.abs(right - left) < 0.18) {
      if (this.dodgeSign === 0) this.dodgeSign = right >= left ? 1 : -1;
      bias += this.dodgeSign * cfg.avoidStrength;
    } else if (ahead > 0.9) {
      this.dodgeSign = 0;
    }

    return {
      steerBias: bias,
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
    this.dodgeSign = 0;
  }

  syncView(dt: number, elapsed: number, groundY = 0): void {
    this.view.sync(this.vehicle, dt, elapsed, this.input.brake > 0, this.disabled, groundY);
  }
}
