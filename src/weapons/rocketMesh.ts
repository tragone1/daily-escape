/**
 * The rocket silhouette, shared by the projectile and the ammo pickup.
 *
 * Built from primitives like everything else, but shaped enough to read as a missile at
 * speed: tapered nose, banded body, four fins and a burner. The projectile is large on
 * purpose - it is a one-or-two-per-run superpower, so it should look like one.
 *
 * Returns the body node; its local +Z is forward, so callers set `rotation.y` to the
 * heading exactly as they would for a car.
 */

import { Node3D, type Renderer } from "../gfx/renderer";

export function buildRocketMesh(r: Renderer, halfLength: number, halfWidth: number): Node3D {
  const root = r.createNode();

  const body = r.createMesh(
    { kind: "cylinder", diameterTop: halfWidth * 2, diameterBottom: halfWidth * 2, height: halfLength * 1.5, tessellation: 10 },
    { color: [0.93, 0.93, 0.95], emissive: 0.85 },
  );
  body.rotation.x = Math.PI / 2;
  body.parent = root;

  const nose = r.createMesh(
    { kind: "cylinder", diameterTop: 0.001, diameterBottom: halfWidth * 2, height: halfLength * 0.7, tessellation: 10 },
    { color: [1, 0.32, 0.1], emissive: 0.9 },
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0, halfLength * 1.1);
  nose.parent = root;

  // Warning band, so the thing reads as ordnance rather than a pipe.
  const band = r.createMesh(
    { kind: "cylinder", diameterTop: halfWidth * 2.12, diameterBottom: halfWidth * 2.12, height: halfLength * 0.26, tessellation: 10 },
    { color: [1, 0.32, 0.1], emissive: 0.9 },
  );
  band.rotation.x = Math.PI / 2;
  band.position.set(0, 0, halfLength * 0.3);
  band.parent = root;

  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const fin = r.createMesh(
      { kind: "box", width: halfWidth * 0.22, height: halfWidth * 1.5, depth: halfLength * 0.6 },
      { color: [0.8, 0.16, 0.06], emissive: 0.8 },
    );
    fin.position.set(Math.sin(angle) * halfWidth * 0.75, Math.cos(angle) * halfWidth * 0.75, -halfLength * 0.55);
    fin.rotation.z = angle;
    fin.parent = root;
  }

  const burner = r.createMesh(
    { kind: "cylinder", diameterTop: halfWidth * 1.7, diameterBottom: halfWidth * 0.6, height: halfLength * 0.9, tessellation: 8 },
    { color: [1, 0.85, 0.35], emissive: 1, alpha: 0.9 },
  );
  burner.rotation.x = -Math.PI / 2;
  burner.position.set(0, 0, -halfLength * 1.2);
  burner.parent = root;

  return root;
}
