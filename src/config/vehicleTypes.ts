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

export const PLAYER_VEHICLE: VehicleParams = {
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
export function policeVehicle(overrides: Partial<VehicleParams>): VehicleParams {
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
