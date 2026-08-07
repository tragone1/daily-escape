/**
 * What a vehicle looks like, distinct from what it is.
 *
 * The physics box stays the physics box; this file dresses it. Each view is a
 * small scene graph built from the car factory's lofted shells - painted body,
 * glass house, dark trim, wheels that steer, spin and ride their own
 * suspension - plus the working lights: headlamps, brake lamps that answer the
 * pedal, and for the police a strobing light bar that pushes a real point
 * light into the renderer so the road flashes red and blue around the car.
 *
 * Nothing in here writes back to the Vehicle. The root follows the simulated
 * transform; every animated part hangs off child nodes, so visual motion can
 * never corrupt the physics state.
 */

import { kitFor, type BodyKit, type CarVariant } from "../gfx/carFactory";
import type { Mesh, Node3D, Renderer } from "../gfx/renderer";

import { CONFIG } from "../config";
import { clamp, damp } from "../math";
import type { Vehicle } from "./vehicle";

export type Rgb = [number, number, number];

export interface CarStyle {
  body: Rgb;
  accent: Rgb;
  police: boolean;
  /** The armoured chassis: charcoal paint and the rig silhouette. */
  heavy?: boolean;
  /** Which body the factory builds. Police roles pass their own. */
  variant?: CarVariant;
}

export const PLAYER_STYLE: CarStyle = {
  body: [1.0, 0.72, 0.08],
  accent: [0.13, 0.13, 0.16],
  police: false,
  variant: "coupe",
};

export function policeStyle(accent: Rgb, heavy = false, variant: CarVariant = "sedan"): CarStyle {
  return {
    body: heavy ? [0.13, 0.14, 0.18] : [0.92, 0.93, 0.96],
    accent,
    police: true,
    heavy,
    variant: heavy ? "rig" : variant,
  };
}

const CHARRED: Rgb = [0.09, 0.08, 0.08];
const GLASS: Rgb = [0.09, 0.12, 0.17];
const TRIM: Rgb = [0.08, 0.08, 0.09];

interface WheelRig {
  /** Steers (front wheels only). */
  steer: Node3D;
  /** Spins about the axle. */
  spin: Node3D;
  /** Rest height of the axle in body space, for suspension offsets. */
  restY: number;
  offsetX: number;
  offsetZ: number;
  /** Smoothed suspension drop. */
  drop: number;
}

export class CarView {
  private root: Node3D;
  private body: Node3D;
  private kit: BodyKit;
  private lightRed?: Mesh;
  private lightBlue?: Mesh;
  private glowRed?: Mesh;
  private glowBlue?: Mesh;
  private brakes: Mesh[] = [];
  private boostFlame: Mesh;
  private shadow: Mesh;
  private wheelSpin = 0;
  private wheels: WheelRig[] = [];
  private paint: Array<{ mesh: Mesh; color: Rgb; emissive: number }> = [];
  private glassMesh: Mesh;
  private wrecked = false;
  private chargeLevel = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  /** One spring for the whole body: compressed by landings, settles fast. */
  private springY = 0;
  private springV = 0;

