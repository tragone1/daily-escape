/**
 * Owns the pursuit squad and escalates it, section by section, forever.
 *
 * Every unit the run will ever need exists from the first frame, parked off-route and
 * dormant. The director decides how many are awake and which classes they are drawn from,
 * both as functions of the section you have reached: more cars, then meaner cars, then
 * faster cars. Nothing here has an end condition — it just keeps climbing until the
 * squad closes the run out.
 *
 * Two rules keep it honest:
 *  - a unit never appears inside the player's view, and never within `minSpawnDistance`
 *  - a unit that falls hopelessly behind is repositioned rather than left to trail
 *
 * Where a unit appears matters as much as when. A corridor can only ever deliver cars
 * from directly behind or directly in front, which turns the squad into a queue: outrun
 * the ones behind, then meet the ones ahead one at a time, head on, where they are easy
 * to read and easy to dodge. Most units are therefore placed either deep in a dead-end
 * spur off to the side, or out in the run-off — somewhere they arrive across you rather
 * than along you.
 */

import type { Renderer } from "../gfx/renderer";
import type { CollisionWorld } from "../physics/collisionWorld";
import { CONFIG, type PoliceRole } from "../config";
import { dist, forwardOf, headingOf, rightOf } from "../math";
import { POLICE_LOOKAHEAD, SECTION_THEMES, SPURS, sectionIndexAt, type SpurDef } from "../world/course";
import type { NavGraph, NavNode } from "../world/navGraph";
import type { Terrain } from "../world/terrain";
import type { PursuitContext } from "./behaviors";
import { PoliceCar } from "./policeCar";

type SpawnMode = "ambush" | "side" | "behind" | "ahead";

const SPAWN_MODES: SpawnMode[] = ["ambush", "side", "behind", "ahead"];

export class PoliceManager {
  readonly units: PoliceCar[] = [];
  private retimeTimer = 0;
  /** Distance along the spine the squad currently plans against. */
  private goalProgress = POLICE_LOOKAHEAD;
  private speedBonus = -1;
  private aggro = 0;
  private boxTimer = 0;
  /** Section the director last ran for; gates how hard placement tries. */
  private effortSection = 0;

  constructor(r: Renderer, nav: NavGraph, private terrain: Terrain) {
    // Build the whole pool up front so meshes exist before the first frame; the director
    // decides which of them are awake at any moment.
    for (const [role, count] of Object.entries(CONFIG.police.pool)) {
      for (let i = 0; i < count; i++) {
        const unit = new PoliceCar(r, role as PoliceRole, { x: 0, z: -600, heading: 0 }, {
          // Interceptors get staggered horizons so they do not all pick the same junction.
          predictionTime: role === "interceptor" ? 2.2 + (i % 3) * 0.9 : undefined,
          routeDepth: role === "blocker" ? 2 + (i % 3) * 2 : undefined,
        });
        unit.deactivate();
        this.units.push(unit);
      }
    }

    this.spawnOpeningWave(nav);
  }

  reset(nav: NavGraph): void {
    for (const u of this.units) {
      u.reset();
      u.deactivate();
    }
    this.spawnOpeningWave(nav);
    this.retimeTimer = 0;
  }

  /** Rigs currently holding a block. */
  private get activeRigs(): number {
    return this.units.filter((u) => u.role === "rig" && u.active && !u.destroyed).length;
  }

  /** Units that actually chase: the budget the difficulty curve is written against. */
  private get mainFleetCount(): number {
    const esc = CONFIG.police.escalation;
    return this.units.filter(
      (u) =>
        u.active &&
        !u.destroyed &&
        u.role !== "rig" &&
        !esc.openRoad.roles.includes(u.role),
    ).length;
  }

  /** Traps lying in wait, counted apart from the chase. */
  private get ambusherCount(): number {
    const esc = CONFIG.police.escalation;
    return this.units.filter(
      (u) => u.active && !u.destroyed && esc.openRoad.roles.includes(u.role),
    ).length;
  }

  get activeCount(): number {
    return this.units.filter((u) => u.active && !u.destroyed).length;
  }

  /**
   * Recompute the player's shortest route to the exit once per frame and share it with
   * every unit, so the squad plans against one consistent picture of the map.
   */
  buildContext(ctx: Omit<PursuitContext, "escapeRoute">): PursuitContext {
    const p = ctx.player;
    const speed = p.speed;
    let sx = p.x;
    let sz = p.z;
    if (speed > 4) {
      const lead = Math.min(speed * CONFIG.police.blocker.routePrediction, 70);
      sx += (p.vx / speed) * lead;
      sz += (p.vz / speed) * lead;
    }
    const start = ctx.nav.nearestNode(sx, sz);
    // Endless mode has no gate, so the squad plans against a rolling point up the road.
    // That keeps interceptors and blockers setting up in front of you exactly as they did
    // when there was a finish line to defend.
    const goal = ctx.nav.nodeAtProgress(this.goalProgress);
    const escapeRoute: NavNode[] = ctx.nav.findPath(start.id, goal.id);
    return { ...ctx, escapeRoute };
  }

