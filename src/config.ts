/**
 * Every number the game is tuned by, in one object.
 *
 * Split across `config/` by domain because it had grown past two thousand
 * lines - but composed back into a single `CONFIG` here, deliberately. The
 * whole codebase reads `CONFIG.police.box.slots` and the like, and making
 * callers know which file a number lives in would trade a large file for a
 * large refactor and a worse habit.
 */

export * from "./config/vehicleTypes";

import { VEHICLES_CONFIG } from "./config/vehicles";
import { POLICE_CONFIG } from "./config/police";
import { PHYSICS_CONFIG } from "./config/physics";
import { RUN_CONFIG } from "./config/run";

export const CONFIG = {
  /** Display-only conversion so the speedometer reads like a car. */
  speedToKmh: 4.2,
  /** Longest simulated step; protects the sim if the tab stalls. */
  maxTimeStep: 1 / 20,

  ...VEHICLES_CONFIG,
  ...POLICE_CONFIG,
  ...PHYSICS_CONFIG,
  ...RUN_CONFIG,
} as const;

export type Config = typeof CONFIG;
