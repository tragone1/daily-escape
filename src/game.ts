/**
 * Game initialisation and the main loop. This file owns the wiring between systems;
 * the systems themselves know nothing about each other.
 */

import { Renderer } from "./gfx/renderer";

import { GameAudio } from "./audio";
import { ChaseCamera } from "./camera/chaseCamera";
import { CONFIG } from "./config";
import { Input } from "./input";
import { clamp, headingOf, wrapAngle } from "./math";
import { CollisionWorld } from "./physics/collisionWorld";
import { PlayerController } from "./player/playerController";
import type { PursuitContext } from "./police/behaviors";
import { HazardField } from "./police/hazards";
import { TetherSystem } from "./police/tether";
import { PoliceManager } from "./police/policeManager";
import { GameState } from "./state";
import { Hud } from "./ui/hud";
import { CarView, PLAYER_STYLE } from "./vehicle/carView";
import { Vehicle } from "./vehicle/vehicle";
import { RocketSystem } from "./weapons/rocket";
import { buildWorld, type BuiltWorld } from "./world/courseBuilder";
import { COURSE_START, SECTION_STARTS, START_HEADING, sectionIndexAt } from "./world/course";
import { PickupSystem } from "./world/pickups";


export class Game {
  private renderer: Renderer;
  private world: BuiltWorld;
  private collision: CollisionWorld;

  private player: Vehicle;
  private playerView: CarView;
  private controller = new PlayerController();

  private police: PoliceManager;
  private hazards: HazardField;
  private tethers: TetherSystem;
  private pickups: PickupSystem;
  private rockets: RocketSystem;
  private camera: ChaseCamera;
  private hud: Hud;
  private state = new GameState();
  private audio = new GameAudio();
  private keys = new Input();

  private elapsed = 0;
  /** Backstop against leaving the course: seconds spent off the drivable ribbon. */
  private offCourseTimer = 0;
  private lastOnCourse = { x: 0, z: 0, y: 0, heading: 0 };
  private ctx: PursuitContext;
  private resultShown = false;
  /**
   * The run does not begin until the player actually drives. Starting the clock on page
   * load meant the timer was already ticking — and the police already closing — before
   * anyone had touched a key, which is wrong in the standalone build and much worse in an
   * embedded one that has to be clicked before it even has keyboard focus.
   */
  private started = false;
  private lastSection = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    // Night palette: cool sky bounce, lifted ground bounce so faces turned away from the
    // sun stay readable, and fog to hide the far end of a very long course.
    this.renderer.clearColor = [0.03, 0.04, 0.07];
    this.renderer.fogColor = [0.04, 0.05, 0.09];
    this.renderer.fogRange = [190, 620];
    this.renderer.sky = [0.62, 0.64, 0.72];
    this.renderer.ground = [0.2, 0.21, 0.28];
    this.renderer.lightDir = [-0.42, -0.84, 0.29];

    this.world = buildWorld(this.renderer);
    this.collision = new CollisionWorld(this.world.colliders);

    const playerParams = CONFIG.player.vehicle;
    this.player = new Vehicle(playerParams, { ...CONFIG.player.boost });
    this.player.reset(COURSE_START.x, COURSE_START.z, START_HEADING, COURSE_START.y);
    this.playerView = new CarView(
      this.renderer,
      PLAYER_STYLE,
      playerParams.halfLength,
      playerParams.halfWidth,
    );

    this.police = new PoliceManager(this.renderer, this.world.nav, this.world.terrain);
    this.hazards = new HazardField(this.renderer, this.world.terrain);
    this.tethers = new TetherSystem(this.renderer);
    this.pickups = new PickupSystem(this.renderer, this.world.terrain);
    this.rockets = new RocketSystem(this.renderer);
    this.camera = new ChaseCamera(this.renderer, this.collision, this.world.terrain);
    this.camera.reset(this.player);
    // Bake the static world into one draw call now that everything is placed.
    this.renderer.bake();

    this.hud = new Hud(() => {
      this.audio.init();
      this.restart();
    });
    this.ctx = this.police.buildContext({
      player: this.player,
      nav: this.world.nav,
      world: this.collision,
      terrain: this.world.terrain,
    });

