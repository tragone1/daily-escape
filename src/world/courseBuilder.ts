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

/**
 * Thickness of the road slab and the grass apron.
 *
 * Both are positioned so their *top* face is the ground plane the terrain reports, which
 * is the only arrangement where the car looks like it is standing on the road.
 */
const ROAD_THICKNESS = 0.5;
const APRON_THICKNESS = 0.34;

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

/**
 * Per-section tint on the road surface.
 *
 * Two sections built from the same surface should still not look like the same section.
 * A cool grey-blue city and a warm sodium-lit industrial estate are both asphalt.
 */
const SECTION_TINT: Partial<Record<SectionId, Rgb>> = {
  downtown: [0.92, 0.96, 1.12],
  canyon: [1.15, 1.0, 0.86],
  industrial: [1.18, 1.06, 0.82],
  hills: [1.0, 1.02, 1.0],
  final: [0.9, 0.9, 0.96],
};

/** Wall look per style: colour, height and how wide a chunk is. */
const WALL_STYLE: Record<
  Exclude<WallStyle, "none">,
  { color: Rgb; minHeight: number; maxHeight: number; chunk: number; thickness: number }
> = {
  building: { color: [0.24, 0.26, 0.33], minHeight: 14, maxHeight: 40, chunk: 16, thickness: 9 },
  barrier: { color: [0.76, 0.6, 0.18], minHeight: 2.4, maxHeight: 3.0, chunk: 10, thickness: 3 },
  rail: { color: [0.5, 0.53, 0.58], minHeight: 2.0, maxHeight: 2.2, chunk: 14, thickness: 2.2 },
  // Canyon walls: tall, chunky and irregular, so the section reads as cut through rock.
  rock: { color: [0.34, 0.29, 0.24], minHeight: 12, maxHeight: 30, chunk: 13, thickness: 10 },
  fence: { color: [0.42, 0.44, 0.38], minHeight: 4.0, maxHeight: 5.2, chunk: 12, thickness: 2.4 },
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

    const tint = SECTION_TINT[seg.section] ?? [1, 1, 1];
    const base = SURFACE_COLOR[seg.surface];
    const road = r.createMesh(
      { kind: "box", width: seg.halfWidth * 2, height: ROAD_THICKNESS, depth: ribbonLength },
      {
        color: [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]],
        emissive: 0.3,
        isStatic: true,
      },
    );
    /*
     * Drop the slab so its *top face* lands on the height the terrain reports.
     *
     * `heightAt` returns the centre line of the segment, and the ribbon is a half-unit
     * thick box centred on that, so the surface you can see was a quarter of a unit above
     * the surface the simulation puts the car on. The car sits correctly and looks sunk:
     * about half a wheel, everywhere, all the time.
     */
    road.position.set(midX, midY - ROAD_THICKNESS / 2 + (seg.overlay ? 0.09 : 0), midZ);
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

    /*
     * A skirt hanging under the ribbon.
     *
     * Consecutive legs meet at an angle and at different heights, and the ribbon is a
     * flat slab, so every joint and every ramp landing left a vertical slot you could see
     * straight through to the void. Dropping a deep apron under each piece fills all of
     * them at once, and reads as the ground the road is cut into.
     */
    if (!seg.overlay) {
      const skirtDepth = 14;
      const skirt = r.createMesh(
        { kind: "box", width: (seg.halfWidth + seg.shoulder) * 2 + 1.5, height: skirtDepth, depth: ribbonLength * 1.04 },
        { color: [0.11, 0.1, 0.1], emissive: 0.18, isStatic: true },
      );
      skirt.position.set(midX, midY - skirtDepth / 2 - ROAD_THICKNESS / 2, midZ);
      skirt.rotation.y = seg.heading;
      skirt.rotation.x = pitch;
    }

    // Overlay strips are surface only: they change grip underfoot, nothing else.
    if (seg.overlay) continue;
    // Grass run-off either side, drawn flush with the road so the edge is not a cliff.
    if (seg.shoulder > 0) {
      const apron = r.createMesh(
        { kind: "box", width: (seg.halfWidth + seg.shoulder) * 2, height: APRON_THICKNESS, depth: ribbonLength },
        { color: [...SURFACE_COLOR.grass], emissive: 0.3, isStatic: true },
      );
      // Flush with the tarmac, a hair below so the kerb line still reads.
      apron.position.set(midX, midY - APRON_THICKNESS / 2 - 0.04, midZ);
      apron.rotation.y = seg.heading;
      apron.rotation.x = pitch;
    }

    if (seg.wall !== "none") buildWalls(r, seg, colliders, wallShades, segments);
    if (seg.capEnd) capDeadEnd(r, seg, colliders, wallShades);
    buildProps(r, seg, colliders, segments);
  }

  buildJunctionCaps(r, segments, colliders, wallShades);
  buildJointPatches(r, segments);

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
  /*
   * The wall always sits at the far edge of the run-off.
   *
   * It used to sit at the edge of the tarmac for every theme except the open one, which
   * put the grass *outside* the fence — ground the terrain called drivable and the
   * geometry made unreachable. Now the layout is uniform everywhere: road, kerb markers,
   * a lane of grass, then the wall. There is nothing beyond it to drive to.
   */
  const offset = seg.halfWidth + seg.shoulder + style.thickness / 2;

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
 * Fill the wedge between two consecutive road ribbons.
 *
 * The ribbons are rectangles, so where the course turns they meet along one edge and open
 * a triangular notch on the outside of the bend — a jagged step with the void showing
 * through it. A short patch laid over the joint at the mean heading covers it, and costs
 * one flat box per junction.
 */
