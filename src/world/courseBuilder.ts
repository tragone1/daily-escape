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
import { WALL_ROLLS } from "./course";
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

/**
 * Palette variants per wall style, picked once per day from the course seed.
 *
 * The geometry of a day already varies; the light does not, and a canyon that is always
 * the same brown reads as the same canyon whatever shape it takes. Every variant is
 * hand-chosen to keep the same value range as the original so readability at speed -
 * dark charcoal squad cars against mid-tone walls - never depends on the day's roll.
 */
const WALL_VARIANTS: Record<Exclude<WallStyle, "none">, Rgb[]> = {
  building: [
    [0.24, 0.26, 0.33],
    [0.3, 0.26, 0.24],
    [0.22, 0.29, 0.27],
    [0.28, 0.24, 0.32],
  ],
  barrier: [
    [0.76, 0.6, 0.18],
    [0.78, 0.44, 0.16],
    [0.62, 0.66, 0.2],
    [0.75, 0.55, 0.35],
  ],
  rail: [
    [0.5, 0.53, 0.58],
    [0.56, 0.52, 0.48],
    [0.45, 0.55, 0.52],
    [0.55, 0.5, 0.6],
  ],
  rock: [
    [0.34, 0.29, 0.24],
    [0.42, 0.28, 0.24],
    [0.32, 0.32, 0.34],
    [0.4, 0.34, 0.22],
  ],
  fence: [
    [0.42, 0.44, 0.38],
    [0.38, 0.42, 0.48],
    [0.48, 0.42, 0.36],
    [0.36, 0.46, 0.42],
  ],
  open: [
    [0.5, 0.46, 0.38],
    [0.46, 0.5, 0.4],
    [0.54, 0.44, 0.34],
    [0.44, 0.46, 0.5],
  ],
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

  // Palette. The day's roll picks each style's variant; shades are shifted copies so a
  // run of chunks is not flat.
  const wallShades: Record<string, Rgb[]> = {};
  for (const [name, style] of Object.entries(WALL_STYLE)) {
    const variants = WALL_VARIANTS[name as Exclude<WallStyle, "none">] ?? [style.color];
    const roll = WALL_ROLLS[name] ?? 0;
    const color = variants[Math.floor(roll * 997) % variants.length];
    wallShades[name] = [0, 1, 2].map((i) => scale(color, 0.82 + i * 0.14));
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

  // --- The spine: continuous ribbon ground + decor ------------------------
  const spineSlices = segments.filter((sg) => !sg.branch && !sg.overlay);
  buildSpineRibbons(r, spineSlices);
  buildSpineDecor(r, spineSlices, colliders, segments);
  for (const seg of spineSlices) {
    if (seg.wall !== "none") buildWalls(r, seg, colliders, wallShades, segments, terrain);
  }

  // --- Branches and overlays: short straight pieces, box-built as before ---
  for (const seg of segments) {
    if (!seg.branch && !seg.overlay) continue;
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

    /*
     * Grass over the end aprons the terrain now treats as drivable, so the ground looks
     * like what it is. Drawn a hair lower than the neighbouring road and run-off so the
     * overlap renders as the road on top of grass rather than two coplanar surfaces
     * fighting; the wedges between legs read as mown corners instead of holes in the
     * world.
     */
    for (const [ext, endX, endZ, endY, dir] of [
      [seg.extA, seg.ax, seg.az, seg.ay, -1],
      [seg.extB, seg.bx, seg.bz, seg.by, 1],
    ] as const) {
      if (ext <= 0) continue;
      const cx = endX + seg.dx * dir * (ext / 2);
      const cz = endZ + seg.dz * dir * (ext / 2);
      const pad = r.createMesh(
        {
          kind: "box",
          width: (seg.halfWidth + seg.shoulder) * 2,
          height: APRON_THICKNESS,
          depth: ext + 0.6,
        },
        { color: [...SURFACE_COLOR.grass], emissive: 0.3, isStatic: true },
      );
      pad.position.set(cx, endY - APRON_THICKNESS / 2 - 0.09, cz);
      pad.rotation.y = seg.heading;
      // And a skirt below it, so the apron does not hang over the void at its outer edge.
      const skirt = r.createMesh(
        { kind: "box", width: (seg.halfWidth + seg.shoulder) * 2, height: 12, depth: ext + 0.6 },
        { color: [0.11, 0.1, 0.1], emissive: 0.18, isStatic: true },
      );
      skirt.position.set(cx, endY - 12 / 2 - 0.3, cz);
      skirt.rotation.y = seg.heading;
    }

    if (seg.wall !== "none") buildWalls(r, seg, colliders, wallShades, segments, terrain);
    if (seg.capEnd) capDeadEnd(r, seg, colliders, wallShades);
    buildProps(r, seg, colliders, segments);
  }

  buildJunctionCaps(r, segments, colliders, wallShades, terrain);
  sealBoundary(r, segments, colliders, wallShades, terrain);

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
  terrain?: Terrain,
): boolean {
  /*
   * With ~4,000 micro-slices, testing a point against every segment made wall building
   * alone take half a minute; the terrain's spatial grid answers the same question from
   * a few dozen candidates.
   */
  const near = terrain?.segmentsNear(x, z);
  const list = near ?? segments;
  for (let li = 0; li < list.length; li++) {
    const other = near ? segments[near[li]] : (list[li] as CourseSegment);
    if (other === self) continue;
    /*
     * On the curved spine a slice's own road bends toward its own wall line: a chunk on
     * the inside of a bend sits laterally close to slices a few dozen indices away, and
     * treating those as "another road" ate the whole inside fence of every corner. The
     * same road curving is not a crossing road - skip spine neighbours within a window,
     * while distant spine (a genuine switchback) and every branch still veto.
     */
    if (
      !self.branch &&
      !self.overlay &&
      !other.branch &&
      !other.overlay &&
      Math.abs(other.index - self.index) < 40
    )
      continue;
    const rx = x - other.ax;
    const rz = z - other.az;
    const along = rx * other.dx + rz * other.dz;
    const across = rx * other.dz - rz * other.dx;
    if (along < -margin || along > other.length + margin) continue;
    if (Math.abs(across) <= other.halfWidth + margin) return true;
  }
  return false;
}

/**
 * The ground, as ground.
 *
 * The road used to be a chain of flat slabs - one box per leg, plus a skirt box, plus
 * apron slabs, plus joint patches to hide the seams between all of the above. On a
 * curved, rolling course that stack of planes is exactly what it looks like: panes
 * thrown over each other, lips poking through hill crests, patches on patches. This
 * builds the whole spine surface as continuous ribbon meshes instead: one row of
 * vertices per slice boundary, mitred so quads share edges exactly - no gaps, no
 * overlaps, nothing to patch. Faces are flat-shaded per quad, so the ground keeps the
 * same low-poly facet look as everything else, just at the slice grain.
 */
function buildSpineRibbons(r: Renderer, spine: CourseSegment[]): void {
  if (spine.length === 0) return;

  interface Row { x: number; z: number; y: number; px: number; pz: number; w: number; s: number }
  const rows: Row[] = [];
  for (let i = 0; i <= spine.length; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(spine.length - 1, i)];
    let dx = (prev.dx + next.dx) / 2;
    let dz = (prev.dz + next.dz) / 2;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const at = i === 0 ? { x: next.ax, z: next.az, y: next.ay } : { x: prev.bx, z: prev.bz, y: prev.by };
    rows.push({
      x: at.x,
      z: at.z,
      y: at.y,
      px: dz,
      pz: -dx,
      w: (prev.halfWidth + next.halfWidth) / 2,
      s: (prev.shoulder + next.shoulder) / 2,
    });
  }

  // One flat-shaded quad: four unique vertices, one face normal.
  const quad = (
    pos: number[],
    norm: number[],
    idx: number[],
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const base = pos.length / 3;
    for (const v of [a, b, c, d]) pos.push(v[0], v[1], v[2]);
    for (let k = 0; k < 4; k++) norm.push(nx, ny, nz);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const vquad = (
    pos: number[],
    norm: number[],
    idx: number[],
    a: [number, number, number],
    b: [number, number, number],
    drop: number,
  ) => {
    // Vertical curtain from edge a-b down `drop`; normal faces outward-ish (any
    // horizontal normal reads fine on the dark skirt).
    const base = pos.length / 3;
    const nx = a[2] - b[2];
    const nz = b[0] - a[0];
    const nl = Math.hypot(nx, nz) || 1;
    for (const v of [a, b, [b[0], b[1] - drop, b[2]], [a[0], a[1] - drop, a[2]]] as const)
      pos.push(v[0], v[1], v[2]);
    for (let k = 0; k < 4; k++) norm.push(nx / nl, 0.2, nz / nl);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const emit = (pos: number[], norm: number[], idx: number[], color: Rgb, emissive: number) => {
    if (idx.length === 0) return;
    const mesh = r.createMesh(
      {
        kind: "custom",
        geometry: {
          positions: new Float32Array(pos),
          normals: new Float32Array(norm),
          indices: new Uint32Array(idx),
        },
      },
      { color: [...color] as Rgb, emissive, isStatic: true },
    );
    mesh.position.set(0, 0, 0);
  };

  // Road runs: split whenever the blended colour changes so each mesh stays uniform.
  let runStart = 0;
  const colorOf = (sg: CourseSegment): Rgb => {
    const tint = SECTION_TINT[sg.section] ?? [1, 1, 1];
    const base = SURFACE_COLOR[sg.surface];
    return [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];
  };
  const sameColor = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.001;
  for (let i = 1; i <= spine.length; i++) {
    if (i < spine.length && sameColor(colorOf(spine[i]), colorOf(spine[runStart]))) continue;
    const pos: number[] = [];
    const norm: number[] = [];
    const idx: number[] = [];
    for (let k = runStart; k < i; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      quad(pos, norm, idx,
        [r0.x - r0.px * r0.w, r0.y, r0.z - r0.pz * r0.w],
        [r0.x + r0.px * r0.w, r0.y, r0.z + r0.pz * r0.w],
        [r1.x + r1.px * r1.w, r1.y, r1.z + r1.pz * r1.w],
        [r1.x - r1.px * r1.w, r1.y, r1.z - r1.pz * r1.w]);
    }
    emit(pos, norm, idx, colorOf(spine[runStart]), 0.3);
    runStart = i;
  }

  // Grass shoulders, both sides in one mesh, only where a shoulder exists.
  {
    const pos: number[] = [];
    const norm: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < spine.length; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      if (r0.s < 0.08 && r1.s < 0.08) continue;
      for (const side of [-1, 1]) {
        quad(pos, norm, idx,
          [r0.x + r0.px * r0.w * side, r0.y - 0.06, r0.z + r0.pz * r0.w * side],
          [r0.x + r0.px * (r0.w + r0.s) * side, r0.y - 0.06, r0.z + r0.pz * (r0.w + r0.s) * side],
          [r1.x + r1.px * (r1.w + r1.s) * side, r1.y - 0.06, r1.z + r1.pz * (r1.w + r1.s) * side],
          [r1.x + r1.px * (r1.w + r1.s) * side * 0 + r1.px * r1.w * side, r1.y - 0.06, r1.z + r1.pz * r1.w * side]);
      }
    }
    emit(pos, norm, idx, SURFACE_COLOR.grass, 0.3);
  }

  // Dark skirts at the outer edge, so the ground reads as cut into the world.
  {
    const pos: number[] = [];
    const norm: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < spine.length; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      for (const side of [-1, 1]) {
        vquad(pos, norm, idx,
          [r0.x + r0.px * (r0.w + r0.s) * side, r0.y - 0.05, r0.z + r0.pz * (r0.w + r0.s) * side],
          [r1.x + r1.px * (r1.w + r1.s) * side, r1.y - 0.05, r1.z + r1.pz * (r1.w + r1.s) * side],
          14);
      }
    }
    emit(pos, norm, idx, [0.11, 0.1, 0.1], 0.18);
  }
}

