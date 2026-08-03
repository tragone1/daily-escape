/**
 * Route pickups: rocket ammunition.
 *
 * Boost is cooldown-gated, so there is nothing to refill — these are the only pickups.
 * Every one sits on a slower branch, which keeps them a decision rather than free value:
 * more firepower always costs time. Collected once per run.
 */

import { Node3D, type Mesh, type Renderer } from "../gfx/renderer";

import { CONFIG } from "../config";
import type { Vehicle } from "../vehicle/vehicle";
import { buildRocketMesh } from "../weapons/rocketMesh";
import type { PickupKind } from "./course";
import type { Terrain } from "./terrain";

interface Pickup {
  kind: PickupKind;
  x: number;
  z: number;
  y: number;
  taken: boolean;
  mesh: Node3D;
  halo: Mesh;
}

export interface PickupEvent {
  kind: PickupKind;
  x: number;
  z: number;
}

export class PickupSystem {
  private items: Pickup[] = [];

  /**
   * Where the next pickups go, in progress along the spine.
   *
   * Positioned by DISTANCE rather than by leg, because the leg list is the
   * coarse control points the road is splined through - the spline can run
   * tens of units from a control point, and further on a bend. Placing by
   * progress puts a pickup on the road the player actually drives.
   *
   * Spacing is regular and endless, so ammunition keeps appearing for as long
   * as a run lasts. It used to come from a fixed list built from the opening
   * course, which meant none existed at all beyond it.
   */
  private static readonly SPACING = 620;
  private static readonly FIRST = 520;

  /** Progress of the furthest pickup placed, so extensions carry on from there. */
  private placedTo = 0;

  /**
   * Put a pickup on the road at `progress`, offset to one side.
   *
   * Off the middle so it costs a line to collect, and never nearer the kerb
   * than a car's width - a pickup you cannot reach without leaving the road is
   * a question about the geometry rather than about the risk.
   */
  private place(r: Renderer, terrain: Terrain, progress: number, side: number, centred: boolean): void {
    const spine = terrain.segments.filter((sg) => !sg.branch && !sg.overlay);
    let acc = 0;
    for (const seg of spine) {
      if (progress > acc + seg.length) {
        acc += seg.length;
        continue;
      }
      const along = progress - acc;
      const limit = Math.max(0, seg.halfWidth - 2.2);
      const lateral = centred ? 0 : Math.min(limit, seg.halfWidth * 0.55) * side;
      const x = seg.ax + seg.dx * along + seg.dz * lateral;
      const z = seg.az + seg.dz * along - seg.dx * lateral;
      // Height sampled AT the final point, not at the one it started from -
      // which is what left one half buried in the side of an uphill ramp.
      const y = terrain.heightAt(x, z);

      const mesh = buildRocketMesh(r, 2.1, 0.8);
      mesh.position.set(x, y + 3.0, z);
      mesh.rotation.x = -0.35;

      const halo = r.createMesh(
        { kind: "cylinder", diameterTop: CONFIG.pickups.radius * 2, diameterBottom: CONFIG.pickups.radius * 2, height: 0.2, tessellation: 16 },
        { color: [1, 0.5, 0.15], emissive: 1, alpha: 0.22 },
      );
      halo.position.set(x, y + 0.25, z);

      this.items.push({ kind: "rocket", x, z, y, taken: false, mesh, halo });
      return;
    }
  }

  /**
   * Place pickups on however much road now exists.
   *
   * Called again whenever the world grows. Only ever adds ahead of what it has
   * already placed, so nothing is duplicated and nothing already collected
   * comes back.
   */
  extendTo(r: Renderer, terrain: Terrain): void {
    const total = terrain.mainLength;
    let n = Math.max(0, Math.floor((this.placedTo - PickupSystem.FIRST) / PickupSystem.SPACING) + 1);
    for (;;) {
      const progress = PickupSystem.FIRST + n * PickupSystem.SPACING;
      // Leave a margin: the last stretch of built road may still be extending.
      if (progress > total - 60) break;
      // Every third one sits on the racing line; the rest ask for a small detour.
      this.place(r, terrain, progress, n % 2 === 0 ? 1 : -1, n % 3 === 0);
      this.placedTo = progress;
      n++;
    }
  }

  constructor(r: Renderer, terrain: Terrain) {
    this.extendTo(r, terrain);
  }

  /** Every pickup placed so far. For tests and diagnostics. */
  all(): ReadonlyArray<{ x: number; z: number; y: number; taken: boolean }> {
    return this.items;
  }

  reset(): void {
    for (const it of this.items) {
      it.taken = false;
      it.mesh.setEnabled(true);
      it.halo.setEnabled(true);
    }
  }

  /** Animate, and return everything the player drove through this frame. */
  update(dt: number, elapsed: number, player: Vehicle): PickupEvent[] {
    const cfg = CONFIG.pickups;
    const collected: PickupEvent[] = [];
    const r2 = cfg.radius * cfg.radius;

    for (const it of this.items) {
      if (it.taken) continue;

      it.mesh.rotation.y += cfg.spinSpeed * dt;
      it.mesh.position.y = it.y + 3.0 + Math.sin(elapsed * 2.6 + it.x * 0.1) * cfg.bobHeight;

      const dx = player.x - it.x;
      const dz = player.z - it.z;
      if (dx * dx + dz * dz > r2) continue;
      // Ignore pickups passed over mid-jump; you have to actually drive through them.
      if (player.y - it.y > 3.5) continue;

      it.taken = true;
      it.mesh.setEnabled(false);
      it.halo.setEnabled(false);
      collected.push({ kind: it.kind, x: it.x, z: it.z });
    }

    return collected;
  }
}
