/**
 * A renderer that draws nothing, so the world can be built without a GPU.
 *
 * The course builder needs a renderer only to hand meshes to; every property
 * the tests care about - colliders, segment geometry, lane widths - is computed
 * alongside them. Stubbing it is what lets a hundred courses be built in a Node
 * process, which is the difference between checking the map generator and
 * hoping about it.
 */

import type { Renderer } from "../gfx/renderer";

interface StubMesh {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  parent: unknown;
  isStatic: boolean;
  alpha: number;
  dispose(): void;
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
}

function stubMesh(): StubMesh {
  const position = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      position.x = x;
      position.y = y;
      position.z = z;
    },
  };
  return {
    position,
    rotation: { x: 0, y: 0, z: 0 },
    parent: null,
    isStatic: true,
    alpha: 1,
    dispose() {},
    isEnabled: () => true,
    setEnabled() {},
  };
}

export function stubRenderer(): Renderer {
  return {
    createMesh: () => stubMesh(),
    bake: () => {},
    // Baking is a GPU upload; the tests care about colliders and geometry, both
    // of which exist before any of it happens.
    bakeGrouped: () => {},
    disposeChunk: () => {},
    forgetBaked: () => {},
  } as unknown as Renderer;
}
