import { PLAYER_VEHICLE } from "./vehicleTypes";
import type { SurfaceParams } from "./vehicleTypes";

/**
 * The car, and the ground it drives on.
 *
 * These two live together because they are read together: every surface
 * multiplier here only means anything against the vehicle numbers beside it.
 */

export const VEHICLES_CONFIG = {
  /**
   * Terrain and elevation. Kept to a handful of multipliers on purpose — the player
   * should always be able to see why the car is slowing, sliding or picking up speed.
   */
  terrain: {
    /** Downward acceleration while airborne, u/s^2. */
    gravity: 64,
    /**
     * How hard slopes push back. Forward speed changes by `slopeAccel * grade` per
     * second, so on the course's steepest climb (grade 0.3) you bleed ~12 u/s^2 —
     * enough that boost is the difference between cresting and crawling.
     */
    slopeAccel: 40,
    /** Steering authority retained mid-air: enough to straighten up, not to steer. */
    airSteerFactor: 0.34,
    /**
     * How far boost pulls terrain penalties back toward asphalt (0 = none, 1 = fully).
     * At 1.0 you are completely impervious while it burns: boosted speed through the bog
     * equals normal speed on tarmac. That is the whole design of the mud shortcut — cold
     * it is slower than going round, boosted it is clearly faster.
     */
    boostTerrainBypass: 1.0,
    /** How much of a climb's speed penalty boost cancels while it burns. */
    boostSlopeAssist: 0.65,
    /**
     * How fast speed above the engine's ceiling bleeds off, per second.
     *
     * The ceiling used to be a hard clamp applied every frame, which quietly deleted
     * every external impulse pointed along the car: a rocket blast could throw a wreck
     * sideways but not backwards, because the backwards component was clipped the same
     * frame it landed. Easing instead lets a blast actually throw something.
     */
    overspeedDecay: 1.1,
    /**
     * Decay used instead when the tyres are shredded.
     *
     * Much faster, and this is the whole reason the spike strip did not feel like a
     * punishment. The strip cuts top speed to a quarter, but the *gentle* overspeed decay
     * meant a car at 44 took two and a half seconds just to get down to the new ceiling —
     * so most of a six-second effect was spent coasting at a speed the strip was supposed
     * to have taken away. Shredded tyres should scrub, not glide.
     */
    damagedOverspeedDecay: 7,

    /**
     * The wasteland past the barriers.
     *
     * There should be no way to get here at all any more: every section is walled at the
     * outer edge of its run-off, so the answer to "can I drive out of bounds" is now
     * geometry rather than economics. This survives as the backstop for a leak — a gap at
     * some junction in twelve thousand wall pieces — and is deliberately milder than it
     * was, because at a third of normal speed a leak was effectively a death sentence
     * rather than a mistake. Progress still does not count out here.
     *
     * These are applied *after* the boost bypass, so a charge cannot paper over them the
     * way it does mud. Boost is the answer to terrain; it is not a licence to leave.
     *
     * They apply to the player alone. Slowing the police out there too made the wasteland
     * a stalemate rather than a mistake — everyone crawled, so nothing was actually lost
     * by going. Police at full pace against a player at a third of it is what makes the
     * black genuinely somewhere you do not want to be.
     */
    offCourse: {
      maxSpeed: 0.62,
      accel: 0.6,
      grip: 0.7,
      drag: 1.8,
    },

    /** Below this forward speed a ramp does not launch you at all. */
    minLaunchSpeed: 16,
    /** Ceiling on launch speed so the big kicker cannot fling you off the map. */
    maxLaunchSpeed: 54,
    /**
     * Multiplier on launch speed when you hit the lip boosting.
     *
     * The ramps existed and did very little: a modest hop, over before you had registered
     * it. Boosting into one is now a decision with a visible payoff — a long, slow arc
     * that clears a chunk of road and everything the squad had arranged on it.
     */
    boostLaunchBonus: 1.75,

    landing: {
      /** Fraction of horizontal speed lost per unit of vertical impact speed. */
      speedLossPerVy: 0.011,
      /** Hard cap, so even a huge drop never stops the car dead. */
      maxSpeedLoss: 0.32,
      /** Camera shake per unit of vertical impact speed. */
      shakePerVy: 0.045,
      /** Below this impact speed a landing is silent and shake-free. */
      minImpactVy: 6,
    },

    surfaces: {
      asphalt: { grip: 1.0, drag: 1.0, maxSpeed: 1.0, accel: 1.0 },
      dirt: { grip: 0.74, drag: 1.2, maxSpeed: 0.93, accel: 0.9 },
      gravel: { grip: 0.58, drag: 1.25, maxSpeed: 0.9, accel: 0.88 },
      // Only ever on the optional bog shortcut, so it can afford to be brutal.
      mud: { grip: 0.9, drag: 3.0, maxSpeed: 0.55, accel: 0.5 },
      // Run-off, not a punishment: noticeably looser and a bit slower, nothing more.
      grass: { grip: 0.84, drag: 1.3, maxSpeed: 0.88, accel: 0.85 },
    } as Record<string, SurfaceParams>,
  },
  player: {
    vehicle: PLAYER_VEHICLE,
    /**
     * Head-on aftermath. The hit itself stays hard - that is the nimble-or-pay
     * pressure - but the tail is shortened: a ram cannot leave the player sliding
     * backwards faster than `maxBackslide`, and for `boostTime` seconds after a hard
     * hit the throttle pulls `accelBoost` times harder. The mistake still costs;
     * it stops costing five seconds of helplessness.
     */
    recovery: {
      maxBackslide: 8,
      boostTime: 1.3,
      accelBoost: 1.7,
      minSeverity: 0.25,
    },
    /**
     * Late-run pace. From `fromSection` (0-indexed; 9 = the tenth section) the
     * player's top speed climbs per section, capped. The police do NOT mirror
     * this ramp (an old version did) - their climb is the escalation bonus in
     * police.escalation, which from the tenth section is deliberately steeper
     * than this one: the late game is supposed to get away from you.
     */
    /**
     * Late-run pace ramp. The hard doubling at section ten was tried and rolled back
     * by playtest - a gentle climb, capped, felt right.
     */
    lateSpeed: {
      fromSection: 9,
      perSection: 0.6,
      /**
       * Capped where the POLICE speed bonus caps (+30 lands mid round 22):
       * the player's ramp stops rising the same round theirs does, per
       * design - after that the only thing still climbing is the arrest
       * clock. Retune this if the escalation slopes move.
       */
      max: 7.2,
    },
    boost: {
      /** Extra acceleration while boosting, u/s^2. */
      accel: 34,
      /** Temporary increase to max speed while boosting, u/s. */
      maxSpeedBonus: 15,
      /**
       * How much of a tyre-damage speed penalty the boost claws back, 0..1.
       *
       * Not all of it - the strip has to keep costing you - but enough that spending the
       * charge on getting out from under one is a real option. At zero, boosting on
       * shredded tyres produced almost nothing, so the answer to the worst situation in
       * the game was to sit and wait for it to pass.
       */
      damageBypass: 0.55,
      /** How long a single boost lasts, seconds. */
      duration: 1.6,
      /**
       * Cooldown from the moment the boost ends. Long on purpose: with no refills, a
       * ~9s round trip means roughly nine uses across the course, so each one is a
       * choice about which climb, bog or box-in is worth spending it on.
       */
      cooldown: 7.5,
      /** Camera kick when boost fires. */
      shake: 0.55,
      /**
       * How much harder the car shoves other vehicles while the charge burns.
       *
       * Boost is the answer to terrain and to a blocked road alike: a rig parked across a
       * narrow pass should be a wall at cruising speed and something you can barge a gap
       * in if you spend the charge on it. Being completely stopped by geometry you cannot
       * answer is the one kind of loss with no play in it.
       */
      shove: 5.0,
    },
    /** Body-lean visuals (radians at full effect). */
    lean: {
      roll: 0.16,
      pitch: 0.055,
      response: 7,
    },

    /**
     * One rocket per run. It is deliberately powerful — the decision is *when* to spend
     * it, not whether it will work. A direct blast should clear a roadblock outright.
     */
    rocket: {
      /** Rockets carried at the start of a run. */
      ammo: 1,
      /** Muzzle speed, u/s. Inherits the car's velocity on top of this. */
      speed: 96,
      /**
       * Homing. The rocket is a one-or-two-per-run superpower, so missing because a
       * target twitched is a bad failure — it locks the most on-target live unit inside
       * the cone and steers onto it. It still has to be pointed roughly the right way.
       */
      homingRange: 150,
      /** Half-angle of the acquisition cone, radians. */
      homingCone: 0.95,
      /** Turn rate toward the locked target, rad/s. */
      homingTurnRate: 3.6,
      /** Physical size — big enough that a near miss still connects. */
      halfLength: 2.0,
      halfWidth: 0.9,
      /** Ride height above the ground, so it tracks hills instead of flying through them. */
      cruiseHeight: 1.7,
      /** Self-destructs after this far, so a miss is a real cost. */
      maxRange: 165,
      /**
       * Inside this radius a police car is wrecked outright and out of the run for good.
       * Between here and `blastRadius` it is thrown and left driverless for a few seconds.
       * The gap between the two is what rewards aiming into the middle of a group.
       */
      killRadius: 14,
      /** Everything within this radius of the blast is thrown. */
      blastRadius: 24,
      /**
       * Peak impulse at the centre of the blast, u/s. Divided by vehicle mass.
       *
       * Large, and it needs to be: a wreck left sitting where it died is a wall you then
       * have to drive around, which turned firing the rocket into building your own
       * roadblock. Cars should leave the blast, not slump in it.
       */
      blastImpulse: 130,
      /** Spin imparted to caught vehicles, rad/s. */
      blastSpin: 7.0,
      /**
       * How fast a hulk scrubs off blast speed, and the speed below which it stops doing
       * so.
       *
       * A wreck has no driver and no brakes, so a big impulse used to carry it most of a
       * section — dramatic for half a second and then just a car sliding into the
       * distance. Damping only the blast-speed part gives the launch its punch back and
       * lands the thing near where it died, while leaving a hulk that the player is
       * nudging out of the way completely alone.
       */
      wreckDrag: 2.5,
      wreckCoastSpeed: 6,
      /**
       * How easily a burnt-out hulk can be shoved aside afterwards (lower = easier).
       *
       * Very low: there should be enough resistance to feel the weight of the thing, and
       * not enough for your own kill to become the roadblock it replaced.
       */
      /**
       * Effective mass of a burnt-out hulk, in absolute terms rather than as a multiplier.
       *
       * A multiplier does not work here: the rig masses eight, so even at a tenth it was
       * still heavier than the player's car, and a destroyed rig across a narrow pass was
       * as final as a live one. Killing something should always leave you better off than
       * not killing it.
       */
      wreckMass: 0.22,
      /** Seconds a surviving police car is left spinning and driverless. */
      policeDisableTime: 4.2,
      /**
       * Fraction of the blast the player takes.
       *
       * Zero. Your own rocket knocking you backwards is a self-inflicted wound in a game
       * about not losing momentum, and it is the one part of the explosion that punished
       * you for using it well. The camera shake sells the concussion instead.
       */
      selfImpulseScale: 0,
      /** Camera shake on detonation. */
      shake: 1.4,
      /** Lifetime of the core flash / fireball / shockwave, seconds. */
      flashTime: 0.16,
      /** Short: the fireball sits right where you are driving, so it has to clear fast. */
      fireballTime: 0.45,
      shockwaveTime: 0.5,
      /**
       * Visual sizes as a fraction of `blastRadius`. Deliberately decoupled: driving the
       * fireball off the gameplay radius made a 21-unit ball that swallowed the camera and
       * read as grey haze rather than an explosion. The ball wants to be clearly smaller
       * than its own blast; the thin ground ring can be wider than it.
       */
      fireballScale: 0.5,
      coreScale: 0.22,
      shockwaveScale: 1.5,
      /** Debris and smoke lifetimes, seconds. */
      sparkTime: 0.9,
      smokeTime: 1.4,
      /**
       * Peak intensity of the detonation light. Kept modest: at 6 with a long range it
       * flooded the whole street white and washed out the explosion it was meant to sell.
       */
      lightIntensity: 1.3,
    },
  },
} as const;
