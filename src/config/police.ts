import { policeVehicle } from "./vehicleTypes";
import type { PoliceRole } from "./vehicleTypes";

/**
 * The pursuit.
 *
 * By far the largest group, and deliberately not broken up further - the
 * classes, the formation, the escalation curve and the hazards are tuned
 * against each other, and splitting them would put numbers that must move
 * together in different files.
 */

export const POLICE_CONFIG = {
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
      /**
       * Cop-on-cop pile-up physics: a hard hit between two units spins both out
       * for a beat. The chaos the player asked for by name - juking two chasers
       * into each other MANUFACTURES an opening in the pack. Threshold keeps
       * ordinary pack-rubbing free; rigs and welded units shrug it off.
       */
      /**
       * THE SLIDE-BLOCK, round 10+. An oncoming unit, instead of whiffing past
       * head-on at speed, snaps sideways and hauls the brakes - momentum
       * carries it into a broadside drift across the player's path, ending as
       * a two-second wall you either dodge or eat. Deliberately rationed: one
       * assignment at a time on a cadence that tightens with aggro, a coin
       * flip per opportunity, fast classes only. It should read as a move some
       * cops know, not a script every car runs.
       */
      slideBlock: {
        /** In the arsenal from the first section; skill grows per section. */
        fromSection: 0,
        roles: ["interceptor", "elite", "heavy"] as const,
        /** Assignment cadence: base seconds, tightening per section to a floor. */
        intervalBase: 9,
        intervalPerSection: 0.7,
        intervalMin: 3,
        /** Chance a spotted opportunity is taken: grows per section, capped. */
        chanceBase: 0.6,
        chancePerSection: 0.04,
        chanceMax: 0.95,
        /**
         * The LINE-UP: before snapping sideways the unit steers to converge on
         * the player's predicted lane, so the broadside lands where the player
         * is GOING, not wherever the cop happened to be. More seconds of
         * line-up allowance = more expert placement; grows per section.
         */
        lineupBase: 1.4,
        lineupPerSection: 0.05,
        lineupMax: 2.2,
        /**
         * THE J-HOOK. A mid-road cop that turns to slide carries itself off the
         * player's line with its own turning arc - the broadside lands beside
         * them, already passed. So the approach STAGES first: drive to a lane
         * OFFSET from the player's, then carve back so the arc sweeps the
         * broadside INTO their lane as it snaps, timed by meet-time.
         */
        stageOffset: 5.5,
        /**
         * Each assignment rolls its own snap moment in this band - uniform
         * timing read as synchronized choreography, and a wall that always
         * forms maximally early is a wall the player has maximal time to plan
         * around. Some stand early, some snap almost in the player's face.
         */
        snapMeetMin: 0.85,
        snapMeetMax: 1.9,
        /**
         * The DOUBLE: from this section (0-indexed; 10 = round eleven) two
         * eligible units in the same window slide together, offset to cover
         * complementary lanes - a formed two-car wall, arriving sideways.
         */
        doubleFromSection: 10,
        doubleChance: 0.75,
        doubleLaneOffset: 2.0,
        /** Head-on window, in the player's frame. */
        window: { near: 28, far: 130, lat: 12 },
        minSpeed: 16,
        /**
         * The COMMIT: this long before the snap, the approach stops holding its
         * staging lane and drives straight at the kill point - on boost. All
         * the placement skill lives in the approach now; from the snap on it
         * is pure momentum and the handbrake, no phantom forces.
         */
        commitLead: 0.85,
        /** Hits on a sliding/holding blocker land harder than pack rubbing. */
        contactBoost: 2.2,
        /**
         * MAXED, by request, physics bent on purpose: the snap is a near
         * pivot - full perpendicular in about a quarter second - while the
         * momentum keeps carrying the car forward, so it never has to arc
         * past the player and back up. The assists glide the formed wall
         * onto (and along with) the player's line; they are deliberately
         * about half the strength of the old objectionable carve, and with
         * the fast pivot they read as drift control.
         */
        spinRate: 11,
        brake: 0.7,
        slideTime: 1.25,
        holdTime: 1.6,
        slideAssist: 110,
        holdAssist: 130,
        /**
         * THE DRIFT SLAM - the whole point of the move, per the player: the
         * car snaps near-perpendicular and KEEPS COMING, sliding sideways on
         * its tires with the gas on, arriving broadside-first at speed. This
         * impulse holds the closing speed along the locked travel line against
         * grip scrub while the body rides sideways. A miss decays into the
         * standing wall standoff.
         */
        driftPush: 260,
        /**
         * EXECUTION PERSONALITY. Each slide rolls a pose error off perfect
         * square - quadratic, so small slop is common and the occasional
         * over-rotation ends nearly backwards, or an under-rotation never
         * quite gets sideways. The spread TIGHTENS with the sections: deep
         * crews nail it. The wall stand only recovers 60% of a botched pose.
         */
        execErrMax: 1.5,
        execErrPerSection: 0.1,
        execErrMin: 0.25,
        /** Seconds of player lateral motion the standoff tracking leads by. */
        trackLead: 0.35,
      },
      pileup: {
        /** Relative impact speed below which nothing happens. */
        minImpact: 30,
        /**
         * Crossing angle (radians) below which a hit is pack accordion, not a
         * crash. A chase train rear-ending itself at speed is business as
         * usual; two cars arriving on CROSSING lines is the juke paying off.
         */
        minAngle: 0.7,
        /**
         * Spin-outs only happen within this range of the player. The feature is
         * the JUKE - two chasers baited into each other making an opening you
         * drive through. Distant pack-rubbing spinning the fleet out where
         * nobody sees it just drains the pressure invisibly.
         */
        nearPlayer: 45,
        /** No re-stun within this many seconds of recovering - no carousels. */
        cooldown: 6,
        /** Stun seconds = 0.5 + impact * scale, capped. */
        stunScale: 0.055,
        maxStun: 2.2,
      },
      box: {
        /** Units this close are assigned a station instead of chasing the player. */
        range: 78,
        /** How many stations are handed out at once — one per direction. */
        maxAssigned: 8,
        /**
         * THE CONVERT. Below this player speed the pack switches from chasing
         * to ARRESTING: every free chaser takes a station (the outer ring
         * opens), assignment re-runs continuously, and fresh rear charges are
         * suppressed - a stopped player needs enveloping, not another shove
         * from behind. This is what turns a successful drift-stop into a box
         * instead of an escape.
         */
        /*
         * Raised from 12. This is the speed below which the pack stops chasing
         * and starts arresting - and at twelve it only ever engaged on a player
         * who had already almost stopped, which is the thing it was supposed to
         * cause. Being knocked to twenty now counts.
         */
        convertSpeed: 26,
        convertInterval: 0.25,
        /**
         * The MENACING UPTICK, from section ten on: the arrest reflex fires at
         * higher and higher speeds (a mere slowdown becomes an opportunity),
         * reassignment tightens, and front-seekers burn boost to cut the
         * player off. Solid from round one; frightening deep.
         */
        convertSpeedPerSection: 0.65,
        convertSpeedMax: 34,
        convertIntervalMin: 0.12,
        /**
         * From this section (0-indexed; 9 = round ten) the box fills its pure
         * SIDE stations first: two chasers ride level with the player pinning
         * the lanes before anyone takes a rear station. Fewer cars shoving from
         * behind, more of a formation you have to out-drive - feint one flanker
         * into committing and cut the other way.
         */
        lateSidesFirst: 9,
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
          // THE OUTER RING - manned only while converting a stop into an
          // arrest: a second seal across the escape lanes ahead, wider
          // flanks, a deep back-stop. See convertSpeed below.
          { x: -3.4, z: 12 },
          { x: 3.4, z: 12 },
          { x: 0, z: 15 },
          { x: -8.5, z: 4 },
          { x: 8.5, z: 4 },
          { x: 0, z: -12 },
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
        /**
         * ENCIRCLEMENT.
         *
         * The pack strings out behind a fleeing player, and cars in a line all
         * share one compass bearing - so eight chasers can be a single blocked
         * direction while the arrest needs four. Measured: held at 18 u/s with
         * the full squad on you, the average was 1.5 directions and the meter
         * never moved. No threshold tuning fixes that, because the cars are
         * simply not there; tried, and stacking four dials still peaked the
         * meter at 0.21.
         *
         * So when you are slowed, the nearest units stop chasing and go to the
         * directions nobody is covering. Being slow is what makes it dangerous,
         * not driving hard - keep your speed up and none of this engages.
         */
        encircle: {
          /** At or below this speed the pack starts closing the empty angles. */
          fromSpeed: 26,
          /**
           * Seconds of maximum urgency after the player is hit.
           *
           * Nothing used to react to a hit at all: a head-on or a slide block
           * shaved your speed and the squad carried on as before, which is why
           * taking one did not matter. Now it opens the window in which they
           * try hardest to close the box.
           */
          pounceTime: 4,
          /** How far out an encircling car sits. Inside the pin radius of 15. */
          radius: 11.5,
          /** Most units pulled onto this at once, so the chase does not empty out. */
          maxUnits: 6,
        },

        /**
         * How close a unit must be to its station before it paces off you.
         *
         * Judged on the whole distance, not just the along-road part. That was
         * a real bug with the same shape as the one the comment in policeCar
         * describes: a car given a SIDE station counted as in position the
         * moment it drew level, however far out it was, and its speed was then
         * capped at 1.12x yours - so it trailed alongside forever and never
         * closed. Measured at a held 16 u/s, stations sat 20 to 85 units away
         * and shrank by about 6 u/s over nine seconds.
         */
        inPositionRadius: 5.5,

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
      roles: ["rammer", "heavy", "elite"],
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
       * The block is STATIC. It used to track the player's lateral line at 0.55,
       * which read as the rig driving forward in arcs (a truck cannot strafe) and
       * could slide it back over the opening it was parked to leave. The one hard
       * rule of the class now: the opening chosen at placement survives. `minGap`
       * is that opening - the rig only parks where its broadside still leaves at
       * least this much drivable width, always whole on one side, never split.
       */
      minGap: 4.6,
      /**
       * Parked CENTERED (open sections), the openings flank it on both sides -
       * each can be tighter than the single-opening minimum because the player
       * has two choices. Centre when both fit, hug the kerb only when the road
       * cannot afford them: a rig flat against the wall of a wide section
       * blocks nothing, per playtest.
       */
      centerGap: 3.4,
      /**
       * Same spawn honesty as every other class: a spot must be beyond this
       * euclidean distance OR out of the player's line of sight (and never under
       * 120 regardless). Progress distance alone lies at switchbacks, which is
       * how rigs were popping in thirty units from the player's nose.
       */
      minSpawnDist: 165,
      /**
       * No rigs at all in the three narrowest themes (canyon 7.5, final 8,
       * downtown 9-with-no-shoulder base half-widths): even a legal opening
       * there reads as a wall at speed, per playtest.
       */
      bannedThemes: ["canyon", "downtown", "final"] as const,
      /**
       * Two-rig wall: from this section (0-indexed; 14 = round 15) a second rig
       * may partner a standing block in a band wide enough for both broadsides
       * AND the gap, staggered along-track so it reads as a formed wall.
       */
      wallFromSection: 14,
      wallMaxActive: 2,
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
      /**
       * Drivable width a strip must always leave. A hazard is a line to pick,
       * not a wall: at 5.5 the gap existed but could not be taken at speed.
       */
      minGap: 7.5,
      /**
       * Minimum spacing between two hazards of the SAME kind, along the course.
       * A strip you dodge into a second strip is not a test of skill, it is a
       * corridor with no line through it.
       */
      minSeparation: 150,
      /** The same, between hazards of different kinds - oil right after spikes. */
      minSeparationCross: 65,

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
      cooldownPerSection: 0.05,
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
        roles: ["interceptor", "blocker", "elite"],
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
        // The HEAVY inherits the slick when the rammer musters out.
        roles: ["rammer", "heavy"],
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
      // Every class ambushes from alleys - that is the design.
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
        bladeHalfWidth: 0,
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
     * patrol cars only; by section 5 heavies are routine; past 11 the elites come out.
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
       * and elite. The rig is a specialist and is budgeted
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
      /**
       * 20, reached by section ten (was 30 at eighteen): past that the road got too
       * clogged to drive, per playtest. Depth now escalates through pace, class mix
       * and aggro - speed to +16, charges quicker and more frequent, boxes reformed
       * faster - rather than raw headcount.
       */
      maxActive: 20,
      /**
       * The body count PLATEAUS at 22, which the 1.4/section base ramp reaches
       * naturally at round twelve - by design the game gets harder after that
       * through class upgrades, aggro, and technique, never through more cars:
       * 'you should never lose because there is a pile of cars and no rocket.'
       */
      lateMaxActive: 22,
      /** Section at which each class starts appearing. */
      unlock: {
        patrol: 0,
        rammer: 1,
        interceptor: 2,
        blocker: 3,
        heavy: 4,
        elite: 6,
        // BENCHED again at the player's request - 'the game is fine without
        // it.' All mechanics intact; restore by setting this to an unlock
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
        heavy: 2.8,
        elite: 2.8,
        /*
         * The two armoured classes are deliberately scarce now, down from 3.4 and 2.2.
         *
         * They were the heaviest-weighted things in the table at exactly the point the
         * lighter classes retire, so the late mix became mostly them - and five metres of
         * roadblock in a corridor is not a threat you answer, it is a cork. Rare enough
         * to be an event, and paid for with a broadside that actually hurts.
         */
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
      /**
       * Section after which a class stops being sent at all.
       *
       * This is the escalation that costs nothing at runtime. Headcount has to be capped
       * for frame time, so past the cap the *mix* is the only thing left to turn — and
       * "twenty cars" meaning rigs is a completely
       * different section from "twenty cars" meaning eight patrols and some rammers.
       * Before this, nothing whatsoever changed after section 13.
       */
      /**
       * Aggressive fleet turnover: with the body count flat from round twelve,
       * the mix IS the difficulty curve - light classes muster out early and
       * the deep game is heavies, elites and rigs almost exclusively.
       */
      retire: {
        patrol: 10,
        rammer: 11,
        blocker: 12,
        interceptor: 13,
        heavy: 999,
        elite: 999,
        rig: 999,
      } as Record<PoliceRole, number>,

      /** Extra top speed added to every unit per section, u/s, and its cap. */
      speedPerSection: 0.35,
      /**
       * Extra top speed per section from the tenth section (index 9) on, on top
       * of the flat climb - the late game was reading as no harder than the mid
       * game once the player's own pace ramp kicked in.
       */
      lateSpeedPerSection: 1.8,
      /**
       * 26, reached around round twenty-three. At 20 the cops stopped gaining
       * at round nineteen while the player's own ramp ran to round thirty -
       * the deep game was quietly getting EASIER for eleven straight rounds.
       * A capped heavy runs 70; the player's full-ramp boost peaks 73.5, so
       * the boost escape stays alive by design.
       */
      maxSpeedBonus: 30,
      /**
       * The smarts curve. From the tenth section each section adds this much aggro,
       * capped: charges wind up faster and repeat sooner, and the box around the
       * player is reformed more often. The cap keeps deep-run charge spam readable.
       */
      aggroPerSection: 0.085,
      aggroMax: 1.0,

      /**
       * THE DEEP GAME.
       *
       * Everything above stops climbing by section twenty-six: speed at
       * twenty-six, headcount at fifteen, aggro at twenty-two, and the player's
       * own pace ramp at twenty-one. Beyond that the game was identical
       * forever - survivable at section thirty means survivable at section
       * three hundred, and the course no longer ends to hide it.
       *
       * What keeps climbing here is TECHNIQUE, never headcount and never raw
       * speed. More cars is the thing that made the mid-game read as a maze,
       * and outrunning is already impossible; what is left is how well the
       * squad uses what it has. Each of these approaches a limit rather than
       * running away, so the deep game gets sharper without becoming random.
       */
      deep: {
        /** Where technique starts tightening. Past every other cap. */
        fromSection: 22,
        /**
         * The box closes. Stations pull in by this fraction per section toward
         * `boxTightenMax` - the same formation, held closer, so the gaps a
         * good player threads get narrower rather than more numerous.
         */
        boxTightenPerSection: 0.011,
        boxTightenMax: 0.3,
        /**
         * Blocking moves come round sooner, past the cadence floor the mid
         * game settles at, and never faster than a player can read.
         */
        slideIntervalPerSection: 0.09,
        slideIntervalFloor: 2.8,
        /** And they are executed more precisely, toward a near-perfect line. */
        execErrFloor: 0.015,
        execErrPerSectionDeep: 0.004,
        /** Two blockers at once becomes the norm rather than the exception. */
        doubleChancePerSection: 0.018,
        doubleChanceMax: 0.96,
        /**
         * They commit to the arrest from a higher speed, so a deep-run player
         * has less room to be slow in before the pack stops chasing and starts
         * closing.
         */
        convertSpeedPerSectionDeep: 0.3,
        convertSpeedDeepMax: 34,
      },
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
      rig: 4,
    } as Record<PoliceRole, number>,
  },
} as const;
