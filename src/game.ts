/**
 * Game initialisation and the main loop. This file owns the wiring between systems;
 * the systems themselves know nothing about each other.
 */

import { Renderer } from "./gfx/renderer";

import { GameAudio } from "./audio";
import { ChaseCamera } from "./camera/chaseCamera";
import { CONFIG } from "./config";
import { Input } from "./input";
import { clamp } from "./math";
import { CollisionWorld } from "./physics/collisionWorld";
import { PlayerController } from "./player/playerController";
import type { PursuitContext } from "./police/behaviors";
import { HazardField } from "./police/hazards";
import { PoliceManager } from "./police/policeManager";
import { GameState } from "./state";
import { DailyUi } from "./ui/dailyUi";
import { Hud } from "./ui/hud";
import { CarView, PLAYER_STYLE } from "./vehicle/carView";
import { Vehicle } from "./vehicle/vehicle";
import { RocketSystem } from "./weapons/rocket";
import type { BuiltWorld } from "./world/courseBuilder";
import type { TerrainSample } from "./world/terrain";
import {
  COURSE_START,
  START_HEADING,
  activeSectionStarts,
  buildCourseSegments,
  makeCourse,
  sectionIndexAt,
} from "./world/course";
import { seedForDay } from "./daily";
import { Terrain } from "./world/terrain";
import { NavGraph } from "./world/navGraph";
import { WorldStream } from "./world/worldStream";

/**
 * Sections the world opens with.
 *
 * Enough that the opening is instant and the police have road to be dispatched
 * onto, few enough that the first frame is not paying for eight minutes of
 * course nobody may ever see.
 */
const STREAM_OPENING_SECTIONS = 8;
import { PickupSystem } from "./world/pickups";
import { count } from "./telemetry";


export class Game {
  private renderer: Renderer;
  private world: BuiltWorld;
  private collision: CollisionWorld;
  /** Grows the course ahead of the player for as long as the run lasts. */
  private stream: WorldStream;

  private player: Vehicle;
  private playerView: CarView;
  private controller = new PlayerController();

  private police: PoliceManager;
  private hazards: HazardField;
  private pickups: PickupSystem;
  private rockets: RocketSystem;
  private camera: ChaseCamera;
  private hud: Hud;
  private daily: DailyUi | null = null;
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

    /*
     * The world is streamed, not built once.
     *
     * It opens with a handful of sections and grows ahead of the player for as
     * long as they last. The objects below keep their identity for the whole
     * run - the police context and every unit hold them - so the stream
     * rebuilds their contents rather than handing out replacements.
     */
    const opening = makeCourse(seedForDay(), STREAM_OPENING_SECTIONS);
    const openingSegments = buildCourseSegments(opening).segments;
    this.world = {
      segments: openingSegments,
      terrain: new Terrain(openingSegments),
      colliders: [],
      nav: NavGraph.fromCourse(openingSegments),
      blocksWithdrawn: 0,
      update() {},
    };
    this.collision = new CollisionWorld(this.world.colliders);
    this.stream = new WorldStream(
      this.renderer,
      seedForDay(),
      this.world,
      this.collision,
      STREAM_OPENING_SECTIONS,
    );
    this.stream.ensureBuiltThrough(0);

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
    this.hazards = new HazardField(this.renderer, this.world.terrain, this.collision);
    this.pickups = new PickupSystem(this.renderer, this.world.terrain);
    this.rockets = new RocketSystem(this.renderer);
    this.camera = new ChaseCamera(this.renderer, this.collision, this.world.terrain);
    this.camera.reset(this.player);
    // Bake the static world into one draw call now that everything is placed.
    // Scenery is already baked into position chunks by the world builder;
    // this catches anything static created outside it.
    this.renderer.bake("late");

    /*
     * Optional chrome, constructed defensively. `DailyUi` looks up a dozen elements and
     * throws if any is missing; as a field initializer that failure killed the whole Game
     * constructor, so a broken leaderboard meant a black screen instead of a playable game
     * with no leaderboard.
     */
    try {
      this.daily = new DailyUi();
    } catch (err) {
      console.warn("Leaderboard UI unavailable:", err);
    }

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