/**
 * Everything that used to hang off per-leg loops - dashes, ramp lips, props - now walks
 * the spine by arc distance, because a slice is six units long and "per segment" stopped
 * meaning "per stretch of road".
 */
function buildSpineDecor(
  r: Renderer,
  spine: CourseSegment[],
  colliders: StaticCollider[],
  segments: CourseSegment[],
): void {
  const onBranchRoad = (x: number, z: number, margin: number): boolean => {
    for (const other of segments) {
      if (!other.branch) continue;
      const rx = x - other.ax;
      const rz = z - other.az;
      const along = rx * other.dx + rz * other.dz;
      if (along < -margin || along > other.length + margin) continue;
      if (Math.abs(rx * other.dz - rz * other.dx) <= other.halfWidth + margin) return true;
    }
    return false;
  };

  let arc = 0;
  let nextDash = 6;
  let nextProp = 40;
  let stationCount = 0;
  for (const seg of spine) {
    // Ramp lip marker, exactly as before.
    if (seg.ramp > 0) {
      const lip = r.createMesh(
        { kind: "box", width: seg.halfWidth * 2, height: 0.5, depth: 2.2 },
        { color: [0.95, 0.75, 0.1], emissive: 0.6, isStatic: true },
      );
      lip.position.set(seg.bx, seg.by + 0.4, seg.bz);
      lip.rotation.y = seg.heading;
    }

    const end = arc + seg.length;
    // Centre-line dashes on sealed surfaces, every 12 units of arc.
    while (nextDash <= end) {
      const t = (nextDash - arc) / seg.length;
      if (seg.surface === "asphalt") {
        const dash = r.createMesh(
          { kind: "box", width: 0.5, height: 0.12, depth: 4.5 },
          { color: [0.85, 0.85, 0.8], emissive: 0.7, isStatic: true },
        );
        dash.position.set(
          seg.ax + (seg.bx - seg.ax) * t,
          seg.ay + seg.grade * seg.length * t + 0.3,
          seg.az + (seg.bz - seg.az) * t,
        );
        dash.rotation.y = seg.heading;
        dash.rotation.x = -Math.atan(seg.grade);
      }
      nextDash += 12;
    }

    // Obstacle stations, spaced per the section's own rhythm.
    const spacing = PROP_SPACING[seg.section];
    while (spacing && nextProp <= end) {
      const t = (nextProp - arc) / seg.length;
      const px = seg.ax + (seg.bx - seg.ax) * t;
      const pz = seg.az + (seg.bz - seg.az) * t;
      const groundY = seg.ay + seg.grade * seg.length * t;
      stationCount++;
      placePropStation(r, seg, colliders, px, pz, groundY, stationCount, onBranchRoad);
      nextProp += spacing;
    }
    arc = end;
  }
}