  /** Wake, recycle and drive every unit. */
  update(dt: number, ctx: PursuitContext, playerProgress: number, section: number): void {
    const pacing = CONFIG.police.pacing;
    this.goalProgress = playerProgress + POLICE_LOOKAHEAD;
    this.retimeTimer -= dt;

    if (this.retimeTimer <= 0) {
      this.retimeTimer = pacing.directorInterval;
      this.director(ctx, playerProgress, section);
    }

    /*
     * Ration the slide-block: one assignment per cadence, cadence tightening
     * with aggro, coin flip per opportunity. "Some cars know the move."
     */
    this.slideTimer -= dt;
    const sb = CONFIG.police.shared.slideBlock;
    if (section >= sb.fromSection && this.slideTimer <= 0) {
      this.slideTimer = 0.5;
      const player = ctx.player;
      const fwd = forwardOf(player.heading);
      const right = rightOf(player.heading);
      const chance = Math.min(sb.chanceMax, sb.chanceBase + section * sb.chancePerSection);
      const lineup = Math.min(sb.lineupMax, sb.lineupBase + section * sb.lineupPerSection);
      const candidates: PoliceCar[] = [];
      for (const u of this.units) {
        if (!u.active || u.destroyed || u.disabled) continue;
        if (!(sb.roles as readonly string[]).includes(u.role)) continue;
        if (u.ambushAt) continue;
        const v2 = u.vehicle;
        if (v2.speed < sb.minSpeed) continue;
        const rx = v2.x - player.x;
        const rz = v2.z - player.z;
        const along = rx * fwd.x + rz * fwd.z;
        const lat = rx * right.x + rz * right.z;
        // The spotting window scales with closing speed: late-game closing
        // tops 120/s, and a fixed window meant assignment landed already
        // inside snap time - no staging, an instant mid-road snap, the whiff.
        const closing2 = Math.hypot(player.vx, player.vz) + v2.speed;
        const farNeed = Math.max(
          sb.window.far,
          closing2 * (sb.snapMeetTime + sb.commitLead + 0.6),
        );
        if (along < sb.window.near || along > farNeed) continue;
        if (Math.abs(lat) > sb.window.lat) continue;
        // Head-on: their travel opposes the player's heading.
        const spd = v2.speed || 1;
        if ((v2.vx * fwd.x + v2.vz * fwd.z) / spd > -0.45) continue;
        candidates.push(u);
        if (candidates.length >= 2) break;
      }
      /*
       * A strict window rarely holds two cars at the same instant, which is
       * why the coordinated wall almost never fired. The PARTNER search is
       * looser: same roles, roughly oncoming, in the long window - close
       * enough that the line-up phase makes up the rest.
       */
      if (candidates.length === 1 && section >= sb.doubleFromSection) {
        for (const u of this.units) {
          if (u === candidates[0] || !u.active || u.destroyed || u.disabled) continue;
          if (!(sb.roles as readonly string[]).includes(u.role)) continue;
          if (u.ambushAt) continue;
          const v2 = u.vehicle;
          if (v2.speed < 10) continue;
          const rx = v2.x - player.x;
          const rz = v2.z - player.z;
          const along = rx * fwd.x + rz * fwd.z;
          if (along < sb.window.near - 8 || along > 200) continue;
          if (Math.abs(rx * right.x + rz * right.z) > 18) continue;
          const spd = v2.speed || 1;
          if ((v2.vx * fwd.x + v2.vz * fwd.z) / spd > -0.2) continue;
          candidates.push(u);
          break;
        }
      }
      if (candidates.length > 0 && Math.random() < chance) {
        // Stage on the OPEN side of the road relative to the player, so the
        // carve crosses their line instead of running out of tarmac.
        const segP = ctx.terrain.sample(player.x, player.z).segment;
        const playerAcross =
          (player.x - segP.ax) * segP.dz - (player.z - segP.az) * segP.dx;
        const stageSign = playerAcross >= 0 ? -1 : 1;
        // A stage lane the road cannot hold is a cop grinding the wall: clamp
        // the offset to the tarmac actually available.
        const stage = stageSign * Math.min(sb.stageOffset, Math.max(2.2, segP.halfWidth - 2.6));
        const wantDouble =
          section >= sb.doubleFromSection &&
          candidates.length >= 2 &&
          Math.random() < sb.doubleChance;
        if (wantDouble) {
          // Mirrored stages, split kill lanes: a formed two-car wall.
          candidates[0].startSlideBlock(1, stage, lineup, -sb.doubleLaneOffset);
          candidates[1].startSlideBlock(-1, -stage, lineup, sb.doubleLaneOffset);
        } else {
          candidates[0].startSlideBlock(1, stage, lineup, 0);
        }
        this.slideTimer =
          Math.max(sb.intervalMin, sb.intervalBase - section * sb.intervalPerSection) *
          (1 - this.aggro * 0.5);
      }
    }

    this.boxTimer -= dt;
    if (this.boxTimer <= 0) {
      // Aggro reforms the box faster: the trap keeps up with a faster player.
      this.boxTimer = CONFIG.police.shared.box.interval * (1 - this.aggro * 0.6);
      this.assignBox(ctx);
    }

    for (const u of this.units) {
      if (u.active) u.update(dt, ctx);
    }
  }

  /**
   * Escalation.
   *
   * Target headcount grows with the section, and so does the class mix: a weighted pick
   * over whatever is unlocked, biased hard toward the heavier classes as the run goes on.
   * Units that fall hopelessly behind are recycled forward rather than left to trail.
   */
  private sectionNow = 0;
  private slideTimer = 0;

