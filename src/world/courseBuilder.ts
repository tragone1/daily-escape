/**
 * Turns course segments into meshes, colliders and a nav graph.
 *
 * Everything is derived from the spine rather than hand-placed: each segment emits its
 * road ribbon, its themed side walls, its props and its nav nodes. That is what makes a
 * ~2.8 km course maintainable, and it guarantees the route is always fenced in — there is
 * no way to wander off into empty space.
 */

import type { Renderer } from "../gfx/renderer";

import type { StaticCollider } from "../physics/collisionWorld";
import type { CourseSegment, SectionId, Surface, WallStyle } from "./course";
import { buildCourseSegments } from "./course";
import { NavGraph } from "./navGraph";
import { Terrain } from "./terrain";

export interface BuiltWorld {
  segments: CourseSegment[];
  terrain: Terrain;
  colliders: StaticCollider[];
  nav: NavGraph;
  update(elapsed: number): void;
}

/** Deterministic hash so the course is identical on every run. */
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

type Rgb = [number, number, number];

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

const SURFACE_COLOR: Record<Surface, Rgb> = {
  asphalt: [0.17, 0.18, 0.21],
  dirt: [0.32, 0.24, 0.16],
  gravel: [0.28, 0.27, 0.25],
  mud: [0.19, 0.15, 0.11],
  grass: [0.16, 0.26, 0.15],
};

/** Wall look per style: colour, height and how wide a chunk is. */
const WALL_STYLE: Record<
  Exclude<WallStyle, "none">,
  { color: Rgb; minHeight: number; maxHeight: number; chunk: number; thickness: number }
> = {
  building: { color: [0.24, 0.26, 0.33], minHeight: 14, maxHeight: 40, chunk: 16, thickness: 9 },
  barrier: { color: [0.72, 0.58, 0.2], minHeight: 2.2, maxHeight: 2.6, chunk: 12, thickness: 3 },
  rail: { color: [0.5, 0.53, 0.58], minHeight: 2.0, maxHeight: 2.2, chunk: 14, thickness: 2.2 },
  rock: { color: [0.3, 0.28, 0.26], minHeight: 8, maxHeight: 20, chunk: 20, thickness: 8 },
  fence: { color: [0.35, 0.36, 0.32], minHeight: 3.0, maxHeight: 3.4, chunk: 18, thickness: 2.4 },
  // Continuous, but low and far out at the edge of the run-off. Open means "a lot of
  // ground to drive on", not "you can leave the course" — gaps here let players skip
  // whole sections by cutting across country.
  open: { color: [0.5, 0.46, 0.38], minHeight: 3.0, maxHeight: 3.4, chunk: 20, thickness: 2.0 },
};

function addCollider(
  list: StaticCollider[],
  x: number,
  z: number,
  halfLength: number,
  halfWidth: number,
  heading: number,
  topY: number,
): void {
  list.push({
    obb: { x, z, halfLength, halfWidth, heading },
    topY,
    radius: Math.hypot(halfLength, halfWidth),
    occludes: topY > 4.5,
  });
}

