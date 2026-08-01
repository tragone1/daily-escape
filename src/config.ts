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
  | "rig";

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
  /*
   * Reversing is how you get out of a pile-up, and a pile-up is the situation the whole
   * game is built around. Too slow to back out of one is too slow to play.
   *
   * Backing clear of trouble is three things in sequence, and the middle one turned out
   * to dominate: shedding the speed you had, building reverse speed, then covering the
   * ground. From a standstill, reversing eight units took 0.73s of which all but 0.02s
   * was waiting for reverse to wind up - so `reverseAccel` is the lever that matters and
   * `brakeDecel` only shows up when you were already moving. All three lifted together;
   * the same eight units now take 0.57s from rest and 1.15s from 30 u/s, down from 1.57s.
   *
   * `brakeDecel` is shared with ordinary braking, so the car also scrubs speed into a
   * corner faster. That is the same nimbleness asked for, pointed forwards.
   */
  reverseAccel: 54,
  maxReverseSpeed: 34,
  brakeDecel: 76,
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
    /*
     * Pinned to what the player had before reverse was quickened. These are spread from
     * PLAYER_VEHICLE, so without pinning them the squad would silently inherit the same
     * upgrade - and reverse is what a stuck unit uses to free itself, which would make
     * every pile-up easier for them to escape too. The nimbleness is the player's.
     */
    reverseAccel: 34,
    maxReverseSpeed: 26,
    brakeDecel: 58,
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
     * player's top speed climbs per section, capped. The police climb to +12 as
     * well, so their class edge holds constant rather than growing - this raises
     * the tempo of the whole late game rather than handing out an advantage: at
     * 58 every wall and head-on arrives sooner than your reflexes expect.
     */
    lateSpeed: {
      fromSection: 9,
      perSection: 0.6,
      max: 12,
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

  police: {
    /** Shared driving/AI values for every police car. */
    shared: {
      /** How often each unit re-plans its route through the street graph, seconds. */
      replanInterval: 0.3,
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
      /**
       * A unit this close to the player is never counted as stuck.
       *
       * This was the whole reason a stopped player could not be surrounded. A car pressed
       * against a stationary target is, by definition, moving slowly — so the stuck
       * detector fired, it reversed out of the sector it was blocking, and after three and
       * a half seconds it teleported away entirely. The squad was dismantling its own
       * ring as fast as it built it, which is exactly the "they get you close to pinned
       * and then bounce all over" that kept being reported. Sitting on somebody is the
       * job, not a fault.
       */
      pinningRange: 15,
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
      directPursuitRange: 135,

      /**
       * Closing speed for units that have been left behind.
       *
       * Without this, being passed once was permanent: police top speeds sit barely above
       * yours, so a clean driver who never touched anything simply drove away from the
       * whole squad and only ever met the cars spawned in front. Distance-scaled, so it
       * never applies to a unit already on you — it only stops the chase from ending
       * because you happened to be in front.
       */
      /**
       * Strike discipline — how a unit closes the last few car lengths.
       *
       * Left alone, a pursuer solves an intercept and drives at it flat out, which is why
       * they read as blasting past with a token swerve: their speed *along* the player's
       * line was thirty units an hour higher than the player's, so the geometry only
       * worked for the fraction of a second it took to overshoot. A real driver arrives
       * matching pace and turns in.
       *
       * The cap is on longitudinal overtake only. Closing sideways is untouched, because
       * closing sideways is the hit.
       */
      strike: {
        /** Discipline applies inside this range of the player. */
        range: 34,
        /** How much faster than the player you may travel along their line, u/s. */
        maxOvertake: 5,
        /** Never crawl while doing it. */
        minPace: 16,
        /**
         * How far *ahead* of the player a unit must already be for the cap to apply.
         *
         * Measured, not guessed. Capping anyone within range dropped contacts from 60 a
         * minute to 37: held back, they simply stopped arriving, which is the opposite of
         * the intent. Only a car that has genuinely got past and is pulling away needs
         * reining in — everyone else should be coming at you as hard as they can, and the
         * accuracy comes from the turn-in below rather than from going slower.
         */
        chaseGrace: -5,
        /**
         * Inside this range, aim *through* the player rather than at an intercept point,
         * so the last movement is a turn into them rather than a pass alongside.
         */
        turnInRange: 17,
        /** How far past the player to aim when turning in, units. */
        turnInDepth: 5.5,
      },

      /**
       * Boxing in.
       *
       * Left to itself every unit drives at the player, which produces a scrum that
       * shoves you around and rarely holds you: everyone arrives at the same point from
       * the same direction and the collisions cancel out. Instead the director hands the
       * nearest units a station around the player and they hold it, matching pace rather
       * than charging — a moving cage, closing.
       *
       * Offsets are in the player's own frame: x across, z along. The forward stations are
       * the brake-check, and they are the reason a fast player has to slow down.
       */
      box: {
        /** Units this close are assigned a station instead of chasing the player. */
        range: 78,
        /** How many stations are handed out at once — one per direction. */
        maxAssigned: 8,
        /** Re-assign this often, seconds. Slower than the director so units commit. */
        interval: 0.7,
        /**
         * Stations, in order of preference — eight of them, one per enclosure sector.
         *
         * The loss condition counts *directions blocked*, so the box has to be built to
         * fill directions. Six stations could only ever close six of eight sectors, which
         * meant a perfectly executed box still left two ways out and the arrest could not
         * finish. Front first, because the front of the box is what makes losing speed
         * expensive.
         */
        slots: [
          { x: 0, z: 9 },
          { x: -6.5, z: 6.5 },
          { x: 6.5, z: 6.5 },
          { x: -7, z: 0 },
          { x: 7, z: 0 },
          { x: -6, z: -6.5 },
          { x: 6, z: -6.5 },
          { x: 0, z: -8 },
        ],
        /**
         * Pace held while on station, as a multiple of the player's own speed. Ahead of
         * you they run slower and let you close — that is the brake-check; behind you they
         * run faster and push.
         */
        leadPace: 0.9,
        chasePace: 1.12,
        /**
         * Pace floor while holding station — but capped to just above the player's own
         * speed.
         *
         * A flat floor was the single biggest reason a stationary player never got
         * properly surrounded: every unit on station kept driving at 14 u/s into a car
         * that was not moving, bounced off, and broke the ring it had just closed.
         * Measured, sitting still produced 2.1 of 8 sectors blocked and the pin breaking
         * twelve times in half a minute. Against a stopped player the box has to *stop*.
         */
        minPace: 14,
        /** How much faster than the player the floor is ever allowed to be. */
        paceOverrun: 4,
        /** Once a unit is within this of its station it starts pressing inward. */
        pressRange: 7,
        /** How hard it presses, as a fraction of the offset removed per second. */
        pressRate: 0.85,
        /** Furthest the station can be closed in, as a fraction of the offset. */
        pressMax: 0.72,
        /**
         * Below this speed the box closes all the way, fast.
         *
         * This is what makes losing your pace the real punishment. Spikes, a slick, a
         * heavy hit — none of them end a run on their own; what ends it is the ten
         * seconds afterwards, while everything that was chasing you gets to arrive and
         * stand somewhere you needed to be.
         */
        slowPlayerSpeed: 22,
        slowPressBonus: 0.55,
        /**
         * Below `slowPlayerSpeed`, this many of the nearest units are pulled off whatever
         * they were doing and sent to the stations *in front*.
         *
         * A player who has lost their speed - spiked, slicked, hit - is the moment the
         * squad has been waiting for, and it should look like they know it. Left alone
         * the cars behind simply kept pushing, which shoves you *along* your route and is
         * closer to help than to an arrest.
         */
        slowFrontPriority: 4,
      },

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
      roles: ["rammer", "heavy", "elite", "juggernaut"],
      /** Range band to start one in. */
      minRange: 8,
      maxRange: 58,
      /** Must be pointed within this many radians of the player. */
      maxHeadingError: 0.75,
      /** Lights-solid wind-up before it commits, seconds. */
      telegraphTime: 0.38,
      /** Length of the run itself, seconds. */
      chargeTime: 1.1,
      /** Gap before the same unit can charge again, seconds. */
      cooldown: 4.2,
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
      /**
       * It hits hard, but not *launchingly* hard.
       *
       * At 1.8 (and 4.1 through a charge) the thing punted you clear across the road,
       * which sounds devastating and plays as mercy: you left the scrum with speed, and
       * speed is the one thing that stops the arrest. Its mass already makes contact
       * brutal. Its job is to be somewhere you cannot go, not to serve you.
       */
      contactBoost: 1.1,
      /**
       * Extra shove when the hit lands across the player's flank rather than fore or aft.
       *
       * `contactBoost` stays at 1.1 for the reason above — a big general shove threw you
       * clear with speed still on, which is mercy dressed as violence. A broadside is the
       * opposite: the impulse runs along the contact normal, so on a T-bone it carries
       * you sideways into whatever is there rather than down the road. That is the hit
       * this class is supposed to land, so it is the only one that gets amplified.
       */
      broadsideBoost: 4.2,
      /**
       * The broadside run: hold the flank until actually abeam, then drive *through*.
       *
       * Without this the class was not a T-bone specialist in any measurable sense — only
       * 44% of its hits landed on a flank, against 65% for the plain heavy. The cause is
       * `strikeRange`: at 34 units it abandoned the flank and drove straight at the player
       * while still behind them, which is a rear-end. Nose-to-tail is the one hit that
       * hands the player speed, so the class was spending its weight on the wrong contact.
       *
       * Two changes. It stays on the flank until its along-axis offset is inside
       * `alongWindow`, however close it gets; and when it does commit it aims at a point
       * `throughDepth` past the player's far side rather than at the player, so the
       * approach vector is across their axis and the contact normal comes out lateral.
       */
      broadside: {
        /** Fore-and-aft offset, in units, inside which it counts as abeam and may commit. */
        alongWindow: 9,
        /** How far past the player's far side to aim, so it drives through rather than at. */
        throughDepth: 12,
        /** Seconds of player travel to lead by while lining the run up. */
        lead: 0.45,
      },
      /** Commits from further out than a rammer; it cannot correct late. */
      flankRange: 58,
      flankOffset: 9,
      /** Wide: it closes to alongside and stays there rather than passing through. */
      strikeRange: 34,
      maxInterceptLead: 2.6,
      /** Only a near-direct rocket hit wrecks one. */
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
     * RIG — the roadblock.
     *
     * A long armoured transport that does not chase you at all. It reads the road ahead,
     * picks the *narrowest* point within reach, drives there and parks broadside across
     * it. Nine metres of stationary vehicle at a pinch point is a wall with a gap either
     * side, and which gap you take is a decision made at speed with the rest of the squad
     * behind you.
     *
     * Placement is the whole unit. A rig parked in the middle of the open off-road section
     * is scenery; the same rig across a narrow downtown block is the reason the run ended.
     */
    rig: {
      vehicle: policeVehicle({
        // Slow, because it never has to race you anywhere. It is placed in position ahead
        // of you and is simply *there* when you arrive; a nine-metre transport overtaking
        // a sports car to set up in front of it was the least convincing thing on the
        // roster. It still shifts to cover a gap you are obviously aiming at.
        maxSpeed: 38,
        accel: 26,
        steerRateMax: 1.5,
        gripNormal: 9.4,
        // Nothing shifts it. Going around is the only play.
        mass: 8.0,
        halfLength: 6.0,
        halfWidth: 1.85,
      }),
      impactResistance: 0.2,
      /**
       * Immovable at speed, shiftable with a boost behind you.
       *
       * At 1.35 the second half of that was not true. A boosting player barges at
       * `boostBargeScale`, which left the rig an effective 2.4 against the player's 1.0 —
       * the charge just bounced off, and a rig sealing a gap with no rocket in hand was
       * the end of the run. At 0.4 the boost outweighs it (0.70 against your 1.0) and
       * shoves it aside decisively, while an unboosted hit still meets 3.2 against 1.0 —
       * a parked lorry, but one worth charging.
       */
      pushResistance: 0.4,
      contactBoost: 1.0,
      /**
       * How far up the route it is placed. It arrives by being *put* there, out of sight,
       * not by driving past you.
       */
      scoutMin: 260,
      scoutMax: 700,
      /** Never more than this many blocking the road at once. */
      maxActive: 1,
      /** Stood down once the player is this far past it. */
      retirePast: 70,
      /**
       * How much of your lateral offset it matches while holding, and how far inside the
       * kerb it stays.
       *
       * Partial on purpose. At 1.0 it mirrors you exactly, the gap never opens, and the
       * block is unbeatable rather than difficult. At 0.55, committing to a side early
       * lets it shuffle across to meet you and a late move beats it — which is the
       * decision the roadblock is supposed to be. The inset stops a nine-metre transport
       * creeping off the tarmac it is there to block.
       */
      holdTracking: 0.55,
      holdInset: 3.5,
      /** Settles this close to its tracked point, rather than at `parkRadius`. */
      holdStopWithin: 2.0,
      /** Distance from its chosen spot at which it stops driving and turns broadside. */
      parkRadius: 11,
      /** Start slowing this far out, down to this speed, so it can stop on the mark. */
      approachDistance: 40,
      approachSpeed: 20,
      /** How fast it swings across the road once parked, rad/s. */
      turnRate: 1.9,
      /** Re-pick a spot only this often, so it commits instead of chasing the ideal one. */
      repickInterval: 6,
      /** Only blocks where the drivable width is under this, unless nothing else is near. */
      preferredWidth: 30,
      /**
       * Never park somewhere narrower than this.
       *
       * The rig is twelve metres long and the canyon is fourteen wide, so broadside in the
       * wrong place it sealed the road outright — measured, impassable even with a boost
       * behind you, and with no rocket in hand that is a dead run rather than a hard
       * corner. It now stands where there is still a car's width to fight for.
       */
      minBlockWidth: 19,
      /** Only a near-direct rocket wrecks one. */
      rocketKillRadius: 9,
      rocketDisableTime: 2.4,
    },


    /**
     * Deployables — the weapons the squad leaves on the road rather than driving into you.
     *
     * Only units that have got ahead of you can lay one, which makes the whole mechanic a
     * consequence of losing the lead: while you are out front nothing can be put in your
     * path. Every value below exists to keep them answerable rather than arbitrary.
     */
    hazards: {
      /**
       * Fraction of the local road half-width a hazard may span, and the gap it must
       * always leave.
       *
       * A strip is a decision, and a decision needs an alternative. Laid at a fixed width
       * they covered the whole carriageway in the narrow sections, where there is no line
       * to take and running one over is simply what happens - which is not a hazard, it
       * is a toll.
       */
      maxRoadShare: 0.62,
      minGap: 5.5,

      /** Live hazards allowed on the course at once, per kind. */
      maxLive: 5,
      /** Minimum gap between any two deployments at section 0, seconds. */
      globalCooldown: 2.4,
      /** A given unit may only lay one this often at section 0, seconds. */
      unitCooldown: 10,
      /**
       * Extra cooldown multiplier applied to oil specifically.
       *
       * The slick is much the more disruptive of the two and much the cheaper to lay, so
       * on the shared timer it turned up constantly and stopped reading as an event.
       * Rarer and nastier is the better trade - it is now carried by rammers alone.
       */
      oilCooldownScale: 2.6,
      /**
       * Both cooldowns shrink by this fraction of themselves per section, down to
       * `minCooldownScale`.
       *
       * Headcount and top speed both have to be capped — frame time and fairness — so
       * this is the difficulty screw with no ceiling on it. By the late sections the road
       * ahead of you is being carpeted, which is what "until it is absolutely ridiculous"
       * has to actually mean once there is no room for more cars.
       */
      cooldownPerSection: 0.035,
      minCooldownScale: 0.16,
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
        /** Classes that carry it: the ones that get in front of you on purpose. */
        roles: ["interceptor", "blocker"],
        /** Seconds between landing and biting. Long enough to read and swerve. */
        armTime: 0.7,
        life: 18,
        /** Deliberately narrower than the road: there is always a way past. */
        halfWidth: 6.5,
        halfLength: 1.3,
        /** Tyre multipliers while shredded, easing back to 1 over `duration`. */
        gripScale: 0.55,
        speedScale: 0.34,
        duration: 6.0,
      },

      /**
       * OIL SLICK. Keeps your speed and takes your steering, which is a completely
       * different kind of problem — and much worse in a corner than on a straight.
       */
      oil: {
        unlockSection: 5,
        roles: ["rammer"],
        armTime: 0.3,
        life: 9,
        /** Wide enough that threading it is a real line rather than a shrug. */
        halfWidth: 7.5,
        halfLength: 5.5,
        /*
         * Near zero, and it needs to be. At 0.3 the lateral damping was still strong
         * enough to pull the car straight within a corner's worth of time, so hitting a
         * slick was something you could ignore. At 0.06 the velocity keeps pointing where
         * it was pointing while the nose turns, which is what a slide actually is: you
         * steer and nothing happens for a second and a half.
         */
        /*
         * Effectively no grip at all, and no speed penalty worth the name.
         *
         * The slick is not a slowing hazard - a liquid does not slow you down, it stops
         * you steering. Taking pace off it as well muddled what it was for and made it
         * feel like a weak spike strip. All of its weight is now in control: you keep
         * every unit of speed you had and almost none of your ability to point the car.
         */
        gripScale: 0.0008,
        speedScale: 1.0,
        duration: 5.5,
        /**
         * Extra grip loss while boosting through it.
         *
         * Power with no traction is what a slide actually is, so lighting the boost on
         * an oiled surface should not rescue you — it should make the car completely
         * wild. It is the one moment in the game where the answer to everything else is
         * the wrong move, and it is worth having.
         */
        boostGripScale: 0.25,
        /**
         * Yaw the car picks up per unit of sideways slide while oiled, rad/s.
         *
         * Low grip alone makes the car understeer in a straight-ish line; it is this that
         * makes it come round. Drive gently and you slither, drive hard - or boost - and
         * you can genuinely spin, which is the difference between an inconvenience and a
         * thing you have to respect.
         */
        spinPerSlip: 0.16,
        maxSpin: 5.5,
        /**
         * Extra yaw per unit of steering input while oiled, rad/s.
         *
         * This is what makes it punish *aggression* specifically. Feather it and you
         * slither in a straight line; snatch at the wheel or light the boost and the back
         * end comes round and keeps coming.
         */
        spinPerSteer: 2.4,
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
      openingWave: [240, 340],
      /**
       * Units that open the run already hunting, placed this far up the road facing
       * back down it. Without them, second zero had two ambushers waiting, three
       * traffic cars driving away, and nothing engaging - a player who simply stood
       * still waited most of a minute to be punished. These arrive within seconds, so
       * no part of the run is a freebie, including the first breath of it.
       */
      openingChasers: [340, 440, 540],
      /** How many of the opening units wait in a spur rather than on the road. */
      openingAmbushes: 2,
      /**
       * Course window the opening ambushers are drawn from. Far enough out that the first
       * seconds are clean, close enough that the first thing to come at you sideways does
       * so within about ten seconds of the lights going green.
       */
      openingSpurRange: [380, 820],
      /**
       * Beyond this distance a unit may appear even in plain view. Requiring concealment
       * outright left the open sections completely empty, because there is nothing out
       * there to hide behind.
       */
      farSpawnDistance: 165,
      /** How often activation/repositioning decisions run, seconds. */
      directorInterval: 0.28,
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
      /*
       * Ahead carries real weight now. When the ahead minimum went to 145 the old
       * ladder rungs below it were silently refused every tick, and head-on pressure
       * quietly drained out of the game - the cars landed behind or sideways instead.
       * More weight plus a deeper ladder means a near-constant stream arriving from up
       * the road, every one of them spawned beyond sight-distance and driving in.
       */
      // Every class ambushes from alleys - that is the design. The juggernaut is
      // simply the one class that arrives no other way.
      spawnWeights: { ambush: 9, side: 1.5, behind: 2.5, ahead: 3.0 },
      /**
       * Minimum live units *behind* the player. Below this the next spawn is forced to
       * the rear regardless of the weights.
       *
       * Ambush and side placements both tend to put cars in front, and the recycler pulls
       * stragglers forward, so the deep sections could quietly end up with the entire
       * squad ahead of you and nothing at your back at all. Pressure from behind is what
       * stops you simply lifting off and picking your way through what is in front.
       */
      minBehind: 3,
      /** A unit counts as "behind" from this far back, so bumper-riders do not count. */
      behindDistance: 25,

      /** Ambush spurs are only used within this window ahead of the player. */
      ambushLeadMin: 85,
      ambushLeadMax: 340,
      /** How far down the spur the unit waits, as a fraction of its length. */
      ambushDepth: 0.72,
      /**
       * The ambush is a *timed* release, and that is the whole mechanic.
       *
       * Woken as an ordinary pursuer, a unit in a spur simply drove out at once, crossed
       * the road and buried itself in the far wall, and by the time the player arrived it
       * was scenery to be driven past. Now it holds station until the player's time to
       * the mouth matches its own, so it arrives in the road at the moment you do —
       * side-on, at speed, from a direction you were not looking in.
       *
       * It is beatable exactly the way it should be: the maths is done against your
       * *current* speed, so anyone who boosts through the section arrives early and the
       * launch misses behind them.
       */
      ambush: {
        /**
         * Slack on the unit's own estimate, seconds. Negative launches *later*.
         *
         * Deliberately late. Timed to arrive exactly with the player it meets them nose
         * to nose, which is a head-on and reads as a wall; a quarter-second behind that
         * and it comes through the flank instead, which is the hit that actually spoils
         * a line and shoves you into the far wall.
         */
        leadTime: -0.28,
        /**
         * Fraction of top speed it assumes it will average getting out of the spur.
         * High on purpose - overestimating its own pace is another way of launching late.
         */
        launchSpeedFactor: 0.85,
        /**
         * Range at which it reads your speed — and it only reads it once.
         *
         * Re-timing every frame made the ambush *better* against a boosting player, which
         * is precisely backwards: the faster you came, the earlier it left, and it landed
         * anyway. Latching the estimate is what turns the boost into the counter. Come in
         * at cruising pace and it has you; light the charge after it has committed and you
         * are through the gap before it arrives.
         */
        readRange: 210,
        /**
         * Re-aim at the player *after* launching, until this far from the mouth.
         *
         * The launch is a timed guess and a guess is usually a near miss — it came out
         * behind, or in front, and either way the player drove past it. Steering the run
         * for the first stretch turns the guess into a strike, and it is what makes the
         * hit land on the flank at any speed rather than only at the pace it predicted.
         */
        homeDistance: 95,
        /**
         * How far *past* the intercept point to aim while springing.
         *
         * Arriving exactly at the intercept means arriving alongside, which is a scrape.
         * Aiming beyond it turns the same approach into a T-bone.
         */
        strikeDepth: 9,
        /** Extra pace while springing, so it arrives with weight behind it. */
        launchSpeedBonus: 0.75,
        /** Once the player is past, come out anyway and join the chase from behind. */
        releaseBehindRange: 90,
        /** Never wait longer than this, so a unit cannot be stranded by a dead run. */
        maxWait: 24,
        // Pin fields exist for type unity with the openRoad ambush block; only the
        // armoured ambushers ever enter the pin, so these are never read in anger.
        pinRange: 5.4,
        pinTime: 4.5,
        pinLostRange: 14,
        springRange: 40,
        strikeGo: 46,
        strikeTime: 12,
        chaseSpeed: 0.2,
        burstWindow: 9,
        turnAssist: 2,
      },
      /** Lateral spawns need at least this much run-off to sit in. */
      sideShoulderMin: 9,

      /*
       * Placement effort, and the section it switches on at.
       *
       * The director refuses a lot of placements - no spur in range, nowhere out of sight,
       * the spot already taken - and it used to abandon recruitment for the whole tick on
       * the first refusal. Early on that barely shows, because there is room and the target
       * is low. Deep in a run there are fifteen cars in a narrow corridor, refusals become
       * the common case, and headcount settles four to six under target: the squad thins
       * out exactly where it is supposed to be closing in.
       *
       * The extra effort is deliberately gated rather than global. Sections one to eleven
       * play the way they are meant to and must not move; this only changes what happens
       * after them.
       */
      effortFromSection: 11,
      /** Placements that may be attempted per tick once the gate is open. */
      wakeAttempts: 24,
      /** Units that may be woken per tick below the effort gate. */
      wakePerTick: 2,
      /**
       * Per tick past the gate. With the ceiling at 30 the old rate of two could not
       * outpace the churn of stragglers being recycled, so the road equilibrated around
       * twenty whatever the target said. Gated, so sections one through eleven keep the
       * exact wake rhythm they were tuned with.
       */
      wakePerTickLate: 3,
      /** Never appear closer than this to the player. */
      minSpawnDistance: 80,
      /**
       * Never appear closer than this *in front* of the player, hidden or not.
       *
       * The base minimum plus the out-of-sight rule allowed a spawn eighty units up the
       * road behind a corner, which the player then rounded two seconds later - a car
       * materialising a few lengths ahead, in plain view of where they were looking.
       * Ahead of the player, distance is the only honest concealment: spawn deep and
       * drive in like everything else does. Rear and side spawns keep the old rules,
       * including the closer allowance around a slowed player - nobody is watching
       * their mirrors mid-pile-up.
       */
      minAheadSpawnDistance: 145,
      /**
       * Spawn distance is scaled down for a player who has come to a halt.
       *
       * Standing still used to mean waiting the better part of a minute while the squad
       * drove in from wherever it had been placed. Stopping should bring the chase to you
       * quickly - the whole point of stopping being fatal is that it is fatal soon.
       */
      slowPlayerSpeed: 12,
      /**
       * 0.4: a stopped player is the moment the squad exists for, and the swarm should
       * arrive while stopping still feels like a mistake rather than a breather.
       */
      slowSpawnScale: 0.4,
      /**
       * A unit inside this range *and* in plain sight is never moved, recycled or stood
       * down, whatever else the director wants.
       *
       * Every reposition in here is a teleport, and the rules only ever checked where a
       * car was going, never where it was coming from — so a unit could pull out of a
       * spur beside you, drive for a second and blink out of existence while you watched.
       * Recycling is meant to be invisible bookkeeping; on screen it is just a bug.
       */
      keepVisibleRange: 190,
      /**
       * Fall this far behind and the unit is recycled forward instead of trailing.
       *
       * Shortened, because headcount is only half of what "there are police here" means.
       * Five cars strung out down the road behind you is an empty section; the same five
       * picked up and put back in front of you is a busy one.
       */
      retireBehind: 170,
    },

    /**
     * Endless escalation.
     *
     * Units are drawn from a pre-built pool as the run goes on. Two things ramp: how many
     * cars are on you, and which classes are allowed to show up. The first sections are
     * patrol cars only; by section 5 heavies are routine; past 11 the juggernauts come out.
     * The run always ends in a pile-up — the only question is when.
     */
    escalation: {
      /**
       * Active units at section 0, and how many more per section after that.
       *
       * The old 4 + 1.1 asked for 5 units in section 2 and 6 in section 3 — and the
       * opening wave already has 5 on the board, so the first two sections after the
       * start woke nothing at all and played out as a lull. The curve has to clear the
       * opening wave immediately or the game gets quieter before it gets louder.
       *
       * The fix is a higher base with a shallower slope, not a steeper slope: raising the
       * rate filled the early sections but compounded all the way up.
       *
       * The slope came down again once the capture meter learned to account for a crowd.
       * Eleven cars in section 5 that could not actually finish you was the worst of both
       * worlds — punishing to drive through and harmless to be caught by. Eight that can
       * is a better section, and it leaves the ceiling until section 19 instead of 12,
       * which is most of where the late game's escalation now lives.
       */
      /*
       * Headcount for the *main fleet* only - patrol, rammer, interceptor, blocker, heavy
       * and elite. The juggernaut and the rig are specialists and are budgeted
       * separately, so adding one never costs the chase a car. They used to share this
       * number, which meant every ambusher waiting in an alley was one fewer unit on the
       * road behind you.
       *
       * Base and slope are untouched: the curve through section nine is the one that
       * plays well and it is not being altered. Only the ceiling moved.
       */
      /**
       * 10 with a flatter climb (was 7 + 1.15/section): the opening set alone is nine
       * cars, so a base of 7 meant a stopped player in section one drew zero
       * reinforcements - the budget was already full of cars driving the wrong way.
       * 12 leaves three slots open at the lights, which is what turns a stopped
       * player's trickle into a swarm.
       * The two curves converge at section 20, so the late game is untouched.
       */
      /**
       * 9 + 1.2/section (was 12 + 1.0): same ceiling, later arrival. The flat-12 base
       * made the early sections carry near-mid-game headcounts; this starts three
       * lighter, converges around section ten, and hits the cap at the same place.
       * The stopped-player swarm does not live here - it lives in wake persistence,
       * pool depth and the relaxed slow-player spawn floor, which are untouched.
       */
      baseActive: 7,
      activePerSection: 1.4,
      /**
       * Section one only, and it equals the opening set exactly: two wave cars, three
       * chasers, two alley ambushers. No wake-fill pack at all - the first fresh face
       * arrives with section two's budget.
       */
      openingActive: 7,
      /**
       * Ceiling, for frame time more than fairness.
       *
       * Was 20 and reached at section 13, which is precisely where the run stopped
       * getting harder by headcount; then 24, reached at 16. Now 30, reached at section
       * 21, so the count itself keeps climbing deep into the run - the formula sits
       * under the old cap until section 16, so nothing before that moves at all. Past
       * 21 the mix and the speed bonus carry it. Watch frame time if this rises again:
       * the car-pair collision pass grows with the square of the head count.
       */
      maxActive: 30,
      /** Section at which each class starts appearing. */
      unlock: {
        patrol: 0,
        rammer: 1,
        interceptor: 2,
        blocker: 3,
        heavy: 4,
        elite: 6,
        juggernaut: 7,
        rig: 5,
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
        /*
         * The two armoured classes are deliberately scarce now, down from 3.4 and 2.2.
         *
         * They were the heaviest-weighted things in the table at exactly the point the
         * lighter classes retire, so the late mix became mostly them - and five metres of
         * juggernaut in a corridor is not a threat you answer, it is a cork. Rare enough
         * to be an event, and paid for with a broadside that actually hurts.
         */
        juggernaut: 1.5,
        rig: 2.6,
      } as Record<PoliceRole, number>,
      /**
       * The two classes that exist only to ambush.
       *
       * They spawn into a side alley and nowhere else, wait for you, take one shot across
       * your nose, and are finished — no chase, no second attempt, no trailing you up the
       * road afterwards.
       *
       * They were briefly the opposite of this: pursuit units barred from narrow road so
       * they could not cork a corridor. That solved the corking and left them as slower
       * heavies. Living in the alleys is what makes them specialists, and never lingering
       * in one is what keeps the corridors clear — the width rule is gone with the rest.
       */
      openRoad: {
        roles: ["juggernaut"] as PoliceRole[],
        /**
         * How many may be lying in wait at once, counted apart from the main fleet.
         *
         * One from the moment they unlock, a second past `secondAt`, a third past
         * `thirdAt`. They are traps rather than pursuit, so the number stays tiny and
         * grows slowly - and because the budget is separate, every one of them is an
         * addition to the squad rather than a substitution for part of it.
         */
        maxActive: 3,
        secondAt: 12,
        thirdAt: 26,
        ambush: {
          /**
           * Slack on the unit's own timing estimate, seconds.
           *
           * The shared value is -0.28, deliberately late so the hit lands on the flank
           * rather than nose to nose. Same idea here, less slack, because these steer the
           * run afterwards and can correct what the timing gets wrong.
           */
          leadTime: -0.18,
          /** Assumed fraction of top speed out of the spur. */
          launchSpeedFactor: 0.95,
          /** Reads your pace from further out, so the commitment is better informed. */
          readRange: 300,
          /**
           * Re-aim at the player for this long after launching.
           *
           * The single biggest lever on whether the strike connects. The shared 95 lets a
           * mistimed launch turn into a near miss; at 190 the run is steered essentially
           * all the way onto the player, which is what "high percentage" costs.
           */
          homeDistance: 340,
          /** Aim this far past the intercept, so the contact is across them, not alongside. */
          strikeDepth: 15,
          /** Extra pace while springing. It has to arrive with the weight behind it. */
          launchSpeedBonus: 2.6,
          /**
           * The pin. Contact during the strike converts the run into a hold: the unit
           * keeps its nose in the player and grinds them into whatever is behind for
           * `pinTime` seconds, feeding the box-in meter, before standing down. Losing
           * the player past `pinLostRange` ends it early. This is what makes the slam
           * a sentence rather than a speed bump.
           */
          pinRange: 8.5,
          pinTime: 7,
          pinLostRange: 26,
          /**
           * Inside this range of the mouth the shot simply goes, whatever the timing
           * math says. A weaving, braking player made the ETA gate flicker closed
           * through its whole firing window and the unit died waiting for perfect.
           */
          /**
           * Wide on purpose: springing is now *pre-positioning*, not firing. The unit
           * noses up to the mouth early and sits poised there; `strikeGo` is the
           * trigger. Decoupling the two is what makes it a missile on a rail instead
           * of a truck accelerating from cold as the player arrives.
           */
          springRange: 90,
          /**
           * Hard cap on the burst, seconds. Short: the touch happens in the first two
           * seconds or the geometry has moved on, and a long tail-chase grinding
           * walls behind the player is the one look this class must never have.
           */
          strikeTime: 9,
          /**
           * The burst fires when the player's PREDICTED position - at the moment the
           * truck's own nose will reach the road, solved from its actual depth in the
           * alley - falls within this many units of the mouth. Point-blank timing:
           * the prediction horizon is well under a second, too short to drift.
           */
          burstWindow: 9,
          /**
           * Top-speed multiplier bonus for the whole hunt. 0.7 puts it near 73 u/s -
           * a clear edge over even the section-29 player at 58 - because the contract
           * is contact EVERY time, and a chase without a speed edge is a coin flip.
           */
          chaseSpeed: 1.0,
          /**
           * The launch proper does not begin until the player is inside this range.
           * An early spring - live timing fired optimistic, player braked - now means
           * the unit noses up to the mouth and holds there, poised, instead of
           * charging across an empty road into the far wall in front of an arriving
           * player. Heat-seeking missiles wait on the rail.
           */
          strikeGo: 55,
          /**
           * Direct yaw assist while homing, rad/s^2 against the aim error. The chassis
           * is deliberately slow to steer everywhere else; the strike gets rails, so
           * swerving, braking and boosting all converge on the same contact.
           */
          turnAssist: 16,
          /**
           * Once the player is this far past, the shot is gone and so is the unit.
           *
           * No chase afterwards: a spent ambusher that joins the pursuit is just another
           * heavy in the pack, which is exactly what these were taken out of.
           */
          giveUpPast: 55,
          /**
           * Never pull out just because the player is already past.
           *
           * The shared ambush does that at 90 units — better to join the chase than sit
           * in a dead end. These do the opposite: a missed window is the end of the unit,
           * because a juggernaut arriving behind you is the pursuit car this class was
           * explicitly taken out of being.
           */
          releaseBehindRange: 0,
          /** Long: it is waiting for one specific moment and nothing else. */
          maxWait: 40,
        },
        /**
         * Road half-width, in units, a stretch must hold throughout the window.
         *
         * At 7.6 this is the hills and the flats, and the earlier sections of everything
         * else before tightening bites. The canyon and downtown floors (7.15) sit just
         * under it, which is the intent: those two are the corridors the complaint was
         * about.
         */
        minHalfWidth: 7.6,
        /** Window ahead of the player that must be open for one to be sent. */
        lookAhead: 165,
        /** ...and behind, so it is not woken on the wrong side of a pinch. */
        lookBehind: 45,
        /** An active one this far from the player may be stood down out of a corridor. */
        withdrawDistance: 55,
      },
      /**
       * Section after which a class stops being sent at all.
       *
       * This is the escalation that costs nothing at runtime. Headcount has to be capped
       * for frame time, so past the cap the *mix* is the only thing left to turn — and
       * "twenty cars" meaning juggernauts and rigs is a completely
       * different section from "twenty cars" meaning eight patrols and some rammers.
       * Before this, nothing whatsoever changed after section 13.
       */
      retire: {
        patrol: 13,
        rammer: 19,
        blocker: 22,
        interceptor: 26,
        heavy: 999,
        elite: 999,
        juggernaut: 999,
        rig: 999,
      } as Record<PoliceRole, number>,

      /** Extra top speed added to every unit per section, u/s, and its cap. */
      speedPerSection: 0.3,
      maxSpeedBonus: 12,
    },

    /**
     * How many of each class exist in the pool. Meshes are built once, up front.
     *
     * The heavy end has to be deep enough to fill the entire active cap on its own, since
     * past section 26 nothing else is being sent.
     */
    /*
     * How many of each class exist. Not a tuning dial - a hard ceiling on what the
     * director can ever put on the road, and the cause of the late game emptying out.
     *
     * Retirement removes patrol at 13, rammer at 19, blocker at 22 and interceptor at 26,
     * so from section 27 the only classes still dispatched were heavy and elite: twelve
     * cars in existence against a target of twenty. The squad did not thin out because of
     * placement or pacing, it thinned out because there was nothing left to send. Measured
     * on road: 17.1 at section 13 falling to 10.9 by section 40, below where section 5 sat.
     *
     * The rule now is that whatever survives to a given section must be able to cover the
     * target on its own. Heavy and elite carry the end of the run alone, so between them
     * they hold more than `maxActive`.
     */
    pool: {
      patrol: 16,
      rammer: 8,
      interceptor: 8,
      blocker: 5,
      heavy: 17,
      elite: 17,
      juggernaut: 9,
      rig: 4,
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
     * Below this player speed, car-on-car contact settles instead of bouncing.
     *
     * The fixed shove exists so that contact during a chase reads as forceful. Against a
     * player who has already stopped it does the opposite of its job: it scatters the
     * ring the squad just built, so a car that had you pinned punts itself back out of
     * the sector it was blocking. Once you are stopped they should nestle in and stay.
     */
    pinSettleSpeed: 12,
    pinShoveScale: 0.12,
    pinRestitution: 0.05,
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
    /**
     * How much of its mass a vehicle keeps when barged by a boosting player.
     *
     * A parked rig is eight tonnes braced against the road, and in a corridor it cannot
     * slide sideways either, so the ordinary mass ratio made boosting into one feel like
     * boosting into the scenery. This makes the charge a genuine tool for getting through
     * something rather than an extra ten units of speed you carry into it.
     */
    boostBargeScale: 0.22,
    /**
     * How much of that shove applies between two police cars.
     *
     * Low, and this matters more than it sounds. A juggernaut charging into a scrum used
     * to scatter its own side as hard as it hit you — the heaviest unit in the game
     * arriving read as a *reset*, blowing the box open and handing you the gap. Police
     * hitting each other now mostly just jostle, so a pile-up stays a pile-up.
     */
    policeImpulseScale: 0.2,
    /**
     * How square a hit must be to count as a broadside, as |cos| against the player's
     * own axis. At 0.72 it is roughly the middle 45 degrees of each flank: a genuine
     * T-bone qualifies, a glancing scrape down the side does not, and the boost is scaled
     * by the alignment on top of that so it arrives gradually rather than as a switch.
     */
    broadsideAlignment: 0.72,
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
    /*
     * Set so the *fastest* possible arrest takes 2.6s: at a full seal the crowd
     * multiplier is 0.95, and 2.47 / 0.95 is 2.6. That is the floor rather than the
     * average - a four-wedge pin takes ~3.6s, five ~3.0s, and only a complete seal
     * closes in 2.6. Was 1.8 flat-out; playtesting read that as "two seconds and I
     * lost" arriving before the meter could even be noticed, let alone fought.
     */
    captureDuration: 2.47,
    /**
     * Each additional police car inside the capture radius adds this much to the fill
     * rate. Being swarmed should end the run fast; one car nudging you should not.
     * At 1.0 that is 3.0s for one unit, ~1.9s for two, ~1.4s for three.
     */
    captureCrowdBonus: 0.4,
    /** A police car must be inside this radius to contribute to capture. */
    captureRadius: 12,
    /**
     * What counts as "pinned", as a speed threshold — and it rises with the crowd.
     *
     * A single car on your bumper only has you if you are nearly stopped. Eight of them
     * packed around you have you at a good deal more than that: you are not escaping, you
     * are being carried. The flat 10 was the reason a player could be visibly buried in
     * police and simply drive out of it — every ram bumped them back over the threshold,
     * so the meter never filled no matter how bad the situation looked.
     */
    /** Time constant for the smoothed speed the pin test uses, seconds. */
    captureSpeedSmoothing: 0.55,
    /**
     * Being *surrounded*, measured as directions blocked rather than cars counted.
     *
     * The circle around the player is cut into `enclosureSectors` wedges and a wedge
     * counts as blocked when a live unit sits in it within `enclosureRadius`. Below
     * `minSectorsToPin` nothing happens at all, however slow you are; at `fullPinSectors`
     * the meter runs at full rate.
     *
     * Counting cars was the wrong measure. Two heavies leaning on your bumper is two cars
     * and one direction, and it used to end runs while the road ahead was wide open — so
     * losing felt arbitrary, and the actual fantasy, being buried in a scrum and squeezing
     * out of a gap, could never happen because the meter had already run out. Directions
     * are what "no way out" means.
     */
    enclosureRadius: 15,
    enclosureSectors: 8,
    minSectorsToPin: 3,
    /**
     * Wedges at which the meter runs flat out.
     *
     * Six rather than five, to give the ramp a middle. Walls contribute a flat 2 when
     * they count at all, so against a span of only 3-to-5 any wall pin landed straight on
     * the ceiling — surrounded and half-surrounded closed the run out at the same rate.
     * At 6 the three rungs are distinct: 2.50s at four wedges, 2.09s at five, 1.80s only
     * once you are genuinely sealed.
     */
    fullPinSectors: 6,
    /**
     * Walls as blocked directions.
     *
     * Held flat against a building by three cars, the old count said three directions
     * were blocked when the honest answer was eight — the wall was doing most of the
     * work of the arrest and getting none of the credit, so the meter sat still in the
     * exact situation it exists to describe.
     *
     * Counting walls naively is worse than not counting them, which is what the first
     * attempt at this proved: left, right and behind are blocked on any narrow street,
     * and every corner became an arrest. Three guards make it safe, and all three are
     * load-bearing:
     *
     *  - `minPoliceSectors` — cars have to already have hold of you. Geometry only
     *    tightens a pin, it never starts one, so an empty alley is worth nothing.
     *  - `escapeArc` — a way out is a contiguous arc, not a headcount. Blocked on both
     *    sides with the road ahead open is a street, not a box, and stays free however
     *    many wedges that adds up to. At 0, any gap at all is a way out.
     *  - `maxSectors` — capped, so walls can never carry you from below the threshold to
     *    a full pin on their own.
     */
    wallAssist: {
      enabled: true,
      /** Directions cars must already hold before geometry counts for anything. */
      minPoliceSectors: 2,
      /**
       * Widest open arc, in wedges, that still counts as an escape route.
       *
       * Zero: every direction has to be shut before geometry counts for anything. Two
       * wedges is ninety degrees of clear road and you simply drive out of it, and even
       * one — a forty-five degree seam between two obstacles — turned out to be far too
       * generous in play. At 1 the meter went from never running with three cars on you
       * to running at its ceiling, because `maxSectors` adds a flat 2 to a ramp that is
       * only 2 wide, so a wall pin skipped the entire middle of the scale. Requiring a
       * full seal keeps the fix aimed at its actual case — nowhere left to go — instead
       * of at ordinary driving near a building.
       */
      escapeArc: 0,
      /**
       * Most wedges walls may ever contribute.
       *
       * Held at 2 deliberately. It saturates the ramp, but with `escapeArc` at 0 that
       * only happens when the player is genuinely sealed in, which is the one situation
       * that should close a run out fast.
       */
      maxSectors: 2,
    },
    captureSpeed: 17,
    /**
     * Cars inside the radius before the threshold starts rising at all.
     *
     * The scaling has to be a *swarm* rule, not a crowd rule. Applied from the second car
     * it made sections 2 and 3 lethal — five cars is normal traffic down there, and a
     * threshold of 19 u/s meant any brief bog was an arrest. Nothing changes until you are
     * genuinely buried, and then it changes fast.
     */
    captureSpeedMax: 30,
    /**
     * How fast the meter drains when you break free, as a multiple of the fill rate.
     * Above 1 so escaping is always possible; not so far above that a moment of daylight
     * wipes out four seconds of being buried. 1.6: fighting out of a half-built box
     * should visibly rewind the meter, or the fight never feels worth having.
     */
    captureRecovery: 1.6,
    /**
     * Inward acceleration applied to a player outside the ribbon, u/s^2. The physical
     * guarantee behind the wall geometry - see `Game.pushBackOnCourse`.
     */
    offCourseShove: 70,
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
    /**
     * The track that takes over once the run gets deep.
     *
     * The source was ten minutes of 192kbps stereo MP3, fourteen megabytes against a game
     * that is forty-two kilobytes over the wire — the track was ninety-seven percent of
     * the download for something most runs never reach. It is now the first five minutes,
     * mono, AAC at 96kbps: 3.4MB, looped, with a 1.5s fade into the seam so the wrap is
     * not a click.
     *
     * Streamed from a file rather than decoded into a buffer, and living outside the
     * WebAudio graph, which is what lets it keep playing over the BUSTED card after
     * `quietLoops` has shut the engine and sirens down.
     */
    music: {
      enabled: true,
      src: "music/astral-storm.m4a",
      /** Section that starts it. */
      startSection: 9,
      /**
       * Section at which to begin buffering.
       *
       * Not at load: most runs end well before section ten, and making every player pull
       * fourteen megabytes for a track they will never reach is rude. Starting a few
       * sections early leaves the stream time to get ahead of the cue.
       */
      preloadSection: 5,
      /** Loud on purpose — it is meant to sit over the top of the engine, not under it. */
      volume: 0.85,
      /**
       * What the generated layer is scaled to while the track plays.
       *
       * Ducked rather than silenced: the engine, the sirens and the impacts are all
       * feedback you steer by, so they have to stay audible underneath.
       */
      duckGameTo: 0.4,
    },
  },
} as const;

export type Config = typeof CONFIG;