  private director(ctx: PursuitContext, playerProgress: number, section: number): void {
    this.sectionNow = section;
    const esc = CONFIG.police.escalation;
    const pacing = CONFIG.police.pacing;

    /*
     * Two budgets, not one.
     *
     * `target` is the main fleet: everything that actually chases you. The juggernaut is a
     * trap with their own small allowance, and the rig has always had its
     * own cap of one. Sharing a single number meant an ambusher parked in an alley - or a
     * spent one waiting to be stood down - was counted as part of the chase and cost the
     * road a car.
     */
    const target = Math.min(
      section >= 9 ? esc.lateMaxActive : esc.maxActive,
      section === 0 ? esc.openingActive : Math.round(esc.baseActive + section * esc.activePerSection),
    );
    const ambushTarget = Math.min(
      esc.openRoad.maxActive,
      1 + (section >= esc.openRoad.secondAt ? 1 : 0) + (section >= esc.openRoad.thirdAt ? 1 : 0),
    );

    // Recycle stragglers first; they may well cover the whole deficit on their own.
    for (const unit of this.units) {
      /*
       * Wrecks return to the pool once the run has left them behind.
       *
       * They used to be skipped here forever: every rocket kill permanently removed a
       * unit from the pool for the rest of the run. Sections one through nine never
       * showed it - the pool was still deep - but a player who uses the rocket steadily
       * had burned through enough of it by section ten that the director had nothing
       * left to send, and the road emptied out exactly when the target was climbing.
       * The harness never caught this because the harness never fires rockets.
       *
       * The hulk stays put as debris while it is anywhere near you; only once it is far
       * behind and out of sight does it stop being scenery and become a car again.
       */
      if (unit.active && unit.destroyed) {
        const wreckProgress = this.terrain.progressAt(unit.vehicle.x, unit.vehicle.z);
        if (
          playerProgress - wreckProgress > CONFIG.police.pacing.retireBehind &&
          !this.onScreen(unit, ctx)
        ) {
          unit.reset();
          unit.deactivate();
        }
        continue;
      }
      if (!unit.active || unit.destroyed) continue;
      const unitProgress = this.terrain.progressAt(unit.vehicle.x, unit.vehicle.z);
      // A rig the player has driven past has done its job, one way or the other.
      if (unit.role === "rig") {
        if (playerProgress - unitProgress > CONFIG.police.rig.retirePast) unit.deactivate();
        continue;
      }
      /*
       * A spent ambusher is finished: it took its shot out of its alley, and this class
       * gets one. Stood down as soon as it is out of view, which frees the slot for a
       * fresh one to go and wait somewhere further up the road.
       *
       * There is no width rule here any more. The pair used to be barred from narrow
       * road, which was the right answer while they were pursuit units; now they live in
       * the alleys, which are the narrowest geometry there is, and the thing that stops
       * them clogging a corridor is that they never linger in one.
       */
      if (unit.spent && !this.onScreen(unit, ctx)) {
        // Cosmetics only: stand a spent trap down behind the player or at distance,
        // not just around a corner ahead where the removal is watchable next second.
        const fwdX = Math.sin(ctx.player.heading);
        const fwdZ = Math.cos(ctx.player.heading);
        const ax = unit.vehicle.x - ctx.player.x;
        const az = unit.vehicle.z - ctx.player.z;
        const aheadOf = ax * fwdX + az * fwdZ;
        if (aheadOf < 10 || Math.hypot(ax, az) > 130) {
          unit.deactivate();
          continue;
        }
        continue;
      }
      if (playerProgress - unitProgress <= pacing.retireBehind) continue;
      // Never while the player can see it.
      if (this.onScreen(unit, ctx)) continue;

      // A straggler whose class has since retired is stood down rather than recycled, so
      // the wake loop below can replace it with something from the current tier.
      // Recycling reuses the same car and never re-picks its class, so without this a
      // patrol woken in section 2 was still being sent back at you in section 33 and
      // retirement did nothing at all.
      if (section > (esc.retire[unit.role] ?? 999)) {
        unit.deactivate();
        continue;
      }
      /*
       * A straggler that cannot be re-placed is stood down rather than left to trail.
       * This matters for the armoured classes specifically: every candidate spot around a
       * player who is in a corridor is now refused, so without this they simply stayed
       * awake and kept following you through it.
       */
      if (!this.spawnUnit(unit, ctx, playerProgress)) {
        if (esc.openRoad.roles.includes(unit.role)) unit.deactivate();
      }
    }

    /*
     * Fill toward the target. Refusals cost an attempt, never the tick.
     *
     * The old early-section loop gave up on the first refusal, which read as tuning but
     * was actually a leak: near the start line, behind-spawns land off-course and ambush
     * picks rarely have a spur in range, so most ticks recruited nobody and a stopped
     * player in section one sat unswarmed for most of a minute. Persistence is now
     * unconditional; the early sections keep their slower perTick instead.
     */
    this.effortSection = section;
    const late = section >= pacing.effortFromSection;
    let active = this.mainFleetCount;
    let woken = 0;
    let attempts = 0;
    const perTick = late ? pacing.wakePerTickLate : pacing.wakePerTick;
    while (active < target && woken < perTick && attempts < pacing.wakeAttempts) {
      attempts++;
      const unit = this.pickDormant(section, "main");
      if (!unit) break;
      if (!this.spawnUnit(unit, ctx, playerProgress)) continue;
      active++;
      woken++;
    }

    /*
     * The traps, on their own allowance.
     *
     * Kept to a single wake per tick and generous on attempts, because a spur has to be
     * in range for one to go anywhere at all and a refusal here must never eat into the
     * chase - which, with a shared budget and a shared loop, is exactly what it did.
     */
    let ambushers = this.ambusherCount;
    let ambushAttempts = 0;
    while (ambushers < ambushTarget && ambushAttempts < pacing.wakeAttempts) {
      ambushAttempts++;
      const unit = this.pickDormant(section, "ambush");
      if (!unit) break;
      if (!this.spawnUnit(unit, ctx, playerProgress)) continue;
      ambushers++;
      break;
    }

    /*
     * Ambush and side placements both tend to land in front, and the recycler pulls
     * stragglers forward, so a deep section could end up with the entire squad ahead of
     * the player and nothing at their back at all. Something is always behind you.
     *
     * Crucially this *moves* a car rather than adding one. Waking a fresh unit here ran
     * every director tick with no reference to the headcount target, which is a spawn
     * leak: section 3 was carrying fifteen cars against a target of six, and the whole
     * difficulty curve went with it. The unit furthest up the road is the one doing least,
     * so it is the one that gets sent back.
     */
    if (this.countBehind(ctx) < pacing.minBehind) {
      const spare = this.furthestAhead(ctx);
      if (spare) {
        this.spawnOnRoute(spare, ctx, playerProgress, "behind");
      } else if (active < target) {
        // Chase filler, so main fleet only - an ambusher belongs in an alley, not
        // dropped in behind you to make up the numbers.
        const unit = this.pickDormant(section, "main");
        if (unit && this.spawnOnRoute(unit, ctx, playerProgress, "behind")) active++;
      }
    }

    this.applySectionSpeed(section);
  }

  /**
   * Is this unit close enough and visible enough that moving it would be seen?
   *
   * Nothing the director does to a car should ever be witnessed. Recycling, retiring and
   * rear-pressure repositioning are all teleports, and a teleport in view reads as the
   * car vanishing — which is exactly what it is.
   */
  private onScreen(unit: PoliceCar, ctx: PursuitContext): boolean {
    if (unit.distanceToPlayer(ctx.player) > CONFIG.police.pacing.keepVisibleRange) return false;
    return ctx.world.lineOfSight(ctx.player.x, ctx.player.z, unit.vehicle.x, unit.vehicle.z);
  }