    this.keys.onRestart = () => this.restart();
    this.keys.onDrive = () => this.begin();
    // Clicking anywhere on the canvas also starts the run and takes keyboard focus.
    canvas.addEventListener("pointerdown", () => {
      canvas.focus();
      this.begin();
    });
    this.keys.onResetCamera = () => this.camera.reset(this.player);
    this.keys.onAnyKey = () => {
      this.audio.init();
      this.audio.resume();
    };

    window.addEventListener("resize", () => this.renderer.resize());
  }


  /**
   * Begin the run.
   *
   * Also dismisses the embedded build's start overlay. The overlay has its own click
   * handler, but routing it through here too means the card cannot get stuck on screen
   * while the game underneath is perfectly alive — one fewer thing that has to work.
   */
  begin(): void {
    this.started = true;
    const hint = document.getElementById("focusHint");
    if (hint) hint.classList.add("hidden");
  }

  start(): void {
    const loop = () => {
      this.tick();
      this.renderer.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  restart(): void {
    this.state.reset();
    this.player.reset(COURSE_START.x, COURSE_START.z, START_HEADING, COURSE_START.y);
    this.police.reset(this.world.nav);
    this.hazards.reset();
    this.tethers.reset();
    this.pickups.reset();
    this.rockets.reset();
    this.camera.reset(this.player);
    this.hud.hideResult();
    this.lastSection = -1;
    this.resultShown = false;
    this.elapsed = 0;
    this.offCourseTimer = 0;
    this.lastOnCourse = {
      x: COURSE_START.x,
      z: COURSE_START.z,
      y: COURSE_START.y,
      heading: START_HEADING,
    };
    this.keys.endFrame();
    this.audio.resume();
  }


  private tick(): void {
    // Frame-rate independent, and clamped so a stalled tab cannot teleport anything.
    const dt = Math.min(this.renderer.frameTime() / 1000, CONFIG.maxTimeStep);
    if (dt <= 0) return;

    this.elapsed += dt;
    this.world.update(this.elapsed);

    if (this.started && !this.state.over) {
      this.simulate(dt);
    }

    this.camera.update(this.player, dt);
    this.playerView.sync(
      this.player,
      dt,
      this.elapsed,
      this.controller.braking,
      false,
      this.world.terrain.heightAt(this.player.x, this.player.z),
    );
    this.police.syncViews(dt, this.elapsed);
    this.updateHud(dt);
    this.keys.endFrame();
  }

  private simulate(dt: number): void {
    const terrain = this.world.terrain;

    // --- Player ------------------------------------------------------------
    const input = this.controller.read(this.keys);
    this.player.update(input, dt, terrain);

    if (this.player.boostFired) {
      this.camera.addShake(CONFIG.player.boost.shake);
      this.hud.punch(0.18);
      this.audio.boost();
    }
    if (this.player.justLaunched) {
      this.camera.addShake(0.3);
      this.audio.boost();
    }
    if (this.player.justLanded && this.player.landingImpact > CONFIG.terrain.landing.minImpactVy) {
      const t = CONFIG.terrain.landing;
      this.camera.addShake(this.player.landingImpact * t.shakePerVy);
      this.hud.punch(clamp(this.player.landingImpact * 0.006, 0, 0.25));
      this.audio.impact(clamp(this.player.landingImpact / 30, 0, 1));
    }

    // --- Rocket ------------------------------------------------------------
    if (this.controller.firePressed(this.keys) && this.rockets.fire(this.player)) {
      this.camera.addShake(0.35);
      this.audio.rocketLaunch();
    }
    const blast = this.rockets.update(dt, this.collision, this.police.units, this.player, terrain);
    if (blast) {
      this.camera.addShake(CONFIG.player.rocket.shake);
      this.hud.punch(0.6);
      this.audio.explosion();
      this.hud.announce(
        blast.destroyed > 0
          ? `${blast.destroyed} UNIT${blast.destroyed > 1 ? "S" : ""} DESTROYED`
          : blast.thrown > 0
            ? "GLANCING BLOW"
            : "MISSED",
        blast.destroyed > 0,
      );
    }

    // --- Pickups -----------------------------------------------------------
    for (const _got of this.pickups.update(dt, this.elapsed, this.player)) {
      this.rockets.ammo = Math.min(CONFIG.pickups.rocketMax, this.rockets.ammo + 1);
      this.hud.announce("ROCKET ACQUIRED", true);
      this.hud.punch(0.12);
      this.audio.pickup();
    }

    // --- Police ------------------------------------------------------------
    const progress = terrain.progressAt(this.player.x, this.player.z);
    this.ctx = this.police.buildContext(this.ctx);
    this.police.update(dt, this.ctx, progress, this.state.section);

    // --- Police deployables -------------------------------------------------
    const hazard = this.hazards.update(
      dt,
      this.player,
      progress,
      this.state.section,
      this.police.units,
    );
    if (hazard) {
      this.camera.addShake(hazard === "spike" ? 0.7 : 0.3);
      this.hud.punch(hazard === "spike" ? 0.3 : 0.15);
      this.audio.impact(hazard === "spike" ? 0.9 : 0.4);
      this.hud.announce(hazard === "spike" ? "SPIKE STRIP!" : "OIL SLICK!", false);
    }

    const tether = this.tethers.update(dt, this.player, this.police.units);
    if (tether === "fired") {
      this.camera.addShake(0.5);
      this.hud.punch(0.22);
      this.audio.impact(0.6);
      this.hud.announce("TETHERED - BOOST TO BREAK", false);
    } else if (tether === "snapped") {
      this.camera.addShake(0.3);
      this.audio.impact(0.4);
      this.hud.announce("LINE SNAPPED", true);
    }

    // --- Collisions --------------------------------------------------------
    const playerHit = this.collision.resolveStatic(this.player);
    for (const unit of this.police.units) {
      if (unit.active) this.collision.resolveStatic(unit.vehicle);
    }

    let strongest = playerHit;
    const active = this.police.units.filter((u) => u.active);
    // Pile-ups resolve pair by pair, and each pair scrubs a share of whatever speed is
    // left. Left uncapped that compounds to a dead stop the moment three or four units
    // arrive together, so the total loss across the frame is clamped below.
    const speedBefore = this.player.speed;
    for (const unit of active) {
      const hit = this.collision.resolveCars(this.player, unit.vehicle);
      if (hit && (!strongest || hit.speed > strongest.speed)) strongest = hit;
    }
    const floor = speedBefore * (1 - CONFIG.collision.maxCarSpeedLossPerFrame);
    const speedAfter = this.player.speed;
    if (speedAfter < floor && speedAfter > 0.01) {
      const k = floor / speedAfter;
      this.player.vx *= k;
      this.player.vz *= k;
    }
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        this.collision.resolveCars(active[i].vehicle, active[j].vehicle);
      }
    }
    // A second static pass: a ram can shove a car into a wall within the same frame.
    this.collision.resolveStatic(this.player);
    for (const unit of active) this.collision.resolveStatic(unit.vehicle);

    if (strongest) {
      const severity = clamp(strongest.speed / this.player.params.maxSpeed, 0, 1);
      this.camera.addShake(strongest.speed * CONFIG.collision.shakePerSpeed);
      this.hud.punch(severity * 0.22);
      this.audio.impact(severity);
    }

    // --- Containment -------------------------------------------------------
    const onCourse = terrain.sample(this.player.x, this.player.z).onCourse;
    this.enforceCourse(dt, progress, onCourse);

    // --- Run state ---------------------------------------------------------
    const nearForCapture = this.police.countNear(
      this.player.x,
      this.player.z,
      CONFIG.run.captureRadius,
    );
    this.state.update(dt, this.player.speed, nearForCapture, progress, onCourse);

    const section = sectionIndexAt(progress);
    if (section !== this.lastSection && !this.state.over) {
      this.lastSection = section;
      this.hud.announceSection(`SECTION ${section + 1}`);
    }

    if (this.state.over && !this.resultShown) {
      this.resultShown = true;
      this.audio.quietLoops();
      this.audio.failure();
      this.camera.addShake(0.9);
      this.hud.showResult({
        score: this.state.score,
        best: this.state.best,
        isNewBest: this.state.isNewBest,
        section: this.state.section + 1,
        distance: Math.round(this.state.maxProgress),
        elapsed: this.state.elapsed,
      });
    }
  }

  /**
   * Last-resort recovery for a player stranded outside the course.
   *
   * This used to be the containment mechanism, on a 1.6 s fuse, and it was the loophole:
   * dip into the black, get teleported back a moment later, and every pursuer you had was
   * now somewhere else. Containment is the wasteland's own doing now — out there you
   * crawl and you bank no progress — so this only exists for the case where geometry has
   * genuinely put someone somewhere they cannot drive out of, and it waits long enough
   * that it can never be the faster option.
   */
  private enforceCourse(dt: number, progress: number, onCourse: boolean): void {
    if (onCourse) {
      this.offCourseTimer = 0;
      // Remember a known-good spot, but only when actually driving, so the recovery
      // point is never a wall the player was scraping.
      if (this.player.speed > 6) {
        this.lastOnCourse = {
          x: this.player.x,
          z: this.player.z,
          y: this.player.y,
          heading: this.player.heading,
        };
      }
      return;
    }

    this.offCourseTimer += dt;
    // Only rescue someone who is genuinely stuck out there. A player still driving is
    // paying the wasteland's price and can find their own way back.
    if (this.offCourseTimer < CONFIG.run.offCourseGrace) return;
    if (this.player.speed > 4) return;

    // Prefer the remembered spot; fall back to the nearest route node.
    const node = this.world.nav.nodeAtProgress(progress);
    const back = this.lastOnCourse.x !== 0 || this.lastOnCourse.z !== 0
      ? this.lastOnCourse
      : { x: node.x, z: node.z, y: node.y, heading: this.player.heading };

    this.player.reset(back.x, back.z, back.heading, back.y);
    this.camera.reset(this.player);
    this.offCourseTimer = 0;
    this.hud.announce("TOWED BACK", false);
  }

  /** How far through the current section the player is, 0..1, for the HUD bar. */
  private sectionFraction(): number {
    const starts = SECTION_STARTS;
    const i = this.state.section;
    const from = starts[i] ?? 0;
    const to = starts[i + 1] ?? from + 600;
    return (this.state.progress - from) / Math.max(1, to - from);
  }

  private updateHud(dt: number): void {
    // The compass points up the course rather than at a gate: the next route node a good
    // way ahead of the player, which is "onward" in a game that has no destination.
    const ahead = this.world.nav.nodeAtProgress(this.state.progress + 120);
    const bearing = wrapAngle(
      headingOf(ahead.x - this.player.x, ahead.z - this.player.z) - this.player.heading,
    );

    let nearest = Infinity;
    for (const unit of this.police.units) {
      if (!unit.active || unit.destroyed) continue;
      nearest = Math.min(nearest, unit.distanceToPlayer(this.player));
    }

    this.hud.update(
      {
        elapsed: this.state.elapsed,
        speed: this.player.speed,
        boostCharge: this.player.boostCharge,
        boosting: this.player.boosting,
        policeNear: this.police.countNear(this.player.x, this.player.z, CONFIG.run.heatRadius),
        captureProgress: this.state.captureProgress,
        escapeBearing: bearing,
        rocketAmmo: this.rockets.ammo,
        rocketInFlight: this.rockets.inFlight,
        score: this.state.score,
        best: this.state.best,
        section: this.state.section + 1,
        sectionProgress: clamp(this.sectionFraction(), 0, 1),
        surface: this.player.surface,
        airborne: this.player.airborne,
        tireWarning: this.hazards.warning,
        offCourse: this.player.offCourse,
        tethered: this.tethers.attached,
      },
      dt,
    );

    this.audio.updateLoop(
      dt,
      clamp(this.player.speed / this.player.params.maxSpeed, 0, 1),
      this.player.boosting,
      this.state.over ? 999 : nearest,
    );
  }
}
