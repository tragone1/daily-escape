/** Contact, and the camera that watches it. */

export const PHYSICS_CONFIG = {
  collision: {
    /** Velocity kept along the impact normal after a hit (0 = dead stop, 1 = full bounce). */
    restitution: 0.28,
    /** Fraction of tangential (sliding) speed kept when scraping a wall. */
    wallFriction: 0.82,
    /**
     * Tangential retention for a GRAZE - a car running along a barrier keeps
     * essentially all its speed. Wall contact should be smooth enough to lean
     * on through a corner, not a thing that stops you dead on a seam.
     */
    wallFrictionGrazing: 0.995,
    /** Nudge along the wall when a car has been stopped dead by one. */
    wallSlideAssist: 0.62,
    /** Below this speed the slide assist applies, fading in as speed drops. */
    wallSlideAssistSpeed: 18,
    /**
     * Spread between contact normals above which this is a real CORNER rather
     * than a flat wall. A car wedged in a genuine corner stays there; one
     * caught on a flat run does not.
     */
    wallCornerAngle: 0.7,
    /**
     * Seconds after a car-on-car shove during which the wall assists stand
     * down. Being held against a barrier by the police is an arrest, not the
     * geometry catching you, and the assist must never undo it.
     */
    wallAssistHoldOff: 0.6,
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
     * Low, and this matters more than it sounds. A heavy charging into a scrum used
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
} as const;