  constructor(
    private readonly r: Renderer,
    style: CarStyle,
    halfLength: number,
    halfWidth: number,
    _plow = false,
  ) {
    const variant: CarVariant = style.variant ?? (style.heavy ? "rig" : style.police ? "sedan" : "coupe");
    const kit = kitFor(variant, halfLength, halfWidth);
    this.kit = kit;

    this.root = r.createNode();
    this.body = r.createNode();
    this.body.parent = this.root;

    const panel = (mesh: Mesh, color: Rgb): Mesh => {
      this.paint.push({ mesh, color, emissive: mesh.emissive });
      return mesh;
    };

    const shell = r.createMesh(
      { kind: "custom", geometry: kit.body },
      { color: [...style.body], emissive: 0.2, specular: 0.55, gloss: 42 },
    );
    shell.parent = this.body;
    panel(shell, style.body);

    this.glassMesh = r.createMesh(
      { kind: "custom", geometry: kit.glass },
      { color: [...GLASS], emissive: 0.12, specular: 0.95, gloss: 60 },
    );
    this.glassMesh.parent = this.body;

    const trim = r.createMesh(
      { kind: "custom", geometry: kit.trim },
      { color: [...TRIM], emissive: 0.16, specular: 0.12, gloss: 10 },
    );
    trim.parent = this.body;
    panel(trim, TRIM);

    /*
     * An accent: the player's contrast stripe over the hood, a police unit's
     * coloured roof panel. One low slab on the glass roof - it survives every
     * viewing angle and it is how you tell an interceptor from a patrol car
     * at a hundred and fifty units in the mirror.
     */
    if (style.police && style.variant !== "rig") {
      const roofPanel = r.createMesh(
        { kind: "box", width: halfWidth * 1.1, height: 0.05, depth: halfLength * 0.5 },
        { color: [...style.accent], emissive: 0.3, specular: 0.4, gloss: 30 },
      );
      roofPanel.parent = this.body;
      roofPanel.position.set(0, kit.barY - 0.08, kit.barZ);
      panel(roofPanel, style.accent);
      // Accent doors: a thin band along the belt so the livery reads side-on.
      const band = r.createMesh(
        { kind: "box", width: halfWidth * 1.96, height: 0.12, depth: halfLength * 0.72 },
        { color: [...style.accent], emissive: 0.24, specular: 0.3, gloss: 24 },
      );
      band.parent = this.body;
      band.position.set(0, 0.88, 0.1);
      panel(band, style.accent);
    } else if (!style.police) {
      /*
       * The player's trim rides the FLAT parts of the shell - side skirts on
       * the rocker line and a splitter lip under the nose. Anything laid over
       * the hood would have to follow a sloped loft, and a floating slab over
       * a raked deck reads as broken bodywork from every angle that matters.
       */
      for (const sx of [-1, 1]) {
        const skirt = r.createMesh(
          { kind: "box", width: 0.07, height: 0.14, depth: halfLength * 1.1 },
          { color: [...style.accent], emissive: 0.2, specular: 0.4, gloss: 40 },
        );
        skirt.parent = this.body;
        skirt.position.set(sx * (halfWidth * 1.0), kit.floorY + 0.04, 0);
        panel(skirt, style.accent);
      }
      // Fastback spoiler, seated on the actual tail deck.
      const spoiler = r.createMesh(
        { kind: "box", width: halfWidth * 1.72, height: 0.06, depth: 0.34 },
        { color: [...style.accent], emissive: 0.2, specular: 0.4, gloss: 40 },
      );
      spoiler.parent = this.body;
      spoiler.position.set(0, kit.tailTopY + 0.1, -halfLength + 0.2);
      panel(spoiler, style.accent);
      for (const sx of [-1, 1]) {
        const post = r.createMesh(
          { kind: "box", width: 0.08, height: 0.14, depth: 0.1 },
          { color: [...TRIM], emissive: 0.16 },
        );
        post.parent = this.body;
        post.position.set(sx * halfWidth * 0.62, kit.tailTopY + 0.02, -halfLength + 0.2);
      }
    }

    // --- Lights -----------------------------------------------------------
    const [hx, hy, hz] = kit.headlight;
    for (const sx of [-1, 1]) {
      const head = r.createMesh(
        { kind: "box", width: 0.34, height: 0.14, depth: 0.06 },
        { color: [1, 0.95, 0.75], emissive: 0.9, specular: 0.6, gloss: 40, noShadow: true },
      );
      head.parent = this.body;
      head.position.set(sx * hx, hy, hz);
    }
    const [tx, ty, tz] = kit.taillight;
    for (const sx of [-1, 1]) {
      const tail = r.createMesh(
        { kind: "box", width: 0.34, height: 0.13, depth: 0.07 },
        { color: [0.85, 0.06, 0.05], emissive: 0.35, noShadow: true },
      );
      tail.parent = this.body;
      tail.position.set(sx * tx, ty, tz);
      this.brakes.push(tail);
    }

    // --- Wheels -----------------------------------------------------------
    kit.wheels.forEach(([wx, wy, wz], i) => {
      const steer = r.createNode();
      steer.parent = this.body;
      steer.position.set(wx, wy, wz);
      const spin = r.createNode();
      spin.parent = steer;
      spin.rotation.z = Math.PI / 2;
      const tire = r.createMesh(
        { kind: "cylinder", diameterTop: kit.wheelRadius * 2, diameterBottom: kit.wheelRadius * 2, height: kit.wheelWidth, tessellation: 14 },
        { color: [0.07, 0.07, 0.08], emissive: 0.12, specular: 0.08, gloss: 8 },
      );
      tire.parent = spin;
      const rim = r.createMesh(
        { kind: "cylinder", diameterTop: kit.wheelRadius * 1.06, diameterBottom: kit.wheelRadius * 1.06, height: kit.wheelWidth + 0.05, tessellation: 10 },
        { color: [0.5, 0.51, 0.55], emissive: 0.2, specular: 0.85, gloss: 48 },
      );
      rim.parent = spin;
      this.wheels.push({
        steer,
        spin,
        restY: wy,
        offsetX: wx,
        offsetZ: wz,
        drop: 0,
        // Only the front pair steers; the rig's middle and rear axles do not.
        ...(i < 2 ? {} : {}),
      });
    });

    // --- Police light bar -------------------------------------------------
    if (style.police) {
      const barBase = r.createMesh(
        { kind: "box", width: halfWidth * 1.1, height: 0.12, depth: 0.4 },
        { color: [...TRIM], emissive: 0.16 },
      );
      barBase.parent = this.body;
      barBase.position.set(0, kit.barY, kit.barZ);
      panel(barBase, TRIM);

      this.lightRed = r.createMesh(
        { kind: "box", width: halfWidth * 0.5, height: 0.22, depth: 0.34 },
        { color: [1, 0.08, 0.08], emissive: 0.2, noShadow: true },
      );
      this.lightRed.parent = this.body;
      this.lightRed.position.set(-halfWidth * 0.28, kit.barY + 0.16, kit.barZ);

      this.lightBlue = r.createMesh(
        { kind: "box", width: halfWidth * 0.5, height: 0.22, depth: 0.34 },
        { color: [0.12, 0.35, 1], emissive: 0.2, noShadow: true },
      );
      this.lightBlue.parent = this.body;
      this.lightBlue.position.set(halfWidth * 0.28, kit.barY + 0.16, kit.barZ);

      // Coronas: soft translucent shells that swell around the live lamp.
      this.glowRed = r.createMesh(
        { kind: "sphere", diameter: 0.8, segments: 8 },
        { color: [1, 0.15, 0.12], emissive: 1, alpha: 0.0, noShadow: true },
      );
      this.glowRed.parent = this.body;
      this.glowRed.position.set(-halfWidth * 0.28, kit.barY + 0.14, kit.barZ);
      this.glowBlue = r.createMesh(
        { kind: "sphere", diameter: 0.8, segments: 8 },
        { color: [0.2, 0.4, 1], emissive: 1, alpha: 0.0, noShadow: true },
      );
      this.glowBlue.parent = this.body;
      this.glowBlue.position.set(halfWidth * 0.28, kit.barY + 0.14, kit.barZ);
    }

    // --- Boost flame ------------------------------------------------------
    this.boostFlame = r.createMesh(
      { kind: "box", width: halfWidth * 1.1, height: 0.45, depth: 2.4 },
      { color: [0.4, 0.8, 1.0], emissive: 1, alpha: 0.85, noShadow: true },
    );
    this.boostFlame.parent = this.body;
    this.boostFlame.position.set(0, 0.6, -halfLength - 1.3);
    this.boostFlame.setEnabled(false);

    /*
     * The contact blob under the car. The shadow map grounds the car in
     * direct sun; this keeps it grounded in shade and doubles as cheap
     * ambient occlusion under the sills.
     */
    this.shadow = r.createMesh(
      { kind: "plane", width: halfWidth * 2 * 1.4, depth: halfLength * 2 * 1.1 },
      { color: [0, 0, 0], emissive: 0, alpha: 0.2, noShadow: true },
    );
    this.shadow.parent = this.root;
    this.shadow.position.set(0, 0.1, 0);
  }