export function buildWorld(r: Renderer): BuiltWorld {
  const { segments } = buildCourseSegments();
  const terrain = new Terrain(segments);
  const colliders: StaticCollider[] = [];

  // Palette. Wall variants are shade-shifted copies so a run of chunks is not flat.
  const wallShades: Record<string, Rgb[]> = {};
  for (const [name, style] of Object.entries(WALL_STYLE)) {
    wallShades[name] = [0, 1, 2].map((i) => scale(style.color, 0.82 + i * 0.14));
  }

  // --- Void floor ----------------------------------------------------------
  // Sits below everything so gaps between segments never show through to nothing. Sized
  // from the actual course bounds: a fixed slab was fine for a 2.8 km hand-authored map
  // and is nowhere near a generated one, and where it ran out you could see the road
  // ribbon floating over open space.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const seg of segments) {
    const reach = seg.halfWidth + seg.shoulder + 40;
    minX = Math.min(minX, seg.ax - reach, seg.bx - reach);
    maxX = Math.max(maxX, seg.ax + reach, seg.bx + reach);
    minZ = Math.min(minZ, seg.az - reach, seg.bz - reach);
    maxZ = Math.max(maxZ, seg.az + reach, seg.bz + reach);
  }
  /*
   * Scorched rust rather than near-black.
   *
   * The wasteland is a real decision now — you crawl out there and bank no progress — and
   * a decision you cannot see is not one you get to make. At the old value it was the
   * same colour as the empty background, so the boundary between "road" and "the part
   * that ends your run" was invisible until the HUD told you. Warm and dark reads as
   * ground you should not be on without lighting up the night palette.
   */
  const floor = r.createMesh(
    { kind: "plane", width: maxX - minX, depth: maxZ - minZ },
    { color: [0.12, 0.06, 0.045], emissive: 0.34, isStatic: true },
  );
  floor.position.set((minX + maxX) / 2, -8, (minZ + maxZ) / 2);

  // --- Roads, walls and props ---------------------------------------------
  for (const seg of segments) {
    const midX = (seg.ax + seg.bx) / 2;
    const midZ = (seg.az + seg.bz) / 2;
    const midY = (seg.ay + seg.by) / 2;
    const pitch = -Math.atan(seg.grade);
    // Slope makes the ribbon longer than its ground-plane footprint.
    const ribbonLength = seg.length * Math.hypot(1, seg.grade);

    const road = r.createMesh(
      { kind: "box", width: seg.halfWidth * 2, height: seg.overlay ? 0.62 : 0.5, depth: ribbonLength },
      { color: [...SURFACE_COLOR[seg.surface]], emissive: 0.3, isStatic: true },
    );
    road.position.set(midX, midY + (seg.overlay ? 0.06 : 0), midZ);
    road.rotation.y = seg.heading;
    road.rotation.x = pitch;

    // Centre line on sealed roads only.
    if (seg.surface === "asphalt" && !seg.branch) {
      const dashes = Math.max(1, Math.floor(seg.length / 11));
      for (let i = 0; i < dashes; i++) {
        const t = (i + 0.5) / dashes;
        const dash = r.createMesh(
          { kind: "box", width: 0.5, height: 0.12, depth: 4.5 },
          { color: [0.85, 0.85, 0.8], emissive: 0.7, isStatic: true },
        );
        dash.position.set(
          seg.ax + (seg.bx - seg.ax) * t,
          seg.ay + (seg.by - seg.ay) * t + 0.3,
          seg.az + (seg.bz - seg.az) * t,
        );
        dash.rotation.y = seg.heading;
        dash.rotation.x = pitch;
      }
    }

    // Ramp lip marker so a jump is always telegraphed.
    if (seg.ramp > 0) {
      const lip = r.createMesh(
        { kind: "box", width: seg.halfWidth * 2, height: 0.5, depth: 2.2 },
        { color: [0.95, 0.75, 0.1], emissive: 0.6, isStatic: true },
      );
      lip.position.set(seg.bx, seg.by + 0.4, seg.bz);
      lip.rotation.y = seg.heading;
    }

    // Overlay strips are surface only: they change grip underfoot, nothing else.
    if (seg.overlay) continue;
    // Grass run-off either side, drawn flush with the road so the edge is not a cliff.
    if (seg.shoulder > 0) {
      const apron = r.createMesh(
        { kind: "box", width: (seg.halfWidth + seg.shoulder) * 2, height: 0.34, depth: ribbonLength },
        { color: [...SURFACE_COLOR.grass], emissive: 0.3, isStatic: true },
      );
      apron.position.set(midX, midY - 0.09, midZ);
      apron.rotation.y = seg.heading;
      apron.rotation.x = pitch;
    }

    if (seg.wall !== "none") buildWalls(r, seg, colliders, wallShades, segments);
    if (seg.capEnd) capDeadEnd(r, seg, colliders, wallShades);
    buildProps(r, seg, colliders, segments);
  }

  // No gate: endless mode has no finish to build.

  const nav = NavGraph.fromCourse(segments);

  return {
    segments,
    terrain,
    colliders,
    nav,
    update() {
      // Nothing animates in the static world any more.
    },
  };
}

