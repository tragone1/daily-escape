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
import { PICKUPS, type PickupKind } from "./course";
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

  constructor(r: Renderer, terrain: Terrain) {
    for (const def of PICKUPS) {
      const y = terrain.heightAt(def.x, def.z);

      // Same silhouette as the projectile, so what you pick up is obviously what you fire.
      const mesh = buildRocketMesh(r, 2.1, 0.8);
      mesh.position.set(def.x, y + 3.0, def.z);
      mesh.rotation.x = -0.35;

      // A soft ground halo so the pickup is visible over a crest before the mesh is.
      const halo = r.createMesh(
        { kind: "cylinder", diameterTop: CONFIG.pickups.radius * 2, diameterBottom: CONFIG.pickups.radius * 2, height: 0.2, tessellation: 16 },
        { color: [1, 0.5, 0.15], emissive: 1, alpha: 0.22 },
      );
      halo.position.set(def.x, y + 0.25, def.z);

      this.items.push({ kind: def.kind, x: def.x, z: def.z, y, taken: false, mesh, halo });
    }
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
