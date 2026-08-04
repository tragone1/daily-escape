/** The run itself: what you collect, how you lose, and what it sounds like. */

export const RUN_CONFIG = {
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
    /*
     * Three directions, not four.
     *
     * Four of eight world-space wedges is close to unreachable against a
     * player who is still moving: the road is under twenty units wide, so the
     * side wedges at this radius are inside the barriers, and a pursuit
     * naturally occupies one bearing behind you. Measured at a held 18 u/s
     * with the whole squad engaged, the average was under two. At three the
     * curve is the one this is meant to have - stopped is fatal in seven
     * seconds, crawling in fifteen, and anything above about twenty-five is
     * still completely free.
     */
    minSectorsToPin: 2,
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
      /*
       * One wedge, not zero.
       *
       * At zero this never fired at all: it demanded that all eight wedges be
       * blocked before geometry counted, and if all eight are blocked the cars
       * have already won without help. So the case it exists for - held
       * against a building by three cars, which is three wedges and a wall -
       * scored three and drained. One open wedge is still a pin: at fifteen
       * units that is a gap about a car and a half wide, flanked on both
       * sides, which is a thing to be threaded under pressure rather than a
       * road. Two or more remains a way out, so an ordinary narrow street with
       * the way ahead clear still counts for nothing.
       */
      escapeArc: 1,
      /**
       * Most wedges walls may ever contribute.
       *
       * Held at 2 deliberately. It saturates the ramp, but with `escapeArc` at 0 that
       * only happens when the player is genuinely sealed in, which is the one situation
       * that should close a run out fast.
       */
      maxSectors: 2,
    },
    /*
     * Raised from 17. Being knocked to twenty is being slowed, and the meter
     * could not move at all above the old figure however surrounded you were -
     * so the speeds a hit actually leaves you at were exactly the speeds the
     * arrest ignored.
     */
    captureSpeed: 23,
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
    /*
     * Lowered from 1.6. Escaping drained the meter faster than being pinned
     * filled it, so a brief box then a squeeze out erased the whole episode -
     * pressure never accumulated across a bad patch. Breaking free still
     * relieves it, just not retroactively.
     */
    captureRecovery: 1.1,
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
    // Removed by playtest: sections ten-plus sound like every other section now.
    music: {
      enabled: false,
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