/**
 * Is this point sitting on some *other* segment's road surface?
 *
 * Walls and props run the whole length of their own segment, which would otherwise seal
 * every junction shut — the wall along one leg's flank lies directly across the leg that
 * turns off it. Skipping anything that lands on another road opens junctions and branch
 * mouths automatically, while leaving the outside of a corner properly fenced.
 */
/**
 * How far back from a connecting road walls are trimmed.
 *
 * Kept tight. Widening this to open junction corners backfired badly: it punched holes
 * the car could drive clean out of, stranding it in walled dead ground. The corner
 * problem is solved by junction aprons (drivable ground) instead, not by deleting more
 * of the fence.
 */
const JUNCTION_CLEARANCE = 1.5;

function onOtherRoad(
  segments: CourseSegment[],
  self: CourseSegment,
  x: number,
  z: number,
  margin: number,
): boolean {
  for (const other of segments) {
    if (other === self) continue;
    const rx = x - other.ax;
    const rz = z - other.az;
    const along = rx * other.dx + rz * other.dz;
    const across = rx * other.dz - rz * other.dx;
    if (along < -margin || along > other.length + margin) continue;
    if (Math.abs(across) <= other.halfWidth + margin) return true;
  }
  return false;
}

/** Fence a segment in with themed chunks on both sides. */
function buildWalls(
  r: Renderer,
  seg: CourseSegment,
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
  segments: CourseSegment[],
): void {
  const style = WALL_STYLE[seg.wall as Exclude<WallStyle, "none">];
  const shades = wallShades[seg.wall];
  const count = Math.max(1, Math.round(seg.length / style.chunk));
  const chunkLen = seg.length / count;
  const pitch = -Math.atan(seg.grade);
  // Right-hand perpendicular of the segment direction.
  const rx = seg.dz;
  const rz = -seg.dx;
  const isOpen = seg.wall === "open";
  // Open sections fence the far edge of the run-off, not the edge of the tarmac.
  const offset = seg.halfWidth + (isOpen ? seg.shoulder : 0) + style.thickness / 2;

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < count; i++) {
      const along = (i + 0.5) * chunkLen;
      const cx = seg.ax + seg.dx * along + rx * offset * side;
      const cz = seg.az + seg.dz * along + rz * offset * side;
      const groundY = seg.ay + seg.grade * along;

      // Never wall off a connecting road. Testing the chunk's ends as well as its centre
      // matters: a chunk whose midpoint clears the junction can still poke across it.
      const halfChunk = chunkLen / 2;
      // The margin is generous on purpose. At a tight 3-way junction a narrow trim left
      // a one-unit sliver of dead ground between the roads, walled on two sides — and a
      // car shoved into it by the police could not get out again. Opening junctions
      // wider costs a little containment and removes a whole class of unfair capture.
      const clear = JUNCTION_CLEARANCE;
      if (
        onOtherRoad(segments, seg, cx, cz, clear) ||
        onOtherRoad(segments, seg, cx + seg.dx * halfChunk, cz + seg.dz * halfChunk, clear) ||
        onOtherRoad(segments, seg, cx - seg.dx * halfChunk, cz - seg.dz * halfChunk, clear)
      ) {
        continue;
      }

      const rnd = hash2(cx, cz);
      const height = style.minHeight + rnd * (style.maxHeight - style.minHeight);

      const mesh = r.createMesh(
        { kind: "box", width: style.thickness, height, depth: chunkLen * 1.02 },
        { color: [...shades[Math.floor(rnd * 997) % shades.length]], emissive: 0.24, isStatic: true },
      );
      mesh.position.set(cx, groundY + height / 2, cz);
      mesh.rotation.y = seg.heading;
      mesh.rotation.x = pitch;

      addCollider(
        colliders,
        cx,
        cz,
        chunkLen / 2,
        style.thickness / 2,
        seg.heading,
        groundY + height,
      );
    }
  }
}

