/**
 * Visual representation of a car: primitive boxes only, no external assets.
 *
 * The mesh hierarchy separates driving state from cosmetics —
 *   root   : world position, heading and terrain attitude (from the simulation)
 *     body : roll/pitch lean (purely visual, never feeds back into physics)
 * which is what keeps the car from ever appearing to flip.
 */

import { CONFIG } from "../config";
import { clamp, damp } from "../math";
import { Node3D, type Mesh, type Renderer } from "../gfx/renderer";
import type { Vehicle } from "./vehicle";

export type Rgb = [number, number, number];

export interface CarStyle {
  body: Rgb;
  accent: Rgb;
  /** Adds a flashing light bar. */
  police: boolean;
  /** Taller cab, roof rack and a bull bar — the armoured chassis. */
  heavy?: boolean;
}

export const PLAYER_STYLE: CarStyle = {
  body: [1.0, 0.78, 0.12],
  accent: [0.15, 0.15, 0.18],
  police: false,
};

export function policeStyle(accent: Rgb, heavy = false): CarStyle {
  return {
    body: heavy ? [0.14, 0.15, 0.2] : [0.9, 0.92, 0.96],
    accent,
    police: true,
    heavy,
  };
}

const CHARRED: Rgb = [0.09, 0.08, 0.08];

export class CarView {
  readonly root: Node3D;
  private body: Node3D;
  private frontAxle: Node3D;
  private lightRed?: Mesh;
  private lightBlue?: Mesh;
  private brake: Mesh;
  private boostFlame: Mesh;
  private shadow: Mesh;
  private wheelSpin = 0;
  private wheels: Mesh[] = [];
  /** Painted panels, remembered so a wreck can be charred and later restored. */
  private paint: Array<{ mesh: Mesh; color: Rgb; emissive: number }> = [];
  private wrecked = false;
  /** 0..1 charge telegraph, drives the solid-lights warning. */
  private chargeLevel = 0;
  private groundPitch = 0;
  private groundRoll = 0;

