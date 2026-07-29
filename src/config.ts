/**
 * Central tuning file for Daily Escape.
 *
 * Every number that affects how the game *feels* lives here so the prototype can be
 * tuned without touching systems code. World units are roughly metres; speeds are
 * units/second (the HUD multiplies by `speedToKmh` purely for display flavour).
 */

export type PoliceRole =
  | "patrol"
  | "interceptor"
  | "rammer"
  | "blocker"
  | "heavy"
  | "elite"
  | "juggernaut"
  | "warden";

/** Terrain surface tuning. Every value is a plain multiplier so effects stay readable. */
export interface SurfaceParams {
  /** Lateral grip multiplier. Lower = slides more. */
  grip: number;
  /** Rolling + coast-down drag multiplier. Higher = bogs down. */
  drag: number;
  /** Top-speed multiplier. */
  maxSpeed: number;
  /** Acceleration multiplier. */
  accel: number;
}

export interface VehicleParams {
  /** Forward acceleration, u/s^2. */
  accel: number;
  /** Hard cap on forward speed, u/s. */
  maxSpeed: number;
  /** Acceleration when reversing, u/s^2. */
  reverseAccel: number;
  /** Hard cap on reverse speed, u/s. */
  maxReverseSpeed: number;
  /** Deceleration when braking while moving forward, u/s^2. */
  brakeDecel: number;
  /** Exponential coast-down applied to forward speed each second. */
  engineDrag: number;
  /** Constant deceleration always applied, gives the car a sense of weight. */
  rollingResistance: number;
  /** Peak yaw rate in rad/s once the car is up to `steerSpeedRef`. */
  steerRateMax: number;
  /** Speed at which steering authority is ~63% of max. Lower = twitchier at low speed. */
  steerSpeedRef: number;
  /** Fraction of steering authority retained at top speed (stability at speed). */
  steerHighSpeedRetain: number;
  /** How fast the steering input eases toward the key state, 1/s. */
  steerInputResponse: number;
  /** Lateral velocity damping per second while gripping. Higher = more planted. */
  gripNormal: number;
  /** Lateral velocity damping per second while drifting. Lower = looser rear end. */
  gripDrift: number;
  /** |steer| above this (plus speed) starts a drift. */
  driftSteerThreshold: number;
  /** Speed above which hard steering induces a drift. */
  driftSpeedThreshold: number;
  /** Half-length and half-width of the collision box. */
  halfLength: number;
  halfWidth: number;
  /** Collision mass — heavier cars push lighter ones. */
  mass: number;
}

const PLAYER_VEHICLE: VehicleParams = {
  accel: 36,
  maxSpeed: 46,
  // Reversing is how you get out of a pile-up, and a pile-up is the situation the whole
  // game is built around. Too slow to back out of one is too slow to play.
  reverseAccel: 34,
  maxReverseSpeed: 26,
  brakeDecel: 58,
  engineDrag: 0.3,
  rollingResistance: 2.2,
  steerRateMax: 2.75,
  steerSpeedRef: 11,
  steerHighSpeedRetain: 0.55,
  steerInputResponse: 9,
  gripNormal: 9.5,
  gripDrift: 5.0,
  driftSteerThreshold: 0.62,
  driftSpeedThreshold: 24,
  halfLength: 2.2,
  halfWidth: 1.05,
  mass: 1.0,
};

/**
 * Police share the player's handling model with per-role differences.
 *
 * Note the top speeds below sit at or above the player's 46. That is deliberate: if you
 * can hold a straight line and simply out-drag them the chase has no teeth. Your edge is
 * cornering, route knowledge and the boost — not raw pace.
 */
function policeVehicle(overrides: Partial<VehicleParams>): VehicleParams {
  return {
    ...PLAYER_VEHICLE,
    accel: 36,
    maxSpeed: 46.5,
    steerRateMax: 2.55,
    gripNormal: 8.4,
    gripDrift: 4.2,
    // Heavier than the player so rams shove you around, not the other way.
    mass: 1.5,
    ...overrides,
  };
}

