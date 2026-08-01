/** Maps keyboard state onto vehicle input. Deliberately thin — the feel lives in Vehicle. */

import type { Input } from "../input";
import type { VehicleInput } from "../vehicle/vehicle";

const FORWARD = ["KeyW", "ArrowUp"];
const BACK = ["KeyS", "ArrowDown"];
const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const BOOST = ["Space"];
// F only. Shift as an alternate fire key surprised everyone who held it to
// steer harder or used the debug section jumps.
const FIRE = ["KeyF"];

export class PlayerController {
  private input: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: false };

  read(keys: Input): VehicleInput {
    const forward = keys.isDown(...FORWARD);
    const back = keys.isDown(...BACK);
    const left = keys.isDown(...LEFT);
    const right = keys.isDown(...RIGHT);

    this.input.throttle = forward ? 1 : 0;
    this.input.brake = back ? 1 : 0;
    this.input.steer = (right ? 1 : 0) - (left ? 1 : 0);
    // Edge-triggered: holding space does not chain boosts.
    this.input.boost = keys.wasPressed(...BOOST);
    return this.input;
  }

  get braking(): boolean {
    return this.input.brake > 0;
  }

  /** Edge-triggered: one press, one rocket. */
  firePressed(keys: Input): boolean {
    return keys.wasPressed(...FIRE);
  }
}