function buildJointPatches(r: Renderer, segments: CourseSegment[]): void {
  const spine = segments.filter((s) => !s.branch && !s.overlay);

  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const turn = Math.abs(wrapTo(b.heading - a.heading));
    if (turn < 0.03) continue;

    const width = Math.max(a.halfWidth, b.halfWidth) * 2;
    // Long enough to bridge the notch, which grows with both the width and the turn.
    const depth = Math.max(3, width * Math.tan(Math.min(turn, 1.2) / 2) + 3);

    const tint = SECTION_TINT[b.section] ?? [1, 1, 1];
    const base = SURFACE_COLOR[b.surface];
    const patch = r.createMesh(
      { kind: "box", width, height: ROAD_THICKNESS, depth },
      {
        color: [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]],
        emissive: 0.3,
        isStatic: true,
      },
    );
    // A hair above the ribbon: at the same height the two coplanar faces z-fight, which
    // is the other half of what "the ground glitches between sections" looks like.
    patch.position.set(a.bx, a.by - ROAD_THICKNESS / 2 + 0.03, a.bz);
    patch.rotation.y = a.heading + wrapTo(b.heading - a.heading) / 2;
    patch.rotation.x = -Math.atan((a.grade + b.grade) / 2);
  }
}

/** Shortest signed angle, for averaging two headings. */
function wrapTo(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Seal the wedge on the outside of every corner.
 *
 * Two consecutive legs each fence their own flank, and where they meet at an angle the
 * two wall lines stop short of each other on the outside of the turn. The gap is
 * proportional to how far out the wall sits, so it was a rounding error while walls hugged
 * the tarmac and a driveable hole the moment they moved to the far edge of the run-off —
 * measured, 14% of junction probes escaped through one.
 *
 * Each gap is bridged with short chunks, trimmed individually against other roads so that
 * spur mouths and junctions stay open. A single long chunk would either seal an alley or
 * leave the whole corner open.
 */
function buildJunctionCaps(
  r: Renderer,
  segments: CourseSegment[],
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
): void {
  const spine = segments.filter((s) => !s.branch && !s.overlay);

  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    if (a.wall === "none" || b.wall === "none") continue;

    const style = WALL_STYLE[a.wall as Exclude<WallStyle, "none">];
    const shades = wallShades[a.wall];
    const offA = a.halfWidth + a.shoulder + style.thickness / 2;
    const offB = b.halfWidth + b.shoulder + WALL_STYLE[b.wall as Exclude<WallStyle, "none">].thickness / 2;

    for (let side = -1; side <= 1; side += 2) {
      // Wall endpoints either side of the joint, on this flank.
      const ax = a.bx + a.dz * offA * side;
      const az = a.bz - a.dx * offA * side;
      const bx = b.ax + b.dz * offB * side;
      const bz = b.az - b.dx * offB * side;

      const dx = bx - ax;
      const dz = bz - az;
      const span = Math.hypot(dx, dz);
      if (span < 1.5) continue;

      const heading = Math.atan2(dx, dz);
      const chunks = Math.max(1, Math.round(span / 8));
      const chunkLen = span / chunks;

      for (let c = 0; c < chunks; c++) {
        const t = (c + 0.5) / chunks;
        const cx = ax + dx * t;
        const cz = az + dz * t;
        // Leave openings where a road actually passes through, so spur mouths survive.
        if (onOtherRoad(segments, a, cx, cz, JUNCTION_CLEARANCE)) continue;

        const rnd = hash2(cx, cz);
        const height = style.minHeight + rnd * (style.maxHeight - style.minHeight);
        const mesh = r.createMesh(
          { kind: "box", width: style.thickness, height, depth: chunkLen * 1.15 },
          { color: [...shades[Math.floor(rnd * 997) % shades.length]], emissive: 0.24, isStatic: true },
        );
        const groundY = a.by;
        mesh.position.set(cx, groundY + height / 2, cz);
        mesh.rotation.y = heading;
        addCollider(colliders, cx, cz, chunkLen / 2, style.thickness / 2, heading, groundY + height);
      }
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

    const style = PROP_STYLE[seg.section] ?? { color: [0.9, 0.42, 0.08] as Rgb, size: 3.0, height: 2.0 };
    const size = style.size;
    const height = style.height;

    const mesh = r.createMesh(
      { kind: "box", width: size, height, depth: size * 1.4 },
      { color: [...style.color], emissive: 0.45, isStatic: true },
    );
    mesh.position.set(cx, groundY + height / 2, cz);
    mesh.rotation.y = seg.heading;

    addCollider(colliders, cx, cz, size * 0.7, size / 2, seg.heading, groundY + height);
  }
}

/** Distance between obstacles per section; sections not listed stay clear. */
const PROP_SPACING: Partial<Record<SectionId, number>> = {
  downtown: 95,
  construction: 44,
  canyon: 58,
  industrial: 50,
  offroad: 70,
  final: 48,
};

/** Obstacle look per section, so a hazard tells you where you are. */
const PROP_STYLE: Partial<Record<SectionId, { color: Rgb; size: number; height: number }>> = {
  downtown: { color: [0.9, 0.42, 0.08], size: 3.0, height: 2.0 },
  construction: { color: [0.95, 0.72, 0.1], size: 3.0, height: 2.2 },
  canyon: { color: [0.36, 0.33, 0.3], size: 3.6, height: 3.0 },
  industrial: { color: [0.2, 0.5, 0.55], size: 3.2, height: 2.6 },
  offroad: { color: [0.55, 0.4, 0.22], size: 4.2, height: 3.4 },
  final: { color: [0.9, 0.3, 0.2], size: 3.0, height: 2.2 },
};

