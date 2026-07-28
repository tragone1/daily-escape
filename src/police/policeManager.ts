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
import { headingOf } from "../math";
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
      if (playerProgress - unitProgress > pacing.retireBehind) {
        this.spawnUnit(unit, ctx, playerProgress);
      }
    }

    let active = this.activeCount;
    // Wake at most a couple per tick so a section change ramps in rather than pops.
    let budget = 2;
    while (active < target && budget > 0) {
      const unit = this.pickDormant(section);
      if (!unit) break;
      if (!this.spawnUnit(unit, ctx, playerProgress)) break;
      active++;
      budget--;
    }

    this.applySectionSpeed(section);
  }

  /** Weighted pick over dormant units whose class has unlocked for this section. */
  private pickDormant(section: number): PoliceCar | null {
    const esc = CONFIG.police.escalation;
    let total = 0;
    const candidates: Array<{ unit: PoliceCar; weight: number }> = [];
    for (const unit of this.units) {
      if (unit.active || unit.destroyed) continue;
      if (section < (esc.unlock[unit.role] ?? 0)) continue;
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

      // Facing the mouth, so it comes out forwards rather than reversing into the road.
      unit.placeAt(x, z, headingOf(spur.ax - x, spur.az - z), spur.ay);
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
    const offsets =
      mode === "behind"
        ? [-pacing.spawnBehind, -pacing.spawnBehind * 1.5, -pacing.spawnBehind * 0.7]
        : mode === "ahead"
          ? [pacing.spawnAhead, pacing.spawnAhead * 1.4, pacing.spawnAhead * 0.7]
          : [pacing.spawnAhead * 0.7, -pacing.spawnBehind * 0.6, pacing.spawnAhead * 1.1];

    for (const offset of offsets) {
      const node = ctx.nav.nodeAtProgress(playerProgress + offset);
      let x = node.x;
      let z = node.z;

      if (mode === "side") {
        const seg = this.terrain.sample(node.x, node.z).segment;
        if (seg.shoulder < pacing.sideShoulderMin) continue;
        // Right-hand perpendicular of the segment direction, either side.
        const side = Math.random() < 0.5 ? 1 : -1;
        const lateral = seg.halfWidth + seg.shoulder * 0.65;
        x = node.x + seg.dz * lateral * side;
        z = node.z - seg.dx * lateral * side;
        if (!this.terrain.sample(x, z).onCourse) continue;
      }

      const d = Math.hypot(x - ctx.player.x, z - ctx.player.z);
      if (d < pacing.minSpawnDistance) continue;
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
   * The opening wave: cars already on you when the lights go green. Placed directly
   * rather than through the spawn rules, because at the start line the player has made
   * no progress and there is nowhere "behind" for the director to use.
   */
  private spawnOpeningWave(nav: NavGraph): void {
    const wave = CONFIG.police.pacing.openingWave;
    let placed = 0;
    for (const unit of this.units) {
      if (placed >= wave.length) break;
      if (unit.role !== "patrol") continue;
      const node = nav.nodeAtProgress(wave[placed]);
      unit.placeAt(node.x, node.z, node.progress < 0 ? 0 : 0, node.y);
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

  syncViews(dt: number, elapsed: number): void {
    for (const u of this.units) {
      if (!u.active) continue;
      u.syncView(dt, elapsed, this.terrain.heightAt(u.vehicle.x, u.vehicle.z));
    }
  }
}