/** One obstacle station: edge block, centre block, or a gate, hash-picked like before. */
function placePropStation(
  r: Renderer,
  seg: CourseSegment,
  colliders: StaticCollider[],
  px: number,
  pz: number,
  groundY: number,
  station: number,
  onBranchRoad: (x: number, z: number, margin: number) => boolean,
): void {
  if (seg.ramp > 0) return;
  const style = PROP_STYLE[seg.section] ?? { color: [0.9, 0.42, 0.08] as Rgb, size: 3.0, height: 2.0 };
  const size = style.size;
  const height = style.height;
  const rx = seg.dz;
  const rz = -seg.dx;
  const drop = (cx: number, cz: number, w: number) => {
    if (onBranchRoad(cx, cz, 2.0)) return;
    const mesh = r.createMesh(
      { kind: "box", width: w, height, depth: w * 1.4 },
      { color: [...style.color], emissive: 0.45, isStatic: true },
    );
    mesh.position.set(cx, groundY + height / 2, cz);
    mesh.rotation.y = seg.heading;
    addCollider(colliders, cx, cz, w * 0.7, w / 2, seg.heading, groundY + height);
  };

  const roll = hash2(px * 1.31, pz * 0.73);
  if (roll > 0.62) return; // leave gaps so the route never fully closes
  const mode =
    roll < 0.09 && seg.halfWidth - size / 2 >= 5.5 ? "centre"
    : roll < 0.17 && seg.halfWidth >= 3.4 + size + 0.5 ? "gate"
    : "edge";

  if (mode === "centre") {
    const shift = (hash2(pz, px) < 0.5 ? 1 : -1) * 2.6;
    drop(px + rx * shift, pz + rz * shift, size);
    return;
  }
  if (mode === "gate") {
    const slotShift = (hash2(pz * 1.9, px * 0.4) - 0.5) * (seg.halfWidth - 3.4 - size);
    for (const side of [-1, 1]) {
      const lateral = slotShift + side * (3.4 + size / 2);
      if (Math.abs(lateral) + size / 2 > seg.halfWidth - 0.4) continue;
      drop(px + rx * lateral, pz + rz * lateral, size);
    }
    return;
  }
  const side = station % 2 === 0 ? 1 : -1;
  const lateral = (seg.halfWidth - 2.2) * side;
  drop(px + rx * lateral, pz + rz * lateral, size);
}