  constructor(r: Renderer, style: CarStyle, halfLength: number, halfWidth: number) {
    this.root = r.createNode();
    this.body = r.createNode();
    this.body.parent = this.root;

    const len = halfLength * 2;
    const wid = halfWidth * 2;

    const panel = (mesh: Mesh, color: Rgb) => {
      this.paint.push({ mesh, color, emissive: mesh.emissive });
      return mesh;
    };

    const chassis = r.createMesh(
      { kind: "box", width: wid, height: 0.85, depth: len },
      { color: [...style.body], emissive: 0.28 },
    );
    chassis.position.set(0, 0.78, 0);
    chassis.parent = this.body;
    panel(chassis, style.body);

    // A contrasting stripe reads as direction at a glance from the chase camera.
    const stripe = r.createMesh(
      { kind: "box", width: wid * 0.36, height: 0.9, depth: len * 0.98 },
      { color: [...style.accent], emissive: 0.25 },
    );
    stripe.position.set(0, 0.79, 0);
    stripe.parent = this.body;
    panel(stripe, style.accent);

    const cabin = r.createMesh(
      { kind: "box", width: wid * 0.82, height: 0.62, depth: len * 0.44 },
      { color: [0.1, 0.14, 0.2], emissive: 0.35 },
    );
    cabin.position.set(0, 1.44, -0.15);
    cabin.parent = this.body;
    panel(cabin, [0.1, 0.14, 0.2]);

    // Nose wedge so the front is unmistakable.
    const nose = r.createMesh(
      { kind: "box", width: wid * 0.9, height: 0.4, depth: 0.5 },
      { color: [...style.accent], emissive: 0.25 },
    );
    nose.position.set(0, 1.16, halfLength - 0.3);
    nose.parent = this.body;
    panel(nose, style.accent);

    this.brake = r.createMesh(
      { kind: "box", width: wid * 0.86, height: 0.32, depth: 0.24 },
      { color: [0.6, 0.06, 0.06], emissive: 0.3 },
    );
    this.brake.position.set(0, 0.95, -halfLength - 0.05);
    this.brake.parent = this.body;

    // Boost flame — scaled by boost time rather than toggled, so it eases out.
    this.boostFlame = r.createMesh(
      { kind: "box", width: wid * 0.55, height: 0.45, depth: 2.4 },
      { color: [0.4, 0.8, 1.0], emissive: 1, alpha: 0.85 },
    );
    this.boostFlame.position.set(0, 0.75, -halfLength - 1.3);
    this.boostFlame.parent = this.body;
    this.boostFlame.setEnabled(false);

    // Wheels. The front pair sits on a steering node so the wheels visibly turn.
    this.frontAxle = r.createNode();
    this.frontAxle.position.set(0, 0, halfLength * 0.62);
    this.frontAxle.parent = this.body;

    const wheel = (px: number, pz: number, parent: Node3D) => {
      const w = r.createMesh(
        { kind: "cylinder", diameterTop: 0.86, diameterBottom: 0.86, height: 0.42, tessellation: 8 },
        { color: [0.08, 0.08, 0.09], emissive: 0.1 },
      );
      w.rotation.z = Math.PI / 2;
      w.position.set(px, 0.43, pz);
      w.parent = parent;
      this.wheels.push(w);
    };
    wheel(halfWidth, 0, this.frontAxle);
    wheel(-halfWidth, 0, this.frontAxle);
    wheel(halfWidth, -halfLength * 0.62, this.body);
    wheel(-halfWidth, -halfLength * 0.62, this.body);

    // Fake contact shadow — much cheaper than a shadow map and reads fine top-down.
    this.shadow = r.createMesh(
      { kind: "plane", width: wid * 1.5, depth: len * 1.15 },
      { color: [0, 0, 0], emissive: 0, alpha: 0.34 },
    );
    this.shadow.position.set(0, 0.12, 0);
    this.shadow.parent = this.root;

    if (style.heavy) {
      // Bull bar and roof rack: reads as "heavier than you" from the chase camera.
      const bar = r.createMesh(
        { kind: "box", width: wid * 1.06, height: 1.3, depth: 0.7 },
        { color: [...style.accent], emissive: 0.25 },
      );
      bar.position.set(0, 1.0, halfLength + 0.2);
      bar.parent = this.body;
      panel(bar, style.accent);

      for (const side of [-1, 1]) {
        const post = r.createMesh(
          { kind: "box", width: 0.28, height: 1.5, depth: 0.28 },
          { color: [...style.accent], emissive: 0.25 },
        );
        post.position.set(side * wid * 0.36, 1.5, halfLength + 0.2);
        post.parent = this.body;
        panel(post, style.accent);
      }

      const rack = r.createMesh(
        { kind: "box", width: wid * 0.92, height: 0.22, depth: len * 0.5 },
        { color: [...style.accent], emissive: 0.25 },
      );
      rack.position.set(0, 2.0, -0.4);
      rack.parent = this.body;
      panel(rack, style.accent);
    }

    if (style.police) {
      const bar = r.createMesh(
        { kind: "box", width: wid * 0.9, height: 0.16, depth: 0.4 },
        { color: [...style.accent], emissive: 0.25 },
      );
      bar.position.set(0, 1.78, -0.15);
      bar.parent = this.body;
      panel(bar, style.accent);

      this.lightRed = r.createMesh(
        { kind: "box", width: wid * 0.4, height: 0.34, depth: 0.42 },
        { color: [1, 0.1, 0.1], emissive: 0.2 },
      );
      this.lightRed.position.set(-wid * 0.24, 1.92, -0.15);
      this.lightRed.parent = this.body;

      this.lightBlue = r.createMesh(
        { kind: "box", width: wid * 0.4, height: 0.34, depth: 0.42 },
        { color: [0.15, 0.4, 1], emissive: 0.2 },
      );
      this.lightBlue.position.set(wid * 0.24, 1.92, -0.15);
      this.lightBlue.parent = this.body;
    }
  }

  /**
   * Telegraph an incoming charge. The strobe stops and both lights go hard on, which is a
   * different signal from the usual alternating flash and readable in peripheral vision —
   * you should be able to tell one is winding up without looking straight at it.
   */
  setCharge(level: number): void {
    this.chargeLevel = clamp(level, 0, 1);
  }