export const CONFIG = {
  /** Display-only conversion so the speedometer reads like a car. */
  speedToKmh: 4.2,

  /** Longest simulated step; protects the sim if the tab stalls. */
  maxTimeStep: 1 / 20,

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
     * The wasteland past the barriers.
     *
     * Leaving the course used to be free: you drove into the black, the backstop put you
     * back on the road a second later, and you had shed everyone chasing you. Now it is
     * simply a bad place to be — you crawl, you steer badly, and (see `GameState`) you
     * bank no progress at all while you are out there. Nothing to gain, a chase to lose.
     *
     * These are applied *after* the boost bypass, so a charge cannot paper over them the
     * way it does mud. Boost is the answer to terrain; it is not a licence to leave.
     */
    offCourse: {
      maxSpeed: 0.32,
      accel: 0.3,
      grip: 0.55,
      drag: 2.6,
    },

    /** Below this forward speed a ramp does not launch you at all. */
    minLaunchSpeed: 17,
    /** Ceiling on launch speed so the big kicker cannot fling you off the map. */
    maxLaunchSpeed: 30,

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
    boost: {
      /** Extra acceleration while boosting, u/s^2. */
      accel: 34,
      /** Temporary increase to max speed while boosting, u/s. */
      maxSpeedBonus: 15,
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
      blastImpulse: 265,
      /** Spin imparted to caught vehicles, rad/s. */
      blastSpin: 7.0,
      /** How easily a burnt-out hulk can be shoved aside afterwards (lower = easier). */
      wreckPushResistance: 0.3,
      /** Seconds a surviving police car is left spinning and driverless. */
      policeDisableTime: 4.2,
      /**
       * The warden is only wrecked by a near-direct hit; anything less just staggers it.
       * Killing the keeper with your one rocket should feel like a deliberate play.
       */
      wardenKillRadius: 6,
      wardenDisableTime: 1.6,
      /** Fraction of the blast the player takes — enough to feel, not to end a run. */
      selfImpulseScale: 0.28,
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

  police: {
    /** Shared driving/AI values for every police car. */
    shared: {
      /** How often each unit re-plans its route through the street graph, seconds. */
      replanInterval: 0.45,
      /** Distance at which a waypoint counts as reached, units. */
      waypointRadius: 11,
      /** Steering error (radians) that maps to full lock. */
      steerFullLockAngle: 0.55,
      /** Above this steering error the AI eases off the throttle. */
      throttleEaseAngle: 0.75,
      /** Above this steering error at speed the AI brakes into the corner. */
      cornerBrakeAngle: 1.15,
      /** Speed under which the corner-brake rule is ignored. */
      cornerBrakeMinSpeed: 22,
      /** Turn angle (radians) at the next junction that counts as "sharp". */
      cornerTurnThreshold: 0.9,
      /** Distance from a sharp junction at which units start scrubbing speed. */
      cornerLookahead: 34,
      /** Speed units aim to be at when they enter a sharp junction. */
      cornerEntrySpeed: 24,
      /** Obstacle feelers: base length, plus extra length per unit of speed. */
      avoidFeelerBase: 8,
      avoidFeelerPerSpeed: 0.3,
      /** Angle of the left/right feelers from straight ahead, radians. */
      avoidAngle: 0.5,
      /** How hard a blocked side pushes the steering away. 0 disables avoidance. */
      avoidStrength: 0.9,
      /** Heading error that latches a committed turn-around, radians. */
      commitTurnAngle: 2.3,
      /** Heading error at which the committed turn is released, radians. */
      releaseTurnAngle: 1.1,
      /**
       * Below this speed for `stuckTime` seconds the unit tries to reverse out.
       * Set above a walking crawl on purpose: at 3.5 a unit that was grinding along a
       * barrier at 5 u/s never registered as stuck, so it stayed technically alive but
       * useless for ten seconds at a time — which quietly made the whole squad weaker.
       */
      stuckSpeed: 6,
      stuckTime: 1.1,
      /** Length of the reverse-out manoeuvre, seconds. */
      reverseTime: 0.9,
      /**
       * Total accumulated stuck time before the unit is teleported back into play.
       * Short, so an ineffective unit rejoins the pursuit quickly — reinforcements that
       * keep arriving are a large part of what makes the squad feel relentless.
       */
      respawnAfterStuck: 3.5,
      /** Respawn node must be at least this far from the player. */
      respawnMinDistance: 55,
      /**
       * Line-of-sight range within which units abandon waypoints and drive straight at
       * you. Long, because the open sections have almost nothing to block sight: out on
       * the flats they should cut across the grass after you rather than politely
       * following the road while you take the short line.
       */
      directPursuitRange: 105,

      /**
       * Closing speed for units that have been left behind.
       *
       * Without this, being passed once was permanent: police top speeds sit barely above
       * yours, so a clean driver who never touched anything simply drove away from the
       * whole squad and only ever met the cars spawned in front. Distance-scaled, so it
       * never applies to a unit already on you — it only stops the chase from ending
       * because you happened to be in front.
       */
      catchUp: {
        /** No help at all inside this range. */
        nearDistance: 55,
        /** Full help at this range and beyond. */
        farDistance: 210,
        /** Peak multiplier on top speed and acceleration. */
        maxBonus: 0.38,
      },
    },

    /**
     * The charge: a telegraphed run at the player, and the squad's melee answer.
     *
     * Ordinary contact is incidental — cars bump because they are all in the same place.
     * A charge is a decision: the unit lines up, its lights go solid, and then it comes.
     * The wind-up is what makes it fair; without it, being hit hard would be noise rather
     * than something you can see coming and turn out of.
     */
    charge: {
      /** Classes that can do it. */
      roles: ["rammer", "heavy", "elite", "juggernaut", "warden"],
      /** Range band to start one in. */
      minRange: 9,
      maxRange: 46,
      /** Must be pointed within this many radians of the player. */
      maxHeadingError: 0.75,
      /** Lights-solid wind-up before it commits, seconds. */
      telegraphTime: 0.45,
      /** Length of the run itself, seconds. */
      chargeTime: 1.1,
      /** Gap before the same unit can charge again, seconds. */
      cooldown: 6.5,
      /** Speed and shove multipliers while charging. */
      speedBonus: 0.3,
      contactBoost: 2.3,
    },

    /**
     * Pursuit boost. Units use it only when they are behind, lined up and already
     * rolling, so it reads as "closing the gap on a straight" rather than teleporting.
     */
    boost: {
      accel: 24,
      maxSpeedBonus: 13,
      duration: 1.6,
      cooldown: 5.0,
      /** Only boost when at least this far from the player. */
      minDistance: 42,
      /** Only boost when pointing near enough at the target, radians. */
      maxHeadingError: 0.4,
      /** Only boost once already moving, so they do not launch off the line. */
      minSpeed: 22,
    },

    /** STANDARD PATROL — the backbone unit. Present from the first section on. */
    patrol: {
      vehicle: policeVehicle({ maxSpeed: 46.5 }),
      /** Distance at which the patrol car stops trailing and lunges. */
      ramRange: 17,
    },

    /** HEAVY PURSUIT — arrives in the second half. Slow to turn, hard to shift. */
    heavy: {
      vehicle: policeVehicle({
        maxSpeed: 44,
        accel: 33,
        steerRateMax: 2.2,
        gripNormal: 8.8,
        mass: 2.6,
        halfLength: 2.7,
        halfWidth: 1.32,
      }),
      /** Takes less speed loss per hit and resists being shoved. */
      impactResistance: 0.55,
      pushResistance: 1.5,
      /** Hits noticeably harder than a patrol car. */
      contactBoost: 1.35,
      flankRange: 40,
      flankOffset: 10,
      strikeRange: 24,
      maxInterceptLead: 2.4,
    },

    /**
     * JUGGERNAUT — the armoured wrecker.
     *
     * Not fast and not clever: it is a wall with an engine. Five times your mass, a metre
     * wider than a patrol car, and it barely notices being hit. Its whole job is to arrive
     * at your flank and put you into the scenery, and there is no version of trading paint
     * with one that ends well for you. Go round it, out-corner it, or spend the rocket.
     */
    juggernaut: {
      vehicle: policeVehicle({
        maxSpeed: 43,
        accel: 31,
        steerRateMax: 1.95,
        gripNormal: 9.2,
        mass: 5.0,
        halfLength: 3.4,
        halfWidth: 1.72,
      }),
      /** Shrugs off almost everything: hits barely slow it and shoves barely move it. */
      impactResistance: 0.35,
      pushResistance: 2.4,
      /** And it hits like a truck. */
      contactBoost: 1.8,
      /** Commits from further out than a rammer; it cannot correct late. */
      flankRange: 52,
      flankOffset: 12,
      strikeRange: 30,
      maxInterceptLead: 2.6,
      /** Like the warden, only a near-direct rocket hit wrecks one. */
      rocketKillRadius: 8,
      rocketDisableTime: 2.2,
    },

    /** ELITE — fast, aggressive, used sparingly near the end. */
    elite: {
      vehicle: policeVehicle({
        maxSpeed: 52,
        accel: 41,
        steerRateMax: 2.7,
        gripNormal: 9.2,
        mass: 1.9,
      }),
      impactResistance: 0.7,
      pushResistance: 1.25,
      contactBoost: 1.25,
      /** Uses the interceptor's route-lead logic on a short horizon. */
      predictionTime: 2.0,
      commitRange: 38,
    },

    interceptor: {
      vehicle: policeVehicle({ maxSpeed: 50, accel: 37, gripNormal: 8.8 }),
      /** Seconds of player movement to extrapolate when picking a cut-off point. */
      predictionTime: 2.6,
      /** Prediction is clamped to this many units ahead of the player. */
      maxPredictionDistance: 150,
      /** Minimum lead, so a stopped player still gets someone posted up the road. */
      minPrediction: 45,
      /** Once this close to the player, switch from cutting off to direct blocking. */
      commitRange: 32,
    },

    rammer: {
      vehicle: policeVehicle({ maxSpeed: 47.5, accel: 38, gripDrift: 5.2 }),
      /** Inside this range the rammer swings out to the player's flank. */
      flankRange: 40,
      /** How far to the side it aims when lining up a hit, units. */
      flankOffset: 9,
      /** Inside this range it stops flanking and drives straight into you. */
      strikeRange: 22,
      /** Cap on how far ahead the intercept solution is allowed to aim, seconds. */
      maxInterceptLead: 2.5,
    },

    /**
     * The blocker is the "smart" unit. The escape point never moves, so the shortest
     * route from the player to it is knowable — the blocker walks that route forward by
     * `routeDepth` junctions and parks across the road there. It is not reacting to where
     * you are; it is waiting where you have to go.
     */
    blocker: {
      vehicle: policeVehicle({ maxSpeed: 46, accel: 36 }),
      /** Distance from its post at which it stops driving and sits. */
      parkRadius: 7,
      /** Start slowing for the post this far out... */
      approachDistance: 26,
      /** ...down to this speed, so it can actually stop on the junction. */
      approachSpeed: 17,
      /** Once the player is this close, abandon the post and actively body-block. */
      engageRange: 46,
      /** Re-pick a post only this often, so it commits instead of twitching. */
      repostInterval: 1.6,
      /** Seconds of player travel used to anchor the route the blockers plan against. */
      routePrediction: 1.6,
    },

    /**
     * WARDEN — the keeper on the exit ramp. A heavy SUV that never leaves the final
     * junction and cycles between two attacks, so the last corner is a fight rather than
     * a formality. Its mass means shunting it aside is not an option; you go around it,
     * time it, or spend the rocket on it.
     */
    warden: {
      vehicle: policeVehicle({
        maxSpeed: 44,
        accel: 34,
        steerRateMax: 2.15,
        gripNormal: 9.0,
        // Four times the player's mass: it barely notices contact, you get thrown.
        mass: 4.0,
        halfLength: 3.0,
        halfWidth: 1.5,
      }),
      /** Sits within this distance of the last junction on your route. */
      parkRadius: 8,
      /** Player inside this range with line of sight triggers an attack. */
      engageRange: 62,
      /** Length of one attack run before it breaks off, seconds. */
      attackTime: 2.8,
      /** Regroup time after an attack before it can commit again, seconds. */
      recoverTime: 1.1,
      /** How far to the player's side the sweep attack aims, units. */
      sweepOffset: 11,
      /** Cap on the intercept lead used by the charge attack, seconds. */
      maxInterceptLead: 2.0,
      /**
       * Breaks off an attack once it strays this far from the gate it is holding. Kept
       * short: at 42 the momentum of a two-tonne SUV carried it ~70 units past the gate
       * and it needed eight seconds to get back, leaving the ramp wide open.
       */
      leashRange: 30,
    },

    /**
     * Deployables — the weapons the squad leaves on the road rather than driving into you.
     *
     * Only units that have got ahead of you can lay one, which makes the whole mechanic a
     * consequence of losing the lead: while you are out front nothing can be put in your
     * path. Every value below exists to keep them answerable rather than arbitrary.
     */
    hazards: {
      /** Live hazards allowed on the course at once, per kind. */
      maxLive: 5,
      /** Minimum gap between any two deployments at section 0, seconds. */
      globalCooldown: 2.4,
      /** A given unit may only lay one this often at section 0, seconds. */
      unitCooldown: 10,
      /**
       * Both cooldowns shrink by this fraction of themselves per section, down to
       * `minCooldownScale`.
       *
       * Headcount and top speed both have to be capped — frame time and fairness — so
       * this is the difficulty screw with no ceiling on it. By the late sections the road
       * ahead of you is being carpeted, which is what "until it is absolutely ridiculous"
       * has to actually mean once there is no room for more cars.
       */
      cooldownPerSection: 0.055,
      minCooldownScale: 0.3,
      /** Deployable only from this far ahead of the player, in course units... */
      minLead: 45,
      /** ...and no further, or you would never see it laid. */
      maxLead: 190,

      /**
       * SPIKE STRIP. Half the top speed and a chunk of the grip for four seconds, and
       * boost does not wave it away — the whole point is that it hands the squad the
       * seconds they need to close in and pin you.
       */
      spike: {
        /** First section it can appear in. */
        unlockSection: 3,
        /** Classes that carry it: the two that get in front of you on purpose. */
        roles: ["interceptor", "blocker"],
        /** Seconds between landing and biting. Long enough to read and swerve. */
        armTime: 0.7,
        life: 14,
        /** Deliberately narrower than the road: there is always a way past. */
        halfWidth: 6.5,
        halfLength: 1.3,
        /** Tyre multipliers while shredded, easing back to 1 over `duration`. */
        gripScale: 0.72,
        speedScale: 0.5,
        duration: 4.0,
      },

      /**
       * OIL SLICK. Keeps your speed and takes your steering, which is a completely
       * different kind of problem — and much worse in a corner than on a straight.
       */
      oil: {
        unlockSection: 5,
        roles: ["rammer", "elite"],
        armTime: 0.35,
        life: 10,
        halfWidth: 5.5,
        halfLength: 4.5,
        gripScale: 0.3,
        speedScale: 1.0,
        duration: 2.8,
      },
    },

    /** Spawn placement and recycling. How *many* units is `escalation`'s job. */
    pacing: {
      /**
       * The opening wave, as distances up the course.
       *
       * All of them are *ahead* of you. The director cannot place these itself — at zero
       * progress there is no "behind" to place anything in — and the previous list asked
       * for two of them behind, which clamped to the first node on the spine and parked
       * two cars alongside you on the line. Police that are simply *there* when the run
       * begins read as a bug, not as pressure. These are coming the other way instead,
       * and any spur near the start gets one waiting in it.
       */
      openingWave: [120, 190, 265],
      /** How many of the opening units wait in a spur rather than on the road. */
      openingAmbushes: 2,
      /**
       * Course window the opening ambushers are drawn from. Far enough out that the first
       * seconds are clean, close enough that the first thing to come at you sideways does
       * so within about ten seconds of the lights going green.
       */
      openingSpurRange: [80, 620],
      /**
       * Beyond this distance a unit may appear even in plain view. Requiring concealment
       * outright left the open sections completely empty, because there is nothing out
       * there to hide behind.
       */
      farSpawnDistance: 165,
      /** How often activation/repositioning decisions run, seconds. */
      directorInterval: 0.4,
      /** Preferred spawn offsets along the route, in course units. */
      spawnAhead: 190,
      spawnBehind: 150,
      /**
       * Where a spawning unit is placed, as weights.
       *
       * Ambush is by far the largest share, and deliberately so. "behind" and "ahead" are
       * the two arrivals a corridor can produce on its own, and a squad built only from
       * those two reads as a queue: you outrun the ones behind, then dodge the ones in
       * front one at a time. The threat has to be able to come from off to the side.
       */
      spawnWeights: { ambush: 4, side: 2, behind: 2, ahead: 1 },
      /** Ambush spurs are only used within this window ahead of the player. */
      ambushLeadMin: 35,
      ambushLeadMax: 230,
      /** How far down the spur the unit waits, as a fraction of its length. */
      ambushDepth: 0.72,
      /** Lateral spawns need at least this much run-off to sit in. */
      sideShoulderMin: 9,
      /** Never appear closer than this to the player. */
      minSpawnDistance: 80,
      /** Fall this far behind and the unit is recycled forward instead of trailing. */
      retireBehind: 260,
    },

    /**
     * Endless escalation.
     *
     * Units are drawn from a pre-built pool as the run goes on. Two things ramp: how many
     * cars are on you, and which classes are allowed to show up. The first sections are
     * patrol cars only; by section 5 heavies are routine; past 11 the wardens come out.
     * The run always ends in a pile-up — the only question is when.
     */
    escalation: {
      /** Active units at section 0, and how many more per section after that. */
      baseActive: 4,
      activePerSection: 1.1,
      /** Ceiling, for fairness and frame time alike. */
      maxActive: 20,
      /** Section at which each class starts appearing. */
      unlock: {
        patrol: 0,
        rammer: 1,
        interceptor: 2,
        blocker: 3,
        heavy: 4,
        elite: 6,
        juggernaut: 7,
        warden: 9,
      } as Record<PoliceRole, number>,
      /**
       * Once unlocked, how strongly a class is favoured when waking the next unit.
       * Higher tiers outweigh lower ones so late sections stop being patrol soup.
       */
      weight: {
        patrol: 1,
        rammer: 1.8,
        interceptor: 1.6,
        blocker: 1.0,
        heavy: 2.4,
        elite: 3.0,
        juggernaut: 3.4,
        warden: 2.2,
      } as Record<PoliceRole, number>,
      /** Extra top speed added to every unit per section, u/s, and its cap. */
      speedPerSection: 0.22,
      maxSpeedBonus: 7,
    },

    /** How many of each class exist in the pool. Meshes are built once, up front. */
    pool: {
      patrol: 8,
      rammer: 6,
      interceptor: 5,
      blocker: 3,
      heavy: 5,
      elite: 5,
      juggernaut: 4,
      warden: 3,
    } as Record<PoliceRole, number>,
  },

  collision: {
    /** Velocity kept along the impact normal after a hit (0 = dead stop, 1 = full bounce). */
    restitution: 0.28,
    /** Fraction of tangential (sliding) speed kept when scraping a wall. */
    wallFriction: 0.82,
    /** Fraction of speed lost on a solid building hit. */
    buildingSpeedLoss: 0.42,
    /** Fraction of speed lost when cars trade paint. */
    carSpeedLoss: 0.3,
    /**
     * Ceiling on how much speed the player can lose to car contact in a single frame.
     *
     * Contacts resolve one pair at a time and each scrubs a share of what is left, so
     * four cars closing at once used to compound to a total stop in two frames — 43 u/s
     * to zero, no input could recover it, and the capture meter did the rest. Being hit
     * hard should cost you the corner, not the run.
     */
    maxCarSpeedLossPerFrame: 0.5,
    /** Extra shove applied car-to-car so contact reads as forceful. */
    carImpulse: 12.0,
    /** Yaw kick applied on off-centre impacts, rad/s per unit of impact speed. */
    spinFactor: 0.022,
    /** Max yaw kick from a single impact, rad/s. */
    maxSpin: 2.4,
    /** Impact speed below which no shake/sound is triggered. */
    minImpactSpeed: 6,
    /** Camera shake per unit of impact speed. */
    shakePerSpeed: 0.035,
  },

  camera: {
    /** Distance behind the car, units. */
    distance: 15.5,
    /** Height above the car, units. */
    height: 7.4,
    /** How far ahead of the car the camera looks, units. */
    lookAhead: 9,
    /** Extra look-ahead at top speed — fast sections need to read earlier. */
    lookAheadPerSpeed: 9,
    /** Extra camera height while airborne, so big jumps stay framed. */
    airLift: 3.5,
    /** Minimum clearance above whatever ground is under the camera itself. */
    slopeClearance: 6.5,
    /** Camera height offset of the look-at target. */
    lookHeight: 1.6,
    /** Position smoothing, higher = snappier. Frame-rate independent. */
    positionDamp: 6.0,
    /** Look-target smoothing. */
    targetDamp: 8.0,
    /** How fast the camera's own heading follows the car's heading (low = no whip on spins). */
    headingDamp: 4.2,
    /** Extra pull-back at speed, units at max speed. */
    speedPullback: 4.0,
    /** Field of view in radians, and how much boost widens it. */
    fov: 0.95,
    fovBoostBonus: 0.16,
    /** Shake decay per second. */
    shakeDecay: 4.5,
    /** Maximum shake magnitude in units. */
    maxShake: 1.4,
    /** Keep the camera at least this far from a building face. */
    wallPadding: 1.6,
    /** Minimum camera height so it never dips under the road. */
    minHeight: 2.2,
  },

  pickups: {
    /** Collection radius, units. Rocket ammo is the only pickup type. */
    radius: 6.0,
    /** Bob amplitude and spin rate for the floating marker. */
    bobHeight: 0.7,
    spinSpeed: 2.2,
    /** Ceiling on carried rockets, so ammo pickups stay a decision not a stockpile. */
    rocketMax: 2,
  },

  run: {
    /**
     * Points awarded per section survived, on top of raw forward distance.
     *
     * Roughly one section's worth of distance, so reaching the next section is always
     * worth about as much as the driving that got you there. That is the whole scoring
     * argument: progress counts, laps of the same block do not.
     */
    sectionBonus: 500,
    /**
     * Continuous seconds of being pinned before capture, with a single unit on you.
     *
     * With ten units in play, contact is constant by design — so this whole block is
     * tuned to make being *hit* survivable and being *held* fatal. Push the crowd bonus
     * or the speed threshold up much further and the run stops being winnable at all.
     */
    captureDuration: 4.2,
    /**
     * Each additional police car inside the capture radius adds this much to the fill
     * rate. Being swarmed should end the run fast; one car nudging you should not.
     * At 1.0 that is 3.0s for one unit, ~1.9s for two, ~1.4s for three.
     */
    captureCrowdBonus: 0.4,
    /** A police car must be inside this radius to contribute to capture. */
    captureRadius: 12,
    /**
     * Player speed below this counts as "pinned". Set high enough that being ground down
     * to a crawl by rams counts — at 7 a driver who kept nudging along at moderate speed
     * was untouchable no matter how many units were on them.
     */
    captureSpeed: 10,
    /** How fast the capture meter drains when you break free (multiplier of fill rate). */
    captureRecovery: 2.0,
    /**
     * Seconds stranded outside the course before the player is towed back.
     *
     * Long, and it only fires while barely moving. At 1.6 s and unconditional this was a
     * free escape hatch: leave the road, get replaced on it a moment later with every
     * pursuer shaken off. The wasteland does the containment now.
     */
    offCourseGrace: 9,
    /** Radius counted for the "police nearby" HUD readout. */
    heatRadius: 34,
  },

  audio: {
    masterVolume: 0.5,
    enabled: true,
  },
} as const;

export type Config = typeof CONFIG;