    this.keys.onRestart = () => {
      if (!this.daily?.boardOpen) this.restart();
    };
    this.keys.onDrive = () => {
      if (!this.daily?.boardOpen) this.begin();
    };
    // Clicking anywhere on the canvas also starts the run and takes keyboard focus.
    canvas.addEventListener("pointerdown", () => {
      canvas.focus();
      this.begin();
    });

    /*
     * The intro card. Wired here rather than in the shareable build's own script, because
     * the card now lives in index.html and both builds need the button to work — the card
     * covers the canvas, so its click never reaches the handler above.
     */
    const start = () => {
      this.audio.init();
      this.audio.resume();
      canvas.focus();
      this.begin();
    };
    document.getElementById("startGo")?.addEventListener("click", start);

    /*
     * Mute.
     *
     * Reflected into `aria-pressed` rather than only the icon, so the state is
     * available to a screen reader and to a player who cannot tell the two
     * glyphs apart. `stopPropagation` because the canvas below starts a run on
     * any pointer press - silencing the game should not also launch it.
     */
    /*
     * Mark the scrolling panels only while they actually scroll.
     *
     * The fade at their bottom edge is a hint that there is more below; on a
     * panel that fits, it is just the last line of text going dim. Re-checked
     * on resize because whether it fits depends entirely on the window.
     */
    const scrollHints = ["startScroll", "overlayScroll"];
    const markScrollable = (): void => {
      for (const id of scrollHints) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        panel.classList.toggle("scrolls", panel.scrollHeight > panel.clientHeight + 1);
      }
    };
    markScrollable();
    window.addEventListener("resize", markScrollable);
    // The result card is populated after a run, which changes its height.
    window.setInterval(markScrollable, 1000);

    const muteBtn = document.getElementById("muteBtn");
    const paintMute = (): void => {
      const muted = this.audio.isMuted;
      muteBtn?.setAttribute("aria-pressed", muted ? "true" : "false");
      muteBtn?.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
      const icon = document.getElementById("muteIcon");
      if (icon) icon.textContent = muted ? "\u266A" : "\u266B";
    };
    paintMute();
    muteBtn?.addEventListener("pointerdown", (e) => e.stopPropagation());
    muteBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.audio.setMuted(!this.audio.isMuted);
      paintMute();
    });
    /*
     * Clicking the backdrop starts the run — but only the backdrop.
     *
     * Without the target check this listener also fired for every click *inside* the card,
     * because the event bubbles: the leaderboard button opened the board and then the run
     * began underneath it and hid the card, so the button looked like it did nothing but
     * start the game.
     */
    const hint = document.getElementById("focusHint");
    hint?.addEventListener("pointerdown", (e) => {
      if (e.target === hint) start();
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
  /**
   * Debug-only teleport to the start of a section. Active police are stood down and
   * the director repopulates around the new position within a couple of seconds.
   */
  jumpToSection(sectionIdx: number): void {
    const starts = activeSectionStarts();
    const idx = Math.max(0, Math.min(starts.length - 1, sectionIdx));
    const start = starts[idx];
    const node = this.world.nav.nodeAtProgress(start + 25);
    const next = this.world.nav.nodeAtProgress(start + 65);
    this.player.x = node.x;
    this.player.z = node.z;
    this.player.y = node.y;
    this.player.heading = Math.atan2(next.x - node.x, next.z - node.z);
    this.player.vx = 0;
    this.player.vz = 0;
    this.player.vy = 0;
    for (const u of this.police.units) {
      if (u.active) u.deactivate();
    }
    this.lastOnCourse = { x: node.x, z: node.z, y: node.y, heading: this.player.heading };
    this.offCourseTimer = 0;
    /*
     * Sync the tracked state IMMEDIATELY. The police director reads
     * state.section, which otherwise still says 0 for the first tick after a
     * jump - long enough for it to dispatch classes that retired sections ago.
     * A debug-only seam, but it contaminated every jumped measurement run.
     */
    this.state.progress = start + 25;
    this.state.section = idx;
  }

  begin(): void {
    if (!this.started) count("run_started");
    this.started = true;
    this.audio.resumeLoops();
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
    count("restart_used");
    /*
     * Put the world back before the player is. A finished run has released the
     * sections behind it, so the opening no longer exists as geometry - and
     * restarting into it left the player on a black screen with the cars and
     * the HUD drawing over nothing.
     */
    this.stream.restart();
    this.ctx.nav = this.world.nav;
    this.state.reset();
    this.player.reset(COURSE_START.x, COURSE_START.z, START_HEADING, COURSE_START.y);
    this.police.reset(this.world.nav);
    this.hazards.reset();
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
    this.audio.resumeLoops();
    this.audio.resume();
    /*
     * The track runs through the bust and over the BUSTED card, and only stops here —
     * `restart` is the new-run path for both the result button and the Q key, so this is
     * the one place that means "the player has moved on".
     */
    this.audio.stopMusic();
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
    // A boosting car shoves much harder, which is what makes a blocked pass answerable.
    this.player.contactBoost = this.player.boosting ? CONFIG.player.boost.shove : 1;
    this.player.update(input, dt, terrain);

    if (this.player.boostFired) {
      this.camera.addShake(CONFIG.player.boost.shake);
      this.hud.punch(0.1);
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
    // Debug mode is a test rig: never run dry.
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
      // No flash for either. The white pop was designed for one-off moments and the
      // hazards are not that any more; on a slick it fired every time you clipped one and
      // read as the screen glitching rather than as an event.
      if (hazard === "spike") this.hud.punch(0.12);
      this.audio.impact(hazard === "spike" ? 0.9 : 0.4);
      this.hud.announce(hazard === "spike" ? "SPIKE STRIP!" : "OIL SLICK!", false);
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
      /*
       * A rocket-killed hulk is drive-through for the player - the rocket's whole job
       * is opening a lane, and a solid wreck in a bottleneck rebuilt the roadblock it
       * was spent on. Police still collide with it: their pile-up is your open lane.
       */
      if (unit.destroyed) continue;
      /*
       * A welded truck owns its player: the weld drives them INTO the front
       * pocket on purpose, and the separation solver ejecting them back out every
       * frame was the weld losing a fight it should never have been in.
       */
      if (unit.welded) continue;
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
    const pileup = CONFIG.police.shared.pileup;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const copHit = this.collision.resolveCars(active[i].vehicle, active[j].vehicle);
        if (
          copHit &&
          copHit.speed >= pileup.minImpact &&
          Math.hypot(active[i].vehicle.x - this.player.x, active[i].vehicle.z - this.player.z) <
            pileup.nearPlayer
        ) {
          // Crossing lines only: the accordion of a chase train rear-ending
          // itself is business as usual, not a crash.
          const cross = Math.abs(
            Math.atan2(
              Math.sin(active[i].vehicle.heading - active[j].vehicle.heading),
              Math.cos(active[i].vehicle.heading - active[j].vehicle.heading),
            ),
          );
          if (cross >= pileup.minAngle) {
            active[i].spinOut(copHit.speed);
            active[j].spinOut(copHit.speed);
          }
        }
      }
    }
    // A second static pass: a ram can shove a car into a wall within the same frame.
    this.collision.resolveStatic(this.player);
    /*
     * The weld re-seat is the LAST write to the player's position: the player's
     * own drive walks them into the blade, and at the wall the static pass just
     * above shoves them back into the truck - both read as the cars clipping
     * through each other. Re-seating here, wall-aware, ends the argument.
     */
    for (const unit of active) {
      if (unit.welded) unit.reseatWeld(this.player, dt, this.collision);
    }
    for (const unit of active) this.collision.resolveStatic(unit.vehicle);

    if (strongest) {
      const severity = clamp(strongest.speed / this.player.params.maxSpeed, 0, 1);
      const rec = CONFIG.player.recovery;
      if (severity > rec.minSeverity) {
        // Cap how far backwards a ram can leave you sliding, and open the
        // stronger-throttle recovery window - the aftermath, not the hit, is softened.
        const fx = Math.sin(this.player.heading);
        const fz = Math.cos(this.player.heading);
        const vf = this.player.vx * fx + this.player.vz * fz;
        if (vf < -rec.maxBackslide) {
          const excess = vf + rec.maxBackslide;
          this.player.vx -= excess * fx;
          this.player.vz -= excess * fz;
        }
        this.player.recoveryTimer = Math.max(this.player.recoveryTimer, rec.boostTime);
      }
      /*
       * Tell the squad. A hit is the moment the player is slowest and most
       * out of shape, and until now nothing acted on it - which is why taking
       * one did not matter.
       */
      if (strongest.kind === "car") this.police.notePlayerHit();
      this.camera.addShake(strongest.speed * CONFIG.collision.shakePerSpeed);
      // Barely a flicker. Contact is now near-constant by design, and at the old weight
      // the screen sat under a permanent white veil for the whole back half of a run.
      this.hud.punch(severity * 0.05);
      this.audio.impact(severity);
    }

    // --- Containment -------------------------------------------------------
    const ground = terrain.sample(this.player.x, this.player.z);
    this.enforceCourse(dt, progress, ground);

    // --- Run state ---------------------------------------------------------
    // Directions blocked, not cars counted: the arrest is about having nowhere to go.
    const boxedIn = this.police.enclosure(this.player.x, this.player.z, this.collision);
    this.state.update(dt, this.player.speed, boxedIn, progress, ground.onCourse);

    const section = sectionIndexAt(progress);

    /*
     * Keep road in front of the player.
     *
     * Done after the section is known and before anything is dispatched onto
     * it. When it builds, the terrain and collision it rebuilt kept their
     * identity, but the navigation graph is a new object - so the pursuit
     * context, which holds one, is pointed at the new one here. A stale nav is
     * a squad pathing along a road that no longer describes the world.
     */
    if (this.stream.ensureBuiltThrough(section)) {
      this.ctx.nav = this.world.nav;
      // Ammunition has to keep appearing on road that did not exist a moment ago.
      this.pickups.extendTo(this.renderer, this.world.terrain);
    }

    const pace = CONFIG.player.lateSpeed;
    this.player.paceBonus = Math.min(
      pace.max,
      Math.max(0, (section - pace.fromSection) * pace.perSection),
    );
    this.player.paceAccel = 1;
    // Deep-run track. Driven from the furthest section reached rather than the current
    // one, so being shoved back over a boundary cannot switch it off mid-bar.
    this.audio.updateMusic(this.state.section);
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
      // Arm the submit row for this run. Submission is a deliberate button press rather
      // than automatic: a name has to be chosen, and posting without asking would be a
      // surprise the first time.
      this.daily?.showResult({
        score: this.state.score,
        section: this.state.section + 1,
        distance: Math.round(this.state.maxProgress),
        elapsedMs: Math.round(this.state.elapsed * 1000),
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
  private enforceCourse(dt: number, progress: number, ground: TerrainSample): void {
    /*
     * The vertical net. The tow system is 2D: under the floor at valid x/z it
     * reads as happily on course and never fires - which is how a hard slam
     * (late-game closing speeds now exceed 100) left the player under the
     * world, driving on nothing, permanently stuck. Below-the-world or
     * corrupted positions are never legitimate: tow instantly, no grace, no
     * speed exemption.
     */
    const p = this.player;
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.z) ||
      !Number.isFinite(p.y) ||
      p.y < ground.height - 6
    ) {
      const node = this.world.nav.nodeAtProgress(progress);
      const back =
        this.lastOnCourse.x !== 0 || this.lastOnCourse.z !== 0
          ? this.lastOnCourse
          : { x: node.x, z: node.z, y: node.y, heading: p.heading };
      p.reset(back.x, back.z, back.heading, back.y);
      this.camera.reset(p);
      this.offCourseTimer = 0;
      this.hud.announce("TOWED BACK", false);
      return;
    }

    /*
     * DECK-MISMATCH TOW. Off the course AND at the wrong height for this part
     * of the route means the player is stranded behind walls on ground that
     * belongs to some other stretch of road (a slam over a crest barrier puts
     * them there) - the 2D tow never fires because there IS ground underfoot,
     * and the still-driving exemption strands them forever. Wrong deck is
     * never legitimate: tow at once, any speed, any seed.
     */
    if (!ground.onCourse) {
      const routeNode = this.world.nav.nodeAtProgress(progress);
      // Compare against where they LAST legitimately drove - the nearest-road
      // reference is circular (a stranded player's nearest road IS the wrong
      // deck they are standing on, so it always reads as fine).
      const refY =
        this.lastOnCourse.x !== 0 || this.lastOnCourse.z !== 0
          ? this.lastOnCourse.y
          : routeNode.y;
      if (refY - p.y > 2.8) {
        const back =
          this.lastOnCourse.x !== 0 || this.lastOnCourse.z !== 0
            ? this.lastOnCourse
            : { x: routeNode.x, z: routeNode.z, y: routeNode.y, heading: p.heading };
        p.reset(back.x, back.z, back.heading, back.y);
        this.camera.reset(p);
        this.offCourseTimer = 0;
        this.hud.announce("TOWED BACK", false);
        return;
      }
    }

    if (!ground.onCourse) this.pushBackOnCourse(dt, ground);

    if (ground.onCourse) {
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

  /**
   * The invisible wall.
   *
   * Every section is fenced at the outer edge of its run-off, and measured, that geometry
   * turns away 97% of a deliberately adversarial escape sweep — boosting straight at the
   * boundary from every angle at every leg. The remaining few percent are individual gaps
   * where two legs meet at a sharp bend, and hunting each one across twelve thousand wall
   * pieces is a losing game.
   *
   * So the invariant is enforced physically instead: outside the ribbon, whatever velocity
   * is carrying you further out is cancelled and you are pushed back toward the road. It
   * is a firm shove rather than a teleport, so a leak costs you a moment and your line
   * instead of resetting the chase — which is what made the old backstop worth abusing.
   */
  private pushBackOnCourse(dt: number, ground: TerrainSample): void {
    const seg = ground.segment;
    const p = this.player;

    // Closest point on this segment's centre line.
    const rx = p.x - seg.ax;
    const rz = p.z - seg.az;
    const along = clamp(rx * seg.dx + rz * seg.dz, 0, seg.length);
    const cx = seg.ax + seg.dx * along;
    const cz = seg.az + seg.dz * along;

    const dx = cx - p.x;
    const dz = cz - p.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d;
    const nz = dz / d;

    // Cancel anything still carrying the car outward, then push it back in.
    const outward = p.vx * nx + p.vz * nz;
    if (outward < 0) {
      p.vx -= nx * outward;
      p.vz -= nz * outward;
    }
    const shove = CONFIG.run.offCourseShove * dt;
    p.vx += nx * shove;
    p.vz += nz * shove;
  }

  /** How far through the current section the player is, 0..1, for the HUD bar. */
  private sectionFraction(): number {
    const starts = activeSectionStarts();
    const i = this.state.section;
    const from = starts[i] ?? 0;
    const to = starts[i + 1] ?? from + 600;
    return (this.state.progress - from) / Math.max(1, to - from);
  }

  private updateHud(dt: number): void {

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
      },
      dt,
    );

    // Nothing is driving once the run is over, so nothing should be humming either. This
    // used to keep being called every frame, which reset the engine gain to its idle value
    // and left the car droning behind the BUSTED card for as long as the page was open.
    if (this.state.over || !this.started) {
      this.audio.quietLoops();
    } else {
      this.audio.updateLoop(
        dt,
        clamp(this.player.speed / this.player.params.maxSpeed, 0, 1),
        this.player.boosting,
        nearest,
      );
    }
  }
}