/** Fence a segment in with themed chunks on both sides. */
function buildWalls(
  r: Renderer,
  seg: CourseSegment,
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
  segments: CourseSegment[],
  terrain?: Terrain,
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
        onOtherRoad(segments, seg, cx, cz, clear, terrain) ||
        onOtherRoad(segments, seg, cx + seg.dx * halfChunk, cz + seg.dz * halfChunk, clear, terrain) ||
        onOtherRoad(segments, seg, cx - seg.dx * halfChunk, cz - seg.dz * halfChunk, clear, terrain)
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
  terrain?: Terrain,
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
        if (onOtherRoad(segments, a, cx, cz, JUNCTION_CLEARANCE, terrain)) continue;

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
 * The last line of containment: walk the boundary of the drivable union and patch every
 * stretch no wall covers.
 *
 * The themed walls are built per segment, and per-segment reasoning has never fully
 * closed the boundary: legs meet at jittered angles, spur mouths cut diagonal wedges,
 * and every trim rule that opens a legitimate junction also risks opening a hole. Two
 * attempts to fix the trims themselves each closed one class of hole and opened another,
 * because the drivable union near a joint is a polygon no single segment can see. So
 * this pass stops reasoning about segments and asks the terrain directly, and it is
 * purely additive: the themed walls stay exactly as they were.
 */
function sealBoundary(
  r: Renderer,
  segments: CourseSegment[],
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
  terrain: Terrain,
): void {
  /*
   * Coarse hash of existing wall-height colliders. Height is measured above the local
   * ground, not as an absolute Y - an earlier version compared `topY` against a constant,
   * which dismissed every two-unit rail standing near sea level as a kerb and then built
   * a second wall on top of the first, coplanar with it, which is where the shimmer at
   * the start line came from.
   */
  const CELL = 8;
  type GuardBox = { x: number; z: number; dx: number; dz: number; hl: number; ht: number };
  const guard = new Map<string, GuardBox[]>();
  const key = (x: number, z: number) => Math.floor(x / CELL) + ":" + Math.floor(z / CELL);
  for (const c of colliders) {
    if (c.topY - terrain.heightAt(c.obb.x, c.obb.z) < 1.6) continue;
    const entry: GuardBox = {
      x: c.obb.x, z: c.obb.z,
      dx: Math.sin(c.obb.heading), dz: Math.cos(c.obb.heading),
      hl: c.obb.halfLength, ht: c.obb.halfWidth,
    };
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++) {
        const k = Math.floor(c.obb.x / CELL + gx) + ":" + Math.floor(c.obb.z / CELL + gz);
        let list = guard.get(k);
        if (!list) guard.set(k, (list = []));
        list.push(entry);
      }
  }
  /*
   * True distance to the guarding box, not to its bounding circle. The circumradius of
   * a long chunk over-covers its ends by most of its length, which is exactly where the
   * cracks are - two chunk ends a car-nose apart tested as "already walled" and the
   * crack between them never got a patch. Grazing-angle drive tests found cars slipping
   * through two of those seams diagonally.
   */
  const guarded = (x: number, z: number, reach: number): boolean => {
    const list = guard.get(key(x, z));
    if (!list) return false;
    for (const e of list) {
      const rx = x - e.x;
      const rz = z - e.z;
      const la = Math.abs(rx * e.dx + rz * e.dz);
      const lt = Math.abs(rx * e.dz - rz * e.dx);
      const da = Math.max(0, la - e.hl);
      const dt = Math.max(0, lt - e.ht);
      if (Math.hypot(da, dt) < reach) return true;
    }
    return false;
  };

  /*
   * Clear means clear along the whole face, not just at three stations - a drivable
   * bulge narrower than the sample gap slid under a patch face and read, in play, as
   * the wall pinching the road. Samples run every ~1.4 units and the drivable test
   * carries a 0.35 buffer beyond the face, so a patch keeps daylight between itself
   * and the ground a car can actually use.
   */
  const cornersClear = (x: number, z: number, heading: number, hl: number, ht: number) => {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const n = Math.max(2, Math.ceil((hl * 2) / 1.4));
    for (let i = 0; i <= n; i++) {
      const a = -hl + (i / n) * hl * 2;
      for (const t of [-(ht + 0.35), ht + 0.35])
        if (terrain.sample(x + dx * a + dz * t, z + dz * a - dx * t).onCourse) return false;
    }
    return true;
  };

  /*
   * No patches in a jump's flight path. A ramp launches the player off the lip and the
   * ground past it sits well below the flight line, so a patch standing there fights
   * the lip and skirt slabs for pixels - the flicker reported at the section 12 ramp -
   * while sealing nothing a car at ramp speed could reach sideways.
   */
  const lips: { x: number; z: number }[] = [];
  for (const seg of segments) if (seg.ramp > 0) lips.push({ x: seg.bx, z: seg.bz });
  const nearLip = (x: number, z: number): boolean => {
    for (const l of lips) if (Math.hypot(l.x - x, l.z - z) < 16) return true;
    return false;
  };

  /*
   * One piece of patch wall, styled like the local theme and nudged outward until every
   * corner is clear of drivable ground - so a patch can plug a hole but structurally
   * cannot narrow a road. Height comes from the theme so a patch beside a rail reads as
   * rail, not as a fence post standing in open country.
   */
  const placed = new Set<string>();
  const piece = (
    x: number,
    z: number,
    ox: number,
    oz: number,
    heading: number,
    halfLen: number,
    theme: string,
  ) => {
    const pk = Math.round(x / 2.5) + ":" + Math.round(z / 2.5);
    if (placed.has(pk)) return;
    const styleName = (theme in WALL_STYLE ? theme : "fence") as Exclude<WallStyle, "none">;
    const style = WALL_STYLE[styleName];
    const shades = wallShades[styleName];
    let px = x;
    let pz = z;
    let hl = halfLen;
    let ok = false;
    for (let d = 0; d <= 4.2 && !ok; d += 0.7) {
      px = x + ox * d;
      pz = z + oz * d;
      ok = cornersClear(px, pz, heading, hl, 0.9);
    }
    if (!ok) {
      hl = Math.max(1.4, halfLen * 0.55);
      for (let d = 0; d <= 4.2 && !ok; d += 0.7) {
        px = x + ox * d;
        pz = z + oz * d;
        ok = cornersClear(px, pz, heading, hl, 0.9);
      }
    }
    if (!ok) return;
    // Nudging can land a piece on a wall band the pre-check could not see from the
    // original spot; a patch flush against existing wall is the shimmer, not a seal.
    if (guarded(px, pz, 0.35)) return;
    if (nearLip(px, pz)) return;
    /*
     * And never across a sharp height break. heightAt is read at the centre, so a piece
     * spanning a slope edge floats at one end and sinks at the other - which reads as
     * broken geometry even when the collider is fine.
     */
    const dxh = Math.sin(heading);
    const dzh = Math.cos(heading);
    const yA = terrain.heightAt(px - dxh * hl, pz - dzh * hl);
    const yB = terrain.heightAt(px + dxh * hl, pz + dzh * hl);
    if (Math.abs(yA - yB) > 2.2) return;
    placed.add(pk);
    const groundY = terrain.heightAt(px, pz);
    const rnd = hash2(px, pz);
    const height = style.minHeight + rnd * (style.maxHeight - style.minHeight) * 0.5;
    const mesh = r.createMesh(
      { kind: "box", width: 1.8, height, depth: hl * 2 },
      { color: [...shades[Math.floor(rnd * 997) % shades.length]], emissive: 0.24, isStatic: true },
    );
    mesh.position.set(px, groundY + height / 2, pz);
    mesh.rotation.y = heading;
    addCollider(colliders, px, pz, hl, 0.9, heading, groundY + height);
  };

  /*
   * March each leg's outline, collect the unguarded stretches of boundary, and emit each
   * stretch as a run of pieces whose headings follow the boundary itself rather than the
   * segment - a hole at a jittered joint runs diagonally, and pieces that follow it read
   * as a wall that was always there instead of a row of stubs.
   */
  /*
   * The rear of the start line. Every leg's sides are marched below, but nothing ever
   * walks an end face, and the course head is the one end not butted against another
   * leg - reversing off the start line simply left the world. One themed wall across
   * the back, a few units behind the spawn, closes it.
   */
  {
    const head = segments.find((s) => !s.branch && !s.overlay);
    if (head) {
      const styleName = (head.wall in WALL_STYLE ? head.wall : "fence") as Exclude<WallStyle, "none">;
      const style = WALL_STYLE[styleName];
      const width = (head.halfWidth + head.shoulder) * 2 + 8;
      const height = style.minHeight + 0.5;
      const bx = head.ax - head.dx * (3 + style.thickness / 2);
      const bz = head.az - head.dz * (3 + style.thickness / 2);
      const groundY = terrain.heightAt(bx, bz);
      /*
       * Collider only - no mesh. The chase camera sits behind the car at spawn, and a
       * visible wall three units back filled the whole opening frame before the player
       * had touched a key. An invisible barrier contains identically and shows nothing;
       * the void behind the start never enters view once the car is moving.
       */
      addCollider(colliders, bx, bz, style.thickness / 2, width / 2, head.heading, groundY + height);
    }
  }

  for (const seg of segments) {
    if (seg.overlay) continue;
    /*
     * March at 1.2 units. At 2.5 a two-unit crack between chunk ends could sit exactly
     * between samples, each of which read "guarded" from its own side - and a car at a
     * grazing angle slipped through the one such crack on the course. Half the step
     * guarantees a sample lands inside anything a car could possibly thread.
     */
    const steps = Math.max(2, Math.ceil(seg.length / 1.2));
    for (let side = -1; side <= 1; side += 2) {
      const run: { x: number; z: number }[] = [];
      const flush = () => {
        if (run.length === 0) return;
        // Emit the run as pieces of up to ~9 units, heading fitted to the local stretch.
        let i = 0;
        let flip = 0;
        while (i < run.length - 1) {
          const j = Math.min(run.length - 1, i + 2);
          const ax = run[i].x;
          const az = run[i].z;
          const bx = run[j].x;
          const bz = run[j].z;
          const span = Math.hypot(bx - ax, bz - az);
          const heading = span > 0.5 ? Math.atan2(bx - ax, bz - az) : Math.atan2(seg.dx, seg.dz);
          // Consecutive pieces share an endpoint (i = j, not j + 1) so the line has no
          // cracks of its own, and alternate a hand's width of lateral offset so their
          // long faces are never coplanar - coplanar patch faces were the shimmer.
          const jitter = (flip++ % 2 === 0 ? 1 : -1) * 0.14;
          piece(
            (ax + bx) / 2 + seg.dz * side * jitter,
            (az + bz) / 2 - seg.dx * side * jitter,
            seg.dz * side,
            -seg.dx * side,
            heading,
            Math.max(1.6, span / 2 + 0.6),
            seg.wall === "none" ? "fence" : seg.wall,
          );
          i = j;
        }
        run.length = 0;
        if (i === 0 && run.length === 1) run.length = 0;
      };
      for (let i = 0; i <= steps; i++) {
        const along = (i / steps) * seg.length;
        const bx = seg.ax + seg.dx * along;
        const bz = seg.az + seg.dz * along;
        /*
         * Fast path first: the overwhelmingly common case is a themed wall standing at
         * this segment's own edge, and one guard lookup settles it. Without this, every
         * station ran a 30-sample outward march through terrain sampling - across four
         * thousand slices that alone took the world build from seconds to minutes.
         */
        const qx = bx + seg.dz * (seg.halfWidth + seg.shoulder + 0.6) * side;
        const qz = bz - seg.dx * (seg.halfWidth + seg.shoulder + 0.6) * side;
        if (guarded(qx, qz, 1.4)) { flush(); continue; }
        let edge = -1;
        for (let d = seg.halfWidth; d < seg.halfWidth + seg.shoulder + 42; d += 1.4) {
          const x = bx + seg.dz * d * side;
          const z = bz - seg.dx * d * side;
          if (!terrain.sample(x, z).onCourse) { edge = d; break; }
        }
        if (edge < 0) { flush(); continue; }
        /*
         * The guard question is "does a wall already stand between the drivable edge and
         * the outside", so it is asked half a unit past the edge - where a wall's inner
         * face would be - rather than at the patch spot. Asked out at the patch spot it
         * missed walls the patch would sit behind, and the sealer built a redundant
         * second line beside a thousand units of perfectly good fence.
         */
        const gx = bx + seg.dz * (edge + 0.5) * side;
        const gz = bz - seg.dx * (edge + 0.5) * side;
        if (guarded(gx, gz, 0.6)) { flush(); continue; }
        const px = bx + seg.dz * (edge + 0.95) * side;
        const pz = bz - seg.dx * (edge + 0.95) * side;
        run.push({ x: px, z: pz });
      }
      flush();
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
  const style = PROP_STYLE[seg.section] ?? { color: [0.9, 0.42, 0.08] as Rgb, size: 3.0, height: 2.0 };

  /*
   * Layout mode, per leg, from the same position hash that drives everything else - so
   * it reshuffles with the daily seed. "Edge" is the original alternating-kerb rhythm;
   * "centre" puts a short row down the middle and makes the decision *which side*, and
   * "gate" narrows the line to a chosen slot. Every mode guarantees a lane at least two
   * and a half car widths wide: centre needs halfWidth - size/2 of daylight each side,
   * and a gate keeps a 6.8-wide slot, both above the 5.5 the hazards are tuned around.
   * Legs too narrow for a mode fall back to edge rather than squeezing.
   */
  const modeRoll = hash2(seg.ax * 1.31, seg.az * 0.73);
  const size = style.size;
  const height = style.height;
  const drop = (cx: number, cz: number, groundY: number, w: number) => {
    if (onOtherRoad(segments, seg, cx, cz, 2.0)) return;
    const mesh = r.createMesh(
      { kind: "box", width: w, height, depth: w * 1.4 },
      { color: [...style.color], emissive: 0.45, isStatic: true },
    );
    mesh.position.set(cx, groundY + height / 2, cz);
    mesh.rotation.y = seg.heading;
    addCollider(colliders, cx, cz, w * 0.7, w / 2, seg.heading, groundY + height);
  };

  const mode =
    modeRoll < 0.14 ? "none"
    : modeRoll < 0.34 && seg.halfWidth - size / 2 >= 5.5 ? "centre"
    : modeRoll < 0.5 && seg.halfWidth >= 3.4 + size + 0.5 ? "gate"
    : "edge";

  if (mode === "none") return;

  if (mode === "centre") {
    /*
     * A short row up the middle of the leg - but shifted a car's width off the exact
     * centreline, alternating sides by hash. The nav graph runs the centreline and every
     * pursuer path-follows it, so a block dead on the line would have the whole squad
     * ploughing into it; offset, it reads as mid-road to the player while leaving the
     * canonical line open, and the wide side always carries at least eight units.
     */
    const blocks = 1 + (Math.floor(hash2(seg.az, seg.ax) * 3) % 3);
    const rowShift = (hash2(seg.ax * 0.37, seg.az * 1.11) < 0.5 ? 1 : -1) * 2.6;
    const mid = seg.length / 2;
    for (let b = 0; b < blocks; b++) {
      const along = mid + (b - (blocks - 1) / 2) * (size * 2.4);
      if (along < 8 || along > seg.length - 8) continue;
      drop(
        seg.ax + seg.dx * along + rx * rowShift,
        seg.az + seg.dz * along + rz * rowShift,
        seg.ay + seg.grade * along,
        size,
      );
    }
    return;
  }

  if (mode === "gate") {
    // Two blocks framing a 6.8-wide slot, biased toward one side of the centreline so
    // the fast line moves day to day.
    const along = seg.length * (0.35 + hash2(seg.ax * 0.7, seg.az * 1.7) * 0.3);
    const slotShift = (hash2(seg.az * 1.9, seg.ax * 0.4) - 0.5) * (seg.halfWidth - 3.4 - size);
    const groundY = seg.ay + seg.grade * along;
    for (const side of [-1, 1]) {
      const lateral = slotShift + side * (3.4 + size / 2);
      if (Math.abs(lateral) + size / 2 > seg.halfWidth - 0.4) continue;
      drop(
        seg.ax + seg.dx * along + rx * lateral,
        seg.az + seg.dz * along + rz * lateral,
        groundY,
        size,
      );
    }
    return;
  }

  for (let i = 1; i <= count; i++) {
    const along = (i * seg.length) / (count + 1);
    const rnd = hash2(seg.ax + along, seg.az + along * 1.7);
    if (rnd > 0.62) continue; // leave gaps so the route never fully closes

    // Alternate kerbs; obstacles hug a side so a clean line always exists.
    const side = i % 2 === 0 ? 1 : -1;
    const lateral = (seg.halfWidth - 2.2) * side;
    drop(
      seg.ax + seg.dx * along + rx * lateral,
      seg.az + seg.dz * along + rz * lateral,
      seg.ay + seg.grade * along,
      size,
    );
  }
}

/** Distance between obstacles per section; sections not listed stay clear. */
const PROP_SPACING: Partial<Record<SectionId, number>> = {
  downtown: 80,
  construction: 40,
  canyon: 52,
  industrial: 44,
  hills: 70,
  // The widest section needs the most furniture: open road with nothing in it is the one
  // place nothing can go wrong, and a stretch where nothing can go wrong is a rest.
  offroad: 38,
  final: 42,
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