/**
 * Wall across the far end of a dead-end spur.
 *
 * Without it a spur is a hole in the course boundary. With it the alley is a pocket: the
 * police can wait in it, and a player who follows one in has nowhere to go.
 */
function capDeadEnd(
  r: Renderer,
  seg: CourseSegment,
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
): void {
  const style = WALL_STYLE[(seg.wall === "none" ? "fence" : seg.wall) as Exclude<WallStyle, "none">];
  const shades = wallShades[seg.wall === "none" ? "fence" : seg.wall];
  const width = seg.halfWidth * 2 + style.thickness * 2;
  const height = style.minHeight + 0.5;
  const cx = seg.bx + seg.dx * (style.thickness / 2);
  const cz = seg.bz + seg.dz * (style.thickness / 2);

  const mesh = r.createMesh(
    { kind: "box", width, height, depth: style.thickness },
    { color: [...shades[1]], emissive: 0.24, isStatic: true },
  );
  mesh.position.set(cx, seg.by + height / 2, cz);
  mesh.rotation.y = seg.heading;

  addCollider(colliders, cx, cz, style.thickness / 2, width / 2, seg.heading, seg.by + height);

  // A hazard chevron on the cap, so a player who chases a unit in can see the wall coming.
  const sign = r.createMesh(
    { kind: "box", width: width * 0.6, height: 1.1, depth: 0.3 },
    { color: [0.95, 0.55, 0.05], emissive: 0.8, isStatic: true },
  );
  sign.position.set(cx, seg.by + 1.6, cz);
  sign.rotation.y = seg.heading;
}

/**
 * Section-flavoured obstacles inside the road. Placed deterministically from position so
 * the course is identical every run, and always against one kerb so a clean line exists.
 */
function buildProps(
  r: Renderer,
  seg: CourseSegment,
  colliders: StaticCollider[],
  segments: CourseSegment[],
): void {
  const spacing = PROP_SPACING[seg.section];
  // Spurs are narrow and exist to be driven out of at speed; props in one just wedge the
  // ambusher against a wall.
  if (!spacing || seg.ramp > 0 || seg.capEnd) return;

  const count = Math.floor(seg.length / spacing);
  const rx = seg.dz;
  const rz = -seg.dx;

  for (let i = 1; i <= count; i++) {
    const along = (i * seg.length) / (count + 1);
    const rnd = hash2(seg.ax + along, seg.az + along * 1.7);
    if (rnd > 0.62) continue; // leave gaps so the route never fully closes

    // Alternate kerbs; obstacles hug a side so a clean line always exists.
    const side = i % 2 === 0 ? 1 : -1;
    const lateral = (seg.halfWidth - 2.2) * side;
    const cx = seg.ax + seg.dx * along + rx * lateral;
    const cz = seg.az + seg.dz * along + rz * lateral;
    const groundY = seg.ay + seg.grade * along;
    if (onOtherRoad(segments, seg, cx, cz, 2.0)) continue;

    const size = seg.section === "offroad" ? 4.2 : 3.0;
    const height = seg.section === "offroad" ? 3.4 : 2.0;

    const mesh = r.createMesh(
      { kind: "box", width: size, height, depth: size * 1.4 },
      { color: [0.9, 0.42, 0.08], emissive: 0.45, isStatic: true },
    );
    mesh.position.set(cx, groundY + height / 2, cz);
    mesh.rotation.y = seg.heading;

    addCollider(colliders, cx, cz, size * 0.7, size / 2, seg.heading, groundY + height);
  }
}

/** Distance between obstacles per section; sections not listed stay clear. */
const PROP_SPACING: Partial<Record<SectionId, number>> = {
  downtown: 90,
  construction: 46,
  offroad: 70,
  final: 52,
};

