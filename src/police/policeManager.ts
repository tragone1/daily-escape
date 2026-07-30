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
import { CONFIG, type PoliceRole } from "../config";
import { forwardOf, headingOf, rightOf } from "../math";
import { POLICE_LOOKAHEAD, SPURS, type SpurDef } from "../world/course";
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

    this.boxTimer -= dt;
    if (this.boxTimer <= 0) {
      this.boxTimer = CONFIG.police.shared.box.interval;
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
  private director(ctx: PursuitContext, playerProgress: number, section: number): void {
    const esc = CONFIG.police.escalation;
    const pacing = CONFIG.police.pacing;

    const target = Math.min(
      esc.maxActive,
      Math.round(esc.baseActive + section * esc.activePerSection),
    );

    // Recycle stragglers first; they may well cover the whole deficit on their own.
    for (const unit of this.units) {
      if (!unit.active || unit.destroyed) continue;
      const unitProgress = this.terrain.progressAt(unit.vehicle.x, unit.vehicle.z);
      // A rig the player has driven past has done its job, one way or the other.
      if (unit.role === "rig") {
        if (playerProgress - unitProgress > CONFIG.police.rig.retirePast) unit.deactivate();
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
      this.spawnUnit(unit, ctx, playerProgress);
    }

    /*
     * Fill toward the target. Past `effortFromSection`, keep trying after a refusal.
     *
     * Below the gate this is exactly the old loop - two attempts, give up on the first
     * refusal - because the early sections are tuned and must not move. Above it, refusals
     * cost an attempt rather than the entire tick's recruitment.
     */
    this.effortSection = section;
    const persistent = section >= pacing.effortFromSection;
    let active = this.activeCount;
    let woken = 0;
    let attempts = 0;
    const maxAttempts = persistent ? pacing.wakeAttempts : pacing.wakePerTick;
    while (active < target && woken < pacing.wakePerTick && attempts < maxAttempts) {
      attempts++;
      const unit = this.pickDormant(section);
      if (!unit) break;
      if (!this.spawnUnit(unit, ctx, playerProgress)) {
        if (!persistent) break;
        continue;
      }
      active++;
      woken++;
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
        const unit = this.pickDormant(section);
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
    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
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
    for (const u of this.units) {
      if (!u.active || u.destroyed || u.role === "rig") continue;
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
   * Rigs, wardens and anything mid-charge are left out: they have jobs that a station
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
      if (u.role === "rig" || u.role === "warden") continue;
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
    const order = slow
      ? [...slots].sort((s1, s2) => s2.z - s1.z).slice(0, cfg.slowFrontPriority).concat(
          [...slots].sort((s1, s2) => s2.z - s1.z).slice(cfg.slowFrontPriority),
        )
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
    let best: NavNode | null = null;
    let bestScore = Infinity;

    for (let d = cfg.scoutMin; d <= cfg.scoutMax; d += 16) {
      const node = ctx.nav.nodeAtProgress(playerProgress + d);
      const seg = this.terrain.sample(node.x, node.z).segment;
      const width = ctx.world.freeWidth(node.x, node.z, seg.heading);
      if (width < cfg.minBlockWidth) continue;
      if (this.occupied(node.x, node.z)) continue;
      const score = width * 2 + d * 0.04 + (width < cfg.preferredWidth ? -25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    if (!best) return false;

    const seg = this.terrain.sample(best.x, best.z).segment;
    unit.placeAt(best.x, best.z, seg.heading + Math.PI / 2, best.y);
    unit.parkAt(best);
    return true;
  }

  /** Weighted pick over dormant units whose class has unlocked for this section. */
  private pickDormant(section: number): PoliceCar | null {
    const esc = CONFIG.police.escalation;
    let total = 0;
    const candidates: Array<{ unit: PoliceCar; weight: number }> = [];
    for (const unit of this.units) {
      if (unit.active || unit.destroyed) continue;
      if (section < (esc.unlock[unit.role] ?? 0)) continue;
      // Past its retirement the class is simply no longer dispatched. Headcount is
      // capped, so the mix is what escalation has left to turn once the cap is reached.
      if (section > (esc.retire[unit.role] ?? 999)) continue;
      // One roadblock at a time. Three of them stacked in the same pinch is not a
      // roadblock, it is a wall with no play in it.
      if (unit.role === "rig" && this.activeRigs >= CONFIG.police.rig.maxActive) continue;
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
    const bonus = Math.min(esc.maxSpeedBonus, section * esc.speedPerSection);
    if (bonus === this.speedBonus) return;
    this.speedBonus = bonus;
    for (const unit of this.units) {
      const base = CONFIG.police[unit.role].vehicle.maxSpeed;
      unit.vehicle.params = { ...unit.vehicle.params, maxSpeed: base + bonus };
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
    // A rig is placed where it is going to block, already broadside, well out of sight.
    // It never chases and never overtakes - it is simply there when you arrive.
    if (unit.role === "rig") return this.placeRig(unit, ctx, playerProgress);

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
    for (let i = 0; i < candidates.length; i++) {
      const spur = candidates[Math.floor(Math.random() * candidates.length)];
      const t = pacing.ambushDepth;
      const x = spur.ax + (spur.bx - spur.ax) * t;
      const z = spur.az + (spur.bz - spur.az) * t;
      if (this.occupied(x, z)) continue;
      if (!ctx.world.isClear(x, z, 3.5)) continue;
      // The spur mouth is on the spine, so this should always hold - but a spur that has
      // been clipped by other geometry is a car parked in a box, not an ambush.
      if (!ctx.world.canReach(x, z, spur.ax, spur.az)) continue;

      // Facing the mouth, so it comes out forwards rather than reversing into the road —
      // and holding there until the player's own timing says go. `placeAt` resets the
      // unit, so the ambush has to be armed after it.
      unit.placeAt(x, z, headingOf(spur.ax - x, spur.az - z), spur.ay);
      unit.ambushAt = { x: spur.ax, z: spur.az };
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
    const offsets =
      mode === "behind"
        ? wide
          ? [0.7, 1, 1.3, 1.7, 2.1, 2.6, 3.2].map((k) => -pacing.spawnBehind * k)
          : [-pacing.spawnBehind, -pacing.spawnBehind * 1.5, -pacing.spawnBehind * 0.7]
        : mode === "ahead"
          ? wide
            ? [1, 1.3, 0.75, 1.7, 2.2].map((k) => pacing.spawnAhead * k)
            : [pacing.spawnAhead, pacing.spawnAhead * 1.4, pacing.spawnAhead * 0.7]
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
         */
        if (!wide && seg.shoulder < pacing.sideShoulderMin) continue;
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
      if (d < near) continue;
      const hidden = !ctx.world.lineOfSight(ctx.player.x, ctx.player.z, x, z);
      if (!hidden && d < pacing.farSpawnDistance) continue;
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
   */
  enclosure(x: number, z: number): number {
    const run = CONFIG.run;
    const covered = new Array<boolean>(run.enclosureSectors).fill(false);
    const r2 = run.enclosureRadius * run.enclosureRadius;

    for (const u of this.units) {
      if (!u.active || u.destroyed) continue;
      const dx = u.vehicle.x - x;
      const dz = u.vehicle.z - z;
      if (dx * dx + dz * dz > r2) continue;
      let a = Math.atan2(dx, dz) / (Math.PI * 2);
      a -= Math.floor(a);
      covered[Math.min(run.enclosureSectors - 1, Math.floor(a * run.enclosureSectors))] = true;
    }
    return covered.reduce((n, c) => n + (c ? 1 : 0), 0);
  }

  syncViews(dt: number, elapsed: number): void {
    for (const u of this.units) {
      if (!u.active) continue;
      u.syncView(dt, elapsed, this.terrain.heightAt(u.vehicle.x, u.vehicle.z));
    }
  }
}