  sync(
    vehicle: Vehicle,
    dt: number,
    elapsed: number,
    braking: boolean,
    disabled = false,
    groundY = 0,
  ): void {
    // Elevation is authoritative from the simulation; the mesh follows it exactly.
    this.root.position.set(vehicle.x, vehicle.y, vehicle.z);
    this.root.rotation.y = vehicle.heading;

    /*
     * Sit the chassis ON the slope. Without this the body stays level while the road
     * tilts underneath it, so on any gradient the car visibly sinks into the surface at
     * one end. Airborne, the attitude eases back to level.
     */
    const targetPitch = vehicle.airborne ? 0 : -Math.atan(vehicle.climb);
    const targetRoll = vehicle.airborne ? 0 : Math.atan(vehicle.bank);
    const kGround = damp(9, dt);
    this.groundPitch += (targetPitch - this.groundPitch) * kGround;
    this.groundRoll += (targetRoll - this.groundRoll) * kGround;
    this.root.rotation.x = this.groundPitch;
    this.root.rotation.z = this.groundRoll;

    // The contact shadow stays on the ground when the car leaves it, and stays flat.
    this.shadow.position.y = groundY - vehicle.y + 0.12;
    this.shadow.rotation.x = -this.groundPitch;
    this.shadow.rotation.z = -this.groundRoll;

    if (this.wrecked) {
      // Sunk to the sills: the player can drive through a hulk, so it has to read as
      // flattened debris rather than a parked car.
      this.body.rotation.z = 0.18;
      this.body.rotation.x = 0.05;
      this.body.position.y = -0.5;
      return;
    }

    // Cosmetic lean rides on top of the terrain attitude.
    const lean = CONFIG.player.lean;
    this.body.rotation.z = vehicle.leanRoll * lean.roll;
    this.body.rotation.x = -vehicle.leanPitch * lean.pitch;

    this.frontAxle.rotation.y = vehicle.steerInput * 0.45;

    // Wheel spin gives a speed cue even when the road markings blur past.
    this.wheelSpin += (vehicle.forwardSpeed / 0.43) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;

    const flame = clamp(vehicle.boostTime / CONFIG.player.boost.duration, 0, 1);
    this.boostFlame.scaling.set(
      0.6 + flame * 0.5,
      0.6 + flame * 0.5,
      Math.max(0.001, flame * (0.7 + Math.sin(elapsed * 40) * 0.15)),
    );
    this.boostFlame.setEnabled(flame > 0.01);

    const glow = braking || vehicle.forwardSpeed < -0.5 ? 0.9 : 0.05;
    this.brake.tint[3] += (glow - this.brake.tint[3]) * damp(14, dt);

    if (this.lightRed && this.lightBlue) {
      if (disabled) {
        // Lights out while the crew is picking itself up.
        this.lightRed.tint[3] = 0;
        this.lightBlue.tint[3] = 0;
      } else if (this.chargeLevel > 0) {
        // Winding up: both lamps solid, brightening as it commits.
        const glowUp = 1.4 + this.chargeLevel * 2.6;
        this.lightRed.tint[3] = glowUp;
        this.lightBlue.tint[3] = glowUp;
      } else {
        // Alternating strobe at ~4 Hz.
        const phase = Math.sin(elapsed * 13) > 0;
        this.lightRed.tint[3] = phase ? 1.4 : 0;
        this.lightBlue.tint[3] = phase ? 0 : 1.4;
      }
    }
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }

  /** Char the paint, kill the lights and slump the body onto its springs. */
  setWrecked(on: boolean): void {
    this.wrecked = on;
    for (const p of this.paint) {
      p.mesh.color = on ? [...CHARRED] : [...p.color];
      p.mesh.emissive = on ? 0.05 : p.emissive;
    }
    if (this.lightRed && this.lightBlue) {
      this.lightRed.tint[3] = 0;
      this.lightBlue.tint[3] = 0;
    }
    this.boostFlame.setEnabled(false);
    if (!on) {
      this.body.rotation.z = 0;
      this.body.rotation.x = 0;
      this.body.position.y = 0;
    }
  }
}