  /** 0..1: how lit the charge telegraph is. */
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
    /** Terrain height at a world point, for per-wheel suspension. */
    groundAt?: (x: number, z: number) => number,
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

    // The contact shadow stays on the ground when the car leaves it, and lies
    // on the slope by inheriting the root's attitude.
    this.shadow.position.y = groundY - vehicle.y + 0.1;
    // Fade it as the car climbs away: a distant blob under a jump reads wrong.
    this.shadow.alpha = 0.2 / (1 + Math.max(0, vehicle.y - groundY) * 0.25);

    if (this.wrecked) {
      // Sunk to the sills: the player can drive through a hulk, so it has to read as
      // flattened debris rather than a parked car.
      this.body.rotation.z = 0.18;
      this.body.rotation.x = 0.05;
      this.body.position.y = -0.5;
      return;
    }

    // --- Suspension -------------------------------------------------------
    if (vehicle.justLanded) {
      this.springV -= Math.min(3, vehicle.landingImpact * 0.09);
    }
    // A stiff spring with real damping: one bounce and settle.
    this.springV += (-this.springY * 130 - this.springV * 11) * dt;
    this.springY = clamp(this.springY + this.springV * dt, -0.24, 0.18);
    this.body.position.y = this.springY;

    /*
     * Cosmetic lean rides on top of the terrain attitude - and the suspension
     * exaggerates it: the body dips its nose under braking, squats under
     * throttle and rolls out of corners farther than the old rigid box did,
     * because the wheels below are doing the opposite.
     */
    const lean = CONFIG.player.lean;
    this.body.rotation.z = vehicle.leanRoll * lean.roll * 1.35;
    this.body.rotation.x = -vehicle.leanPitch * lean.pitch * 1.5;