  /** Live units genuinely at your back, rather than alongside. */
  private countBehind(ctx: PursuitContext): number {
    const player = ctx.player;
    const fwd = forwardOf(player.heading);
    let n = 0;
    const traps = CONFIG.police.escalation.openRoad.roles;
    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
      // A trap idling in an alley behind you is not pressure, and letting it count
      // suppressed the reposition that keeps a real chaser at your back.
      if (u.role === "rig" || traps.includes(u.role)) continue;
      const dx = u.vehicle.x - player.x;
      const dz = u.vehicle.z - player.z;
      const along = dx * fwd.x + dz * fwd.z;
      if (along < -CONFIG.police.pacing.behindDistance) n++;
    }
    return n;
  }

  /** The unit furthest up the road, when there is no dormant one left to send. */
  private furthestAhead(ctx: PursuitContext): PoliceCar | null {
    const player = ctx.player;
    const fwd = forwardOf(player.heading);
    let best: PoliceCar | null = null;
    let bestAlong = 0;
    const traps = CONFIG.police.escalation.openRoad.roles;
    for (const u of this.units) {
      if (!u.active || u.destroyed || u.role === "rig") continue;
      /*
       * Never a juggernaut. This picked whatever was furthest up the road,
       * and the furthest thing up the road was usually an ambusher waiting in its
       * alley - which was then teleported to the player's back as a plain chaser,
       * ambush state wiped by the move. A juggernaut hunting you down from behind is
       * the exact thing that class is no longer supposed to be.
       */
      if (traps.includes(u.role)) continue;
      // Only ever move one the player is not watching.
      if (this.onScreen(u, ctx)) continue;
      const along = (u.vehicle.x - player.x) * fwd.x + (u.vehicle.z - player.z) * fwd.z;
      if (along > bestAlong) {
        bestAlong = along;
        best = u;
      }
    }
    return best;
  }

  /**
   * Hand the nearest units a station around the player.
   *
   * Each slot goes to whichever unassigned unit is closest to it, so the box forms from
   * whatever happens to be around rather than every car converging on the same corner.
   * Rigs, traps and anything mid-charge are left out: they have jobs that a station
   * would only interrupt.
   */
  private assignBox(ctx: PursuitContext): void {
    const cfg = CONFIG.police.shared.box;
    const player = ctx.player;
    const right = rightOf(player.heading);
    const fwd = forwardOf(player.heading);

    const available: PoliceCar[] = [];
    for (const u of this.units) {
      u.boxSlot = null;
      if (!u.active || u.destroyed || u.disabled) continue;
      if (u.role === "rig" || CONFIG.police.escalation.openRoad.roles.includes(u.role))
        continue;
      // A unit lying in wait is not available for a station.
      if (u.ambushAt) continue;
      if (u.distanceToPlayer(player) > cfg.range) continue;
      available.push(u);
    }

    /*
     * A player who has lost their speed is the moment the whole squad has been waiting
     * for, and it should look like they know it. Below `slowPlayerSpeed` the front
     * stations are filled first *by the units currently behind* — they have to overtake
     * to take them, which is exactly the manoeuvre that was missing. Left to itself the
     * tail simply kept pushing, which shoves the player along their own route and reads
     * as help rather than as an arrest.
     */
    const slow = player.speed < cfg.slowPlayerSpeed;
    const slots = cfg.slots.slice(0, cfg.maxAssigned);
    /*
     * Late-game discipline: pure side stations fill FIRST (rank 0), then the
     * forward arc, then the rear. The pack stops being a mob that shoves from
     * behind and becomes two flankers pinning the lanes with a governor ahead
     * - a formation, which is a thing a driver can out-drive.
     */
    const lateRank = (sl: { x: number; z: number }) => {
      if (Math.abs(sl.x) >= 6.8 && Math.abs(sl.z) < 3) return 0;
      if (sl.z > 0) return 1;
      return 2;
    };
    const order = slow
      ? [...slots].sort((s1, s2) => s2.z - s1.z).slice(0, cfg.slowFrontPriority).concat(
          [...slots].sort((s1, s2) => s2.z - s1.z).slice(cfg.slowFrontPriority),
        )
      : this.sectionNow >= cfg.lateSidesFirst
        ? [...slots].sort((s1, s2) => lateRank(s1) - lateRank(s2))
        : slots;

    const taken = new Set<PoliceCar>();
    for (const slot of order) {
      const wx = player.x + right.x * slot.x + fwd.x * slot.z;
      const wz = player.z + right.z * slot.x + fwd.z * slot.z;

      let best: PoliceCar | null = null;
      let bestD = Infinity;
      for (const u of available) {
        if (taken.has(u)) continue;
        const d = Math.hypot(u.vehicle.x - wx, u.vehicle.z - wz);
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      if (!best) break;
      taken.add(best);
      best.boxSlot = slot;
    }
  }

  /**
   * Put a rig on the road ahead, in position and across the carriageway.
   *
   * The old behaviour had it wake up behind the player and race past to set up, which is
   * both unconvincing for a nine-metre transport and the reason three of them could end
   * up stacked in the same place. It is now pre-positioned: it exists at the block, and
   * when the player has gone past, it is done.
   */
  private placeRig(unit: PoliceCar, ctx: PursuitContext, playerProgress: number): boolean {
    const cfg = CONFIG.police.rig;
    // Broadside, the rig spans two half-LENGTHS across the road.
    const span = cfg.vehicle.halfLength;

    /*
     * The widest laterally clear run across the road, same probe idea as the
     * hazard field: props standing near the kerb are walls as far as a car is
     * concerned, so the band that matters is the drivable one, not the tarmac.
     */
    const bandAt = (x: number, z: number, seg: { dx: number; dz: number }, road: number) => {
      const PROBES = 25;
      let bestLo = 0;
      let bestHi = 0;
      let runLo: number | null = null;
      for (let i = 0; i < PROBES; i++) {
        const lat = -road + (2 * road * i) / (PROBES - 1);
        if (ctx.world.isClear(x + seg.dz * lat, z - seg.dx * lat, 0.95)) {
          if (runLo === null) runLo = lat;
          if (lat - runLo > bestHi - bestLo) {
            bestLo = runLo;
            bestHi = lat;
          }
        } else {
          runLo = null;
        }
      }
      return { lo: bestLo, hi: bestHi };
    };

    const themeOk = (progress: number) => {
      const theme = SECTION_THEMES[sectionIndexAt(progress)];
      return !(cfg.bannedThemes as readonly string[]).includes(theme);
    };

    /*
     * Spawn honesty, same terms as everyone else: far enough that appearing is
     * indistinguishable from having driven in, or hidden - and never close,
     * full stop. Progress distance alone lies at switchbacks, which is how a
     * rig could satisfy scoutMin and still pop in thirty units from the nose.
     */
    const honest = (x: number, z: number) => {
      const pd = dist(x, z, ctx.player.x, ctx.player.z);
      if (pd < 120) return false;
      if (pd >= cfg.minSpawnDist) return true;
      return !ctx.world.lineOfSight(ctx.player.x, ctx.player.z, x, z);
    };

    /*
     * Two-rig wall: partner a standing block when the band takes both
     * broadsides AND the gap. Staggered along-track so it reads as a formed
     * wall, covering the opposite side - the opening stays whole, in the
     * middle, and is still the class's one unbreakable promise.
     */
    if (this.sectionNow >= cfg.wallFromSection) {
      for (const other of this.units) {
        if (other === unit || other.role !== "rig" || !other.active || other.destroyed) continue;
        const post = other.parkedPost;
        if (!post) continue;
        if (post.progress - playerProgress < 150) continue;
        if (!themeOk(post.progress + 14)) continue;
        /*
         * The staggered row is computed from the post's own segment - nav nodes
         * sit ~43 apart, so nodeAtProgress(post+14) snaps back to the partner's
         * OWN node and the occupancy check rejects the wall every time.
         */
        const segO = this.terrain.sample(post.x, post.z).segment;
        const bx = post.x + segO.dx * 14;
        const bz = post.z + segO.dz * 14;
        if (!honest(bx, bz)) continue;
        if (this.occupied(bx, bz)) continue;
        const segN = this.terrain.sample(bx, bz).segment;
        const bandN = bandAt(bx, bz, segN, segN.halfWidth);
        /*
         * ECHELON, not side-by-side: the widest clear band on a course is ~22,
         * and two broadsides plus a gap need 29 - a true double row cannot
         * exist here. Staggered opposite-side hugs form the wall instead: each
         * row keeps its own whole opening, and getting through is an S-turn
         * rather than a straight line. Wide-ish bands only, so the weave is a
         * fight and not a scrape.
         */
        if (bandN.hi - bandN.lo < 2 * span + cfg.minGap + 3) continue;
        const lateral = other.parkedLateral > 0 ? bandN.lo + span : bandN.hi - span;
        unit.placeAt(
          bx + segN.dz * lateral,
          bz - segN.dx * lateral,
          segN.heading + Math.PI / 2,
          post.y,
        );
        unit.parkAt(
          post,
          lateral,
          14,
          segN.heading + Math.PI / 2,
          bandN.lo + span,
          bandN.hi - span,
        );
        return true;
      }
    }

    let best: NavNode | null = null;
    let bestScore = Infinity;
    let bestLateral = 0;
    let bestTheta = Math.PI / 2;
    let bestClampLo = -Infinity;
    let bestClampHi = Infinity;

    for (let d = cfg.scoutMin; d <= cfg.scoutMax; d += 16) {
      const node = ctx.nav.nodeAtProgress(playerProgress + d);
      if (!themeOk(node.progress)) continue;
      const seg = this.terrain.sample(node.x, node.z).segment;
      const width = ctx.world.freeWidth(node.x, node.z, seg.heading);
      if (width < cfg.minBlockWidth) continue;
      if (this.occupied(node.x, node.z)) continue;
      if (!honest(node.x, node.z)) continue;
      const band = bandAt(node.x, node.z, seg, seg.halfWidth);
      const bw = band.hi - band.lo;
      /*
       * THE rule: block plus a whole opening the player fits through, or no
       * block here. Perpendicular when the band takes it; on narrower roads
       * the rig JACKKNIFES - angling the trailer down to 40 degrees shrinks
       * its across-road footprint until the opening survives, and a slewed
       * trailer is what a hasty roadblock looks like anyway. Roads too narrow
       * even for that get no rig, full stop - that is what made the canyon
       * unpassable.
       */
      const hw = cfg.vehicle.halfWidth;
      let theta: number | null = null;
      let proj = 0;
      for (let deg = 90; deg >= 40; deg -= 5) {
        const t = (deg * Math.PI) / 180;
        const p2 = span * Math.sin(t) + hw * Math.cos(t);
        if (bw - 2 * p2 >= cfg.minGap) {
          theta = t;
          proj = p2;
          break;
        }
      }
      if (theta === null) continue;
      const score = width * 2 + d * 0.04 + (width < cfg.preferredWidth ? -25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = node;
        bestTheta = theta;
        // Hug one kerb - which one varies by spot - so the opening is single and whole.
        bestLateral = (node.id & 1) === 0 ? band.hi - proj : band.lo + proj;
        bestClampLo = band.lo + proj;
        bestClampHi = band.hi - proj;
      }
    }
    if (!best) return false;

    const seg = this.terrain.sample(best.x, best.z).segment;
    const yaw = seg.heading + bestTheta;
    unit.placeAt(
      best.x + seg.dz * bestLateral,
      best.z - seg.dx * bestLateral,
      yaw,
      best.y,
    );
    unit.parkAt(best, bestLateral, 0, yaw, bestClampLo, bestClampHi);
    return true;
  }



  /** Weighted pick over dormant units whose class has unlocked for this section. */
  private pickDormant(section: number, group: "main" | "ambush"): PoliceCar | null {
    const esc = CONFIG.police.escalation;
    let total = 0;
    const candidates: Array<{ unit: PoliceCar; weight: number }> = [];
    for (const unit of this.units) {
      if (unit.active || unit.destroyed) continue;
      // Each budget draws only from its own classes.
      const isAmbusher = esc.openRoad.roles.includes(unit.role);
      if (group === "ambush" ? !isAmbusher : isAmbusher) continue;
      if (section < (esc.unlock[unit.role] ?? 0)) continue;
      // Past its retirement the class is simply no longer dispatched. Headcount is
      // capped, so the mix is what escalation has left to turn once the cap is reached.
      if (section > (esc.retire[unit.role] ?? 999)) continue;
      // One roadblock at a time. Three of them stacked in the same pinch is not a
      // roadblock, it is a wall with no play in it.
      if (unit.role === "rig") {
        const rc = CONFIG.police.rig;
        const rigCap = section >= rc.wallFromSection ? rc.wallMaxActive : rc.maxActive;
        if (this.activeRigs >= rigCap) continue;
      }
      const weight = esc.weight[unit.role] ?? 1;
      candidates.push({ unit, weight });
      total += weight;
    }
    if (candidates.length === 0) return null;

    let roll = Math.random() * total;
    for (const c of candidates) {
      roll -= c.weight;
      if (roll <= 0) return c.unit;
    }
    return candidates[candidates.length - 1].unit;
  }

  /** Everything gets a little faster as the run goes on, capped so it stays driveable. */
  private applySectionSpeed(section: number): void {
    const esc = CONFIG.police.escalation;
    const bonus = Math.min(
      esc.maxSpeedBonus,
      section * esc.speedPerSection + Math.max(0, section - 8) * esc.lateSpeedPerSection,
    );
    const aggro = Math.min(esc.aggroMax, Math.max(0, (section - 9) * esc.aggroPerSection));
    if (bonus === this.speedBonus && aggro === this.aggro) return;
    this.speedBonus = bonus;
    this.aggro = aggro;
    for (const unit of this.units) {
      const base = CONFIG.police[unit.role].vehicle.maxSpeed;
      unit.vehicle.params = { ...unit.vehicle.params, maxSpeed: base + bonus };
      unit.aggro = aggro;
    }
  }

  /**
   * Wake a unit somewhere it can hurt you from.
   *
   * Spawning out of sight is preferred, but it cannot be *required*: the open sections
   * have almost nothing to block line of sight, so an out-of-sight-only rule rejected
   * every candidate spot and the flats ended up with no police in them at all. Beyond
   * `farSpawnDistance` a car appearing is indistinguishable from one that drove in, so
   * distance is accepted as an alternative to concealment. Spurs sidestep the question
   * entirely — their own walls do the hiding.
   */
  private spawnUnit(unit: PoliceCar, ctx: PursuitContext, playerProgress: number): boolean {
    /*
     * Retirement is ABSOLUTE. The picker filters mustered-out classes, but the
     * recycle and rear-guarantee paths reuse whatever unit they are handed - a
     * patrol was observed being re-dispatched at section nineteen through one
     * of them. Every dispatch flows through here; no retired class gets out.
     */
    if (this.sectionNow > (CONFIG.police.escalation.retire[unit.role] ?? 999)) return false;
    // A rig is placed where it is going to block, already broadside, well out of sight.
    // It never chases and never overtakes - it is simply there when you arrive.
    if (unit.role === "rig") return this.placeRig(unit, ctx, playerProgress);

    /*
     * The armoured pair arrive from the side and nowhere else.
     *
     * Appearing on the road ahead makes them a roadblock you drive up to and read at
     * leisure, which is the opposite of the class: their whole job is to come across you
     * from a direction you were not checking and put you into a wall. Behind is no better
     * - it turns a specialist into another tailgater. So they get one spawn mode, and if
     * there is no room at the side of the road they simply are not sent.
     */
    /*
     * The armoured pair go into a side alley or nowhere at all.
     *
     * Not "prefer the spur" - only the spur. Every other arrival put them on the road
     * with you, and from there they behave like a heavy: they close, they trail, they end
     * up in front. Waiting in a dead end is the entire class now, so a spawn that cannot
     * find one is simply refused.
     */
    if (CONFIG.police.escalation.openRoad.roles.includes(unit.role)) {
      return this.spawnInSpur(unit, ctx, playerProgress);
    }

    // Try the preferred placement first, then fall through the rest: a spur may be out of
    // range, and a walled section has no run-off to sit in, but *something* has to spawn.
    const first = this.pickSpawnMode();
    const order: SpawnMode[] = [first, ...SPAWN_MODES.filter((m) => m !== first)];

    for (const mode of order) {
      if (mode === "ambush" && this.spawnInSpur(unit, ctx, playerProgress)) return true;
      if (mode !== "ambush" && this.spawnOnRoute(unit, ctx, playerProgress, mode)) return true;
    }
    return false;
  }

  /** Weighted choice of where the next unit comes from. */
  private pickSpawnMode(): SpawnMode {
    const weights = CONFIG.police.pacing.spawnWeights;
    let total = 0;
    for (const m of SPAWN_MODES) total += weights[m];
    let roll = Math.random() * total;
    for (const m of SPAWN_MODES) {
      roll -= weights[m];
      if (roll <= 0) return m;
    }
    return "behind";
  }

  /**
   * The ambush: park the unit deep in a dead-end spur up the road, nose pointed at the
   * mouth, and let the player drive past it.
   *
   * Nothing else about the unit changes — it wakes up chasing like any other. The whole
   * effect comes from where it was standing when it did.
   */
  private spawnInSpur(unit: PoliceCar, ctx: PursuitContext, playerProgress: number): boolean {
    const pacing = CONFIG.police.pacing;
    const candidates: SpurDef[] = [];
    for (const spur of SPURS) {
      const lead = spur.progress - playerProgress;
      if (lead < pacing.ambushLeadMin || lead > pacing.ambushLeadMax) continue;
      candidates.push(spur);
    }
    if (candidates.length === 0) return false;

    // Randomise which spur so a repeated run does not stage the same ambushes.
    const nearestNav = (px: number, pz: number): number => {
      let best = Infinity;
      for (const node of ctx.nav.nodes) {
        const d = (node.x - px) * (node.x - px) + (node.z - pz) * (node.z - pz);
        if (d < best) best = d;
      }
      return best;
    };
    for (let i = 0; i < candidates.length; i++) {
      const spur = candidates[Math.floor(Math.random() * candidates.length)];
      /*
       * Pick the mouth end by evidence, not by field order: whichever end sits
       * nearer the spine's nav line is the road end. A handful of spur records are
       * inverted, and trusting them seated the truck ON the road - armed, exposed,
       * a sitting duck by construction.
       */
      const invert = nearestNav(spur.bx, spur.bz) < nearestNav(spur.ax, spur.az);
      const mx = invert ? spur.bx : spur.ax;
      const mz = invert ? spur.bz : spur.az;
      const dx = invert ? spur.ax : spur.bx;
      const dz = invert ? spur.az : spur.bz;
      // Degenerate spur records exist; a seat that is not genuinely deeper than its
      // mouth, or a mouth that is not genuinely on the road, is not an ambush site.
      // Eighteen: a truck holding twelve deep needs an alley that can swallow it
      // whole, or "hidden" is a word rather than a fact.
      if (Math.hypot(dx - mx, dz - mz) < 18) continue;
      if (nearestNav(mx, mz) > 625) continue;
      /*
       * One truck per alley. The occupancy check tests the SEAT point, and the first
       * truck creeps forward off its seat - so a second was seated right behind it,
       * single file, shoving its colleague out through the mouth. An armed claim on
       * the mouth is the real occupancy.
       */
      let claimed = false;
      for (const other of this.units) {
        if (
          other !== unit &&
          other.active &&
          other.ambushAt &&
          Math.hypot(other.ambushAt.x - mx, other.ambushAt.z - mz) < 14
        ) {
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
      /*
       * An alley that cannot SEE the approach cannot time a strike: require line of
       * sight from the mouth to the road ~30 units up-course, or refuse the seat.
       * The one chronic acceptance-test miss was a spur whose walls hid the player
       * until the launch was already late.
       */
      if (CONFIG.police.escalation.openRoad.roles.includes(unit.role)) {
        const sightNode = ctx.nav.nodeAtProgress(Math.max(0, spur.progress - 48));
        if (!ctx.world.lineOfSight(mx, mz, sightNode.x, sightNode.z)) continue;
      }
      /*
       * Seat depth is role-split. The FLEET keeps its proportional deep seat - the
       * player's verdict: they had it right, hidden in the back. The JUGGERNAUT
       * alone sits at a CONSTANT twenty units from the mouth: deep enough that
       * nothing pokes out, and constant because a fixed runway is what makes its
       * one launch timing calibratable at all.
       */
      const len = Math.hypot(dx - mx, dz - mz);
      const isArmoured = CONFIG.police.escalation.openRoad.roles.includes(unit.role);
      const t = isArmoured ? Math.min(0.85, 20 / Math.max(1, len)) : pacing.ambushDepth;
      const x = mx + (dx - mx) * t;
      const z = mz + (dz - mz) * t;
      if (Math.hypot(x - mx, z - mz) < 5) continue;
      if (this.occupied(x, z)) continue;
      if (!ctx.world.isClear(x, z, 3.5)) continue;
      // A spur that has been clipped by other geometry is a car parked in a box,
      // not an ambush.
      if (!ctx.world.canReach(x, z, mx, mz)) continue;

      // Facing the mouth, so it comes out forwards rather than reversing into the road —
      // and holding there until the player's own timing says go. `placeAt` resets the
      // unit, so the ambush has to be armed after it.
      unit.placeAt(x, z, headingOf(mx - x, mz - z), spur.ay);
      unit.ambushAt = { x: mx, z: mz };
      const ol = Math.hypot(mx - x, mz - z) || 1;
      unit.ambushOut = { x: (mx - x) / ol, z: (mz - z) / ol };
      return true;
    }
    return false;
  }

  /**
   * Placement relative to the player along the spine.
   *
   * "side" is the same thing pushed out into the run-off, so open sections get units
   * converging across the grass instead of queueing up on the tarmac.
   */
  private spawnOnRoute(
    unit: PoliceCar,
    ctx: PursuitContext,
    playerProgress: number,
    mode: Exclude<SpawnMode, "ambush">,
  ): boolean {
    const pacing = CONFIG.police.pacing;
    /*
     * Candidate distances. Three is plenty while the road is quiet; deep in a run most
     * nearby spots are legitimately taken, so the ladder lengthens past the gate. Behind
     * gets the most rungs, being the direction the player is not looking in.
     */
    const wide = this.effortSection >= pacing.effortFromSection;
    const armoured = CONFIG.police.escalation.openRoad.roles.includes(unit.role);
    const offsets =
      mode === "behind"
        ? wide
          ? [0.7, 1, 1.3, 1.7, 2.1, 2.6, 3.2].map((k) => -pacing.spawnBehind * k)
          : [-pacing.spawnBehind, -pacing.spawnBehind * 1.5, -pacing.spawnBehind * 0.7]
        : mode === "ahead"
          ? wide
            ? [1, 1.35, 1.8, 2.3, 2.9].map((k) => pacing.spawnAhead * k)
            : [pacing.spawnAhead, pacing.spawnAhead * 1.4, pacing.spawnAhead * 1.9]
          : wide
            ? [0.7, 1.1, -0.6, -1.2, -1.8].map((k) =>
                k > 0 ? pacing.spawnAhead * k : pacing.spawnBehind * k)
            : [pacing.spawnAhead * 0.7, -pacing.spawnBehind * 0.6, pacing.spawnAhead * 1.1];

    for (const offset of offsets) {
      const node = ctx.nav.nodeAtProgress(playerProgress + offset);
      let x = node.x;
      let z = node.z;

      if (mode === "side") {
        const seg = this.terrain.sample(node.x, node.z).segment;
        /*
         * A shoulder of nine units exists in one theme of seven, so past the gate a side
         * placement uses whatever width is there rather than refusing outright - otherwise
         * a quarter of the spawn budget goes nowhere on every tick of the late game.
         *
         * The armoured pair are exempt outright: they are already restricted to open road,
         * and side is the only arrival they are allowed, so holding them to a nine-unit
         * shoulder as well left them spawning almost never at all.
         */
        if (!wide && !armoured && seg.shoulder < pacing.sideShoulderMin) continue;
        // Right-hand perpendicular of the segment direction, either side.
        const side = Math.random() < 0.5 ? 1 : -1;
        const lateral =
          seg.shoulder > 3
            ? seg.halfWidth + seg.shoulder * 0.65
            : Math.max(0, seg.halfWidth - 2.5);
        x = node.x + seg.dz * lateral * side;
        z = node.z - seg.dx * lateral * side;
        // It has to be able to get *out* again. Run-off is fenced at its outer edge and
        // split by the rails of neighbouring legs, so "clear ground with the player in
        // sight" is not the same as "somewhere a car can drive from".
        if (!this.terrain.sample(x, z).onCourse) continue;
        if (!ctx.world.canReach(x, z, node.x, node.z)) continue;
      }

      const d = Math.hypot(x - ctx.player.x, z - ctx.player.z);
      // A stopped player gets the chase brought to them, rather than waiting for it.
      const near =
        ctx.player.speed < pacing.slowPlayerSpeed
          ? pacing.minSpawnDistance * pacing.slowSpawnScale
          : pacing.minSpawnDistance;
      /*
       * Spots in front of the player answer to a deeper minimum, hidden or not. A spawn
       * eighty units ahead behind a corner is in plain view two seconds later; the same
       * car placed at 145 drives in like everything else and nobody sees it arrive. The
       * pressure is unchanged - the wake loop simply lands the same car deeper on the
       * same tick - but the arrival is never watchable.
       */
      const fwdX = Math.sin(ctx.player.heading);
      const fwdZ = Math.cos(ctx.player.heading);
      const aheadOf = (x - ctx.player.x) * fwdX + (z - ctx.player.z) * fwdZ;
      if (aheadOf > 15 && d < pacing.minAheadSpawnDistance) continue;
      if (d < near) continue;
      const hidden = !ctx.world.lineOfSight(ctx.player.x, ctx.player.z, x, z);
      /*
       * Everything else may appear in plain sight if it is far enough away, on the theory
       * that at distance you cannot tell an arrival from a car that drove in. That theory
       * does not hold for these two: they are rare, unmistakable, and the encounter is
       * supposed to start with you not having seen them coming. Watching one blink into
       * the road ahead is the exact opposite of the ambush it is meant to be.
       *
       * The test is "not in front of you" rather than the geometric `hidden`, because the
       * camera looks forward: a car appearing behind you is already off screen whether or
       * not a wall happens to be in the way. Demanding geometric concealment as well left
       * them almost never spawning at all - 1.2 active minutes against the heavy's 32.8,
       * with the class weight raised to 6 to try to compensate. Placement was the binding
       * constraint, not rarity.
       */
      if (armoured && !hidden) {
        const fx = Math.sin(ctx.player.heading);
        const fz = Math.cos(ctx.player.heading);
        const ahead = ((x - ctx.player.x) * fx + (z - ctx.player.z) * fz) / Math.max(1, d);
        if (ahead > -0.15) continue;
      }
      /*
       * A stopped player relaxes the visible-arrival floor to the ahead minimum. The
       * far floor exists to hide arrivals from a driver closing on them at speed; at
       * the start line it meant every rung on a long straight was in view and refused,
       * so a player who froze at the lights was never reinforced at all. 145 out,
       * driving in, reads as traffic - and it is the swarm the freeze is asking for.
       */
      const farNeed =
        ctx.player.speed < pacing.slowPlayerSpeed
          ? pacing.minAheadSpawnDistance
          : pacing.farSpawnDistance;
      if (!hidden && d < farNeed) continue;
      if (!ctx.world.isClear(x, z, 3.5)) continue;
      if (this.occupied(x, z)) continue;

      unit.placeAt(x, z, headingOf(ctx.player.x - x, ctx.player.z - z), this.terrain.heightAt(x, z));
      return true;
    }
    return false;
  }

  /** Is another live unit already sitting here? Two cars in one alley is one wasted car. */
  private occupied(x: number, z: number): boolean {
    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
      const dx = u.vehicle.x - x;
      const dz = u.vehicle.z - z;
      if (dx * dx + dz * dz < 100) return true;
    }
    return false;
  }

  /**
   * The opening wave: the cars that are already out looking for you when the lights go
   * green. Placed directly rather than through the spawn rules, because at zero progress
   * there is no "behind" for the director to work with.
   *
   * Every one of them is somewhere you have to *arrive* at — up the road, or waiting in
   * an alley off it. None are on the start line. Two patrol cars sitting alongside you
   * before you have touched a key reads as a bug rather than as pressure, and it was one:
   * the two negative offsets this list used to carry both clamped to the first node on
   * the spine, which is exactly where the player is.
   */
  private spawnOpeningWave(nav: NavGraph): void {
    const pacing = CONFIG.police.pacing;
    const wave = pacing.openingWave;
    const patrols = this.units.filter((u) => u.role === "patrol");
    let placed = 0;

    // Anyone waiting in an early spur comes at you from the side rather than head-on,
    // which is the whole reason the spurs exist.
    const [spurFrom, spurTo] = pacing.openingSpurRange;
    const nearSpurs = SPURS.filter(
      (sp) => sp.progress > spurFrom && sp.progress < spurTo,
    ).slice(0, pacing.openingAmbushes);

    for (const spur of nearSpurs) {
      const unit = patrols[placed];
      if (!unit) break;
      const t = pacing.ambushDepth;
      const x = spur.ax + (spur.bx - spur.ax) * t;
      const z = spur.az + (spur.bz - spur.az) * t;
      unit.placeAt(x, z, headingOf(spur.ax - x, spur.az - z), spur.ay);
      placed++;
    }

    // The immediate threat: cars already coming back down the road at you.
    for (const offset of pacing.openingChasers) {
      const unit = patrols[placed];
      if (!unit) break;
      const node = nav.nodeAtProgress(offset);
      const prev = nav.nodeAtProgress(Math.max(0, offset - 40));
      unit.placeAt(node.x, node.z, headingOf(prev.x - node.x, prev.z - node.z), node.y);
      placed++;
    }

    for (const offset of wave) {
      const unit = patrols[placed];
      if (!unit) break;
      const node = nav.nodeAtProgress(offset);
      const next = nav.nodeAtProgress(offset + 40);
      /*
       * Facing *up* the course, driving away from you.
       *
       * They turn and engage the moment you are on them, so the pressure is unchanged —
       * but you arrive behind them rather than into them. Head-on was survivable on a
       * fifty-unit road and is a wall on an eighteen-unit one: three cars abreast is the
       * whole street, and a run that begins by driving into it is not a chase.
       */
      unit.placeAt(node.x, node.z, headingOf(next.x - node.x, next.z - node.z), node.y);
      placed++;
    }
  }

  /**
   * Live units within `radius` of the player — drives both the HUD and the capture check.
   * Wrecks and dormant units are excluded: a burnt-out hulk must not be able to arrest you.
   */
  countNear(x: number, z: number, radius: number): number {
    let n = 0;
    const r2 = radius * radius;
    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
      const dx = u.vehicle.x - x;
      const dz = u.vehicle.z - z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  /**
   * How many directions around a point are blocked by a live unit.
   *
   * The circle is cut into `enclosureSectors` wedges and each is marked by the nearest
   * unit inside `enclosureRadius`. This is the whole loss condition: it answers "is there
   * a way out of here", where counting cars only ever answered "how many are touching me".
   *
   * Walls answer the same question and were being ignored, so three cars holding you
   * flat against a building read as three blocked directions when the true number was
   * eight. Passing `collision` lets geometry count too - under the guards in
   * `wallAssist`, which exist because the naive version of this made every narrow street
   * an arrest.
   */
  enclosure(x: number, z: number, collision?: CollisionWorld): number {
    const run = CONFIG.run;
    const sectors = run.enclosureSectors;
    const covered = new Array<boolean>(sectors).fill(false);
    const r2 = run.enclosureRadius * run.enclosureRadius;

    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
      const dx = u.vehicle.x - x;
      const dz = u.vehicle.z - z;
      if (dx * dx + dz * dz > r2) continue;
      let a = Math.atan2(dx, dz) / (Math.PI * 2);
      a -= Math.floor(a);
      covered[Math.min(sectors - 1, Math.floor(a * sectors))] = true;
    }
    const byPolice = covered.reduce((n, c) => n + (c ? 1 : 0), 0);

    const wall = CONFIG.run.wallAssist;
    /*
     * Cars first, always. Geometry only ever *adds* to a squad that already has hold of
     * you, so an empty corridor - however tight - is worth nothing, and the wall test is
     * skipped entirely on the frames that matter for cost.
     */
    if (!collision || !wall.enabled || byPolice < wall.minPoliceSectors) return byPolice;

    // One ray per wedge, out to the same radius the cars are judged at. `canReach` is the
    // right test rather than proximity: a kerb is close and drives over, a rail is
    // further and does not.
    const blocked = covered.slice();
    let byWall = 0;
    for (let i = 0; i < sectors; i++) {
      if (blocked[i]) continue;
      const theta = ((i + 0.5) / sectors) * Math.PI * 2;
      const tx = x + Math.sin(theta) * run.enclosureRadius;
      const tz = z + Math.cos(theta) * run.enclosureRadius;
      if (collision.canReach(x, z, tx, tz)) continue;
      blocked[i] = true;
      byWall++;
    }
    if (byWall === 0) return byPolice;

    /*
     * The guard that the reverted attempt was missing: a way out is a *contiguous* arc,
     * not a headcount. Blocked left, blocked right and blocked behind is a street with
     * the road ahead wide open - the shape of most of the course - and counting those
     * five wedges made every corner an arrest. Walls only count once the combined gap is
     * too narrow to be an escape.
     */
    let longestGap = 0;
    let gap = 0;
    for (let i = 0; i < sectors * 2; i++) {
      if (blocked[i % sectors]) {
        gap = 0;
        continue;
      }
      gap++;
      if (gap > longestGap) longestGap = gap;
    }
    if (longestGap > wall.escapeArc) return byPolice;

    // Capped, so geometry can tighten a pin the cars have already started but can never
    // deliver one by itself.
    return Math.min(sectors, byPolice + Math.min(byWall, wall.maxSectors));
  }

  syncViews(dt: number, elapsed: number): void {
    for (const u of this.units) {
      if (!u.active) continue;
      u.syncView(dt, elapsed, this.terrain.heightAt(u.vehicle.x, u.vehicle.z));
    }
  }
}