    // --- Wheels -----------------------------------------------------------
    const steerAngle = vehicle.steerInput * 0.42;
    this.wheelSpin += (vehicle.forwardSpeed / Math.max(0.3, this.kit.wheelRadius)) * dt;
    const sinH = Math.sin(vehicle.heading);
    const cosH = Math.cos(vehicle.heading);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (i < 2) w.steer.rotation.y = steerAngle;
      w.spin.rotation.x = this.wheelSpin;
      /*
       * Each wheel finds its own ground. The body plane is the simulation's;
       * a wheel over a dip drops toward it, over a crest tucks up into the
       * arch, and the car stops looking like a slab on four fixed casters.
       */
      if (groundAt && !vehicle.airborne) {
        const wx = vehicle.x + cosH * w.offsetX + sinH * w.offsetZ;
        const wz = vehicle.z - sinH * w.offsetX + cosH * w.offsetZ;
        const dropTarget = clamp(groundAt(wx, wz) - groundY, -0.3, 0.22);
        w.drop += (dropTarget - w.drop) * damp(16, dt);
      } else {
        w.drop += (0 - w.drop) * damp(6, dt);
      }
      w.steer.position.y = w.restY + w.drop - this.springY * 0.6;
    }

    // --- Boost flame ------------------------------------------------------
    const flame = clamp(vehicle.boostTime / CONFIG.player.boost.duration, 0, 1);
    this.boostFlame.scaling.set(
      0.6 + flame * 0.5,
      0.6 + flame * 0.5,
      Math.max(0.001, flame * (0.7 + Math.sin(elapsed * 40) * 0.15)),
    );
    this.boostFlame.setEnabled(flame > 0.01);

    // --- Brake lamps ------------------------------------------------------
    const glow = braking || vehicle.forwardSpeed < -0.5 ? 1.1 : 0.05;
    for (const b of this.brakes) {
      b.tint[3] += (glow - b.tint[3]) * damp(14, dt);
    }

    // --- Police light bar -------------------------------------------------
    if (this.lightRed && this.lightBlue) {
      if (disabled) {
        this.lightRed.tint[3] = 0;
        this.lightBlue.tint[3] = 0;
        if (this.glowRed) this.glowRed.alpha = 0;
        if (this.glowBlue) this.glowBlue.alpha = 0;
      } else if (this.chargeLevel > 0) {
        const glowUp = 1.4 + this.chargeLevel * 2.6;
        this.lightRed.tint[3] = glowUp;
        this.lightBlue.tint[3] = glowUp;
        if (this.glowRed) this.glowRed.alpha = 0.2;
        if (this.glowBlue) this.glowBlue.alpha = 0.2;
      } else {
        const phase = Math.sin(elapsed * 13) > 0;
        this.lightRed.tint[3] = phase ? 1.6 : 0;
        this.lightBlue.tint[3] = phase ? 0 : 1.6;
        if (this.glowRed) this.glowRed.alpha = phase ? 0.22 : 0;
        if (this.glowBlue) this.glowBlue.alpha = phase ? 0 : 0.22;
        /*
         * The lamp is also a light. One point light per unit, in the colour
         * of whichever lamp is live, and the road, the walls and the cars
         * around it catch the flash - which is most of what makes a pack of
         * pursuers at dusk read as a police chase and not as scenery.
         */
        if (this.root.isEnabled()) {
          const strength = 1.1;
          this.r.lights.push({
            x: vehicle.x - sinH * 0.2,
            y: groundY + this.kit.barY + 0.6,
            z: vehicle.z - cosH * 0.2,
            radius: 14,
            r: (phase ? 1.0 : 0.15) * strength,
            g: 0.12 * strength,
            b: (phase ? 0.1 : 1.0) * strength,
          });
        }
      }
    }
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }

  setWrecked(on: boolean): void {
    this.wrecked = on;
    for (const p of this.paint) {
      p.mesh.color = on ? [...CHARRED] : [...p.color];
      p.mesh.emissive = on ? 0.05 : p.emissive;
      p.mesh.specular = on ? 0.05 : p.mesh.specular;
    }
    this.glassMesh.emissive = on ? 0.02 : 0.12;
    if (this.lightRed) this.lightRed.tint[3] = 0;
    if (this.lightBlue) this.lightBlue.tint[3] = 0;
    if (this.glowRed) this.glowRed.alpha = 0;
    if (this.glowBlue) this.glowBlue.alpha = 0;
    this.boostFlame.setEnabled(false);
    if (!on) {
      this.body.rotation.z = 0;
      this.body.rotation.x = 0;
      this.body.position.y = 0;
    }
  }
}
