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
import { buildCourseSegments, DAILY } from "./course";
import type { Course } from "./course";
import { NavGraph } from "./navGraph";
import { Terrain } from "./terrain";

export interface BuiltWorld {
  segments: CourseSegment[];
  terrain: Terrain;
  colliders: StaticCollider[];
  nav: NavGraph;
  /** Blocks the racing-line check had to withdraw. Zero is the healthy number. */
  blocksWithdrawn: number;
  update(elapsed: number): void;
}

/**
 * Thickness of the road slab and the grass apron.
 *
 * Both are positioned so their *top* face is the ground plane the terrain reports, which
 * is the only arrangement where the car looks like it is standing on the road.
 */
/**
 * The narrowest lane the finished course may leave anywhere, measured as the
 * span of positions the car's own centre can hold. Roughly two cars abreast of
 * clear tarmac - enough to be driven through under pressure rather than
 * threaded. Enforced by `enforceRacingLine` after everything is built.
 */
const MIN_LANE_WIDTH = 7.5;

/**
 * How long a single piece of ribbon may be before it is cut.
 *
 * Nothing to do with looks - the pieces meet exactly. It is a bound on how big
 * one indivisible mesh can get, because a mesh is the unit both the culler and
 * a streamed world work in, and one that runs the length of the course can be
 * neither skipped nor released.
 */
const RIBBON_BLOCK = 420;

const ROAD_THICKNESS = 0.5;
const APRON_THICKNESS = 0.34;
/** How far an overlay deck is raised above the height its segment reports. */
const OVERLAY_RAISE = 0.09;

/**
 * How high painted markings sit above the surface they are painted on.
 *
 * Measured to the CENTRE of the box, so each value is the object's half-height
 * plus however far it is meant to bed into the road. Both bed in slightly on
 * purpose. Backface culling is off - see the note in the renderer, the ground
 * planes need to be visible from either side - so the underside of a marking is
 * really drawn, and one landed exactly flush would have that face coplanar with
 * the road and shimmer against it, which is the failure these numbers are
 * chosen to avoid.
 *
 * They were 0.3 and 0.4, and that was correct while the road was a half-unit
 * slab *centred* on the height the segment reports: its top face stood at +0.25
 * and the paint landed on it. "unsink every car" dropped the slab so that its
 * top face lands on that height instead, and re-based the skirt, the apron and
 * the joint patches to match - but not these two, which have been hovering a
 * quarter of a unit above the tarmac ever since. Driving on the flat you never
 * see it. At the crest of a hill you are looking straight down the surface, and
 * the gap of shadow under every dash is the first thing you notice.
 */
const DASH_LIFT = 0.05; // 0.12 tall: 0.01 bedded in, 0.11 proud.
const RAMP_LIP_LIFT = 0.15; // 0.5 tall: 0.10 bedded in, 0.40 proud.

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

/**
 * A prop and the collider it owns, so a later pass can take it back out.
 *
 * Props are the only furniture that may be withdrawn. Walls are the edge of the
 * world and the road has to keep them; a block on the carriageway is a
 * decoration, and a decoration does not get to close the road.
 */
/**
 * Which sections a build pass may emit geometry for.
 *
 * A streamed world builds a few sections at a time, but a section cannot be
 * built in isolation: a wall has to know about the road crossing it from the
 * section next door, and the racing-line check has to see the blocks either
 * side of a seam. So every pass takes the WHOLE course to consult and this to
 * decide what it is allowed to produce - consult everything, emit a window.
 *
 * Seams are exactly where the chokepoint bugs came from, so the distinction is
 * the important one: a pass that filtered its input instead would build each
 * window as though the rest of the world did not exist.
 */
export interface EmitScope {
  /** True when this segment's geometry belongs to the range being built. */
  wants(seg: CourseSegment): boolean;
}

/** Everything, for a one-shot build of the whole course. */
export const EMIT_ALL: EmitScope = { wants: () => true };

/** Only these sections, by their index in the course. */
export function emitSections(from: number, to: number): EmitScope {
  return { wants: (seg) => seg.sectionIndex >= from && seg.sectionIndex < to };
}

interface PlacedProp {
  mesh: { dispose(): void };
  collider: StaticCollider;
}

function addCollider(
  list: StaticCollider[],
  x: number,
  z: number,
  halfLength: number,
  halfWidth: number,
  heading: number,
  topY: number,
  /** What built it. Diagnostic only - it is what makes a choke point traceable. */
  source = "unknown",
  /**
   * Where the solid starts. Defaults far below, which is the old behaviour -
   * every caller that knows its ground height should say so, because a solid
   * with no bottom blocks the road under it however high up it is.
   */
  baseY = -Infinity,
): void {
  list.push({
    obb: { x, z, halfLength, halfWidth, heading },
    topY,
    baseY,
    radius: Math.hypot(halfLength, halfWidth),
    occludes: topY > 4.5,
    source,
  });
}

/**
 * NO CHOKEHOLDS - measured, not assumed.
 *
 * Every station along the spine has to leave a lane a car can actually take.
 * The layout rules each guarantee that on their own, but they are written one
 * prop at a time and cannot see a wall built afterwards, a second road
 * crossing, or the particular width the day's seed happened to roll. A new map
 * goes out every day and nobody gets to drive it first, so this has to be a
 * measurement at build time rather than a property the rules are trusted to
 * have. Where the lane comes up short the props responsible are withdrawn,
 * biggest gain first, until it does not.
 *
 * Returns the number withdrawn - the figure worth watching. If a change to the
 * layout rules starts costing dozens of props, the rules have regressed.
 */
function enforceRacingLine(
  segments: CourseSegment[],
  colliders: StaticCollider[],
  props: PlacedProp[],
  scope: EmitScope,
): number {
  const CAR = 1.05;
  const MIN_LANE = MIN_LANE_WIDTH;
  /*
   * Sampling resolution.
   *
   * This sweep was half the cost of building a streamed window - 19.6ms of a
   * 38ms build, against a 16.7ms frame - because it tested every two units
   * along the road by every quarter unit across it, about forty-two thousand
   * points per window.
   *
   * Coarsened deliberately. The figure it produces is compared against a
   * minimum lane of 7.5 units, so half-unit resolution is far finer than the
   * decision needs, and a station every three units cannot hide an obstacle:
   * nothing this removes is smaller than a car.
   */
  const STATION = 3;
  const LATERAL = 0.5;

  const propOf = new Map<StaticCollider, PlacedProp>();
  for (const pr of props) propOf.set(pr.collider, pr);
  const gone = new Set<StaticCollider>();

  const CELL = 24;
  const grid = new Map<string, StaticCollider[]>();
  const key = (x: number, z: number) => Math.floor(x / CELL) + ":" + Math.floor(z / CELL);
  for (const c of colliders) {
    const k = key(c.obb.x, c.obb.z);
    const cell = grid.get(k);
    if (cell) cell.push(c);
    else grid.set(k, [c]);
  }

  /*
   * Circle against box, the same question the collision world answers - not box
   * against box. Inflating the collider by the car's half-width instead treats
   * its corners as square, and a lane this pass measured as exactly wide enough
   * came up a quarter-unit short in the game.
   */
  const hits = (c: StaticCollider, x: number, z: number): boolean => {
    const dx = x - c.obb.x;
    const dz = z - c.obb.z;
    const fx = Math.sin(c.obb.heading);
    const fz = Math.cos(c.obb.heading);
    const along = Math.abs(dx * fx + dz * fz) - c.obb.halfLength;
    const across = Math.abs(dx * fz - dz * fx) - c.obb.halfWidth;
    if (along <= 0 && across <= 0) return true;
    const oa = Math.max(0, along);
    const oc = Math.max(0, across);
    return oa * oa + oc * oc <= CAR * CAR;
  };

  let withdrawn = 0;
  for (const seg of segments) {
    if (seg.branch || seg.overlay) continue;
    /*
     * Only this window's stations are checked, but against every collider
     * present - a block just over a seam narrows the lane exactly as much as
     * one beside it, and checking a window in isolation is how a seam becomes
     * the one place nobody measured.
     */
    if (!scope.wants(seg)) continue;
    const px = seg.dz;
    const pz = -seg.dx;
    for (let a = 0; a <= seg.length; a += STATION) {
      const sx = seg.ax + seg.dx * a;
      const sz = seg.az + seg.dz * a;
      const hw = seg.halfWidth;

      const near: StaticCollider[] = [];
      for (let gx = -1; gx <= 1; gx++) {
        for (let gz = -1; gz <= 1; gz++) {
          const cell = grid.get(key(sx + gx * CELL, sz + gz * CELL));
          if (!cell) continue;
          for (const c of cell) if (!gone.has(c)) near.push(c);
        }
      }
      if (near.length === 0) continue;

      /** Widest run of lateral offsets the car's centre could occupy. */
      const widest = (skip: StaticCollider | null): number => {
        let best = 0;
        let run = 0;
        for (let o = -hw; o <= hw; o += LATERAL) {
          const x = sx + px * o;
          const z = sz + pz * o;
          let blocked = false;
          for (const c of near) {
            if (c === skip) continue;
            if (hits(c, x, z)) {
              blocked = true;
              break;
            }
          }
          if (blocked) run = 0;
          else {
            run += LATERAL;
            if (run > best) best = run;
          }
        }
        return best;
      };

      if (widest(null) >= MIN_LANE) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        let best: StaticCollider | null = null;
        let bestGain = 0;
        for (const c of near) {
          if (!propOf.has(c) || gone.has(c)) continue;
          const gain = widest(c);
          if (gain > bestGain) {
            bestGain = gain;
            best = c;
          }
        }
        // Nothing removable, or removing it would not help: the width here is
        // the road's own, and that is the generator's business, not this pass's.
        if (!best || bestGain <= widest(null)) break;
        gone.add(best);
        (propOf.get(best) as PlacedProp).mesh.dispose();
        withdrawn++;
        const at = near.indexOf(best);
        if (at >= 0) near.splice(at, 1);
        if (widest(null) >= MIN_LANE) break;
      }
    }
  }

  if (gone.size > 0) {
    for (let i = colliders.length - 1; i >= 0; i--) {
      if (gone.has(colliders[i])) colliders.splice(i, 1);
    }
  }
  return withdrawn;
}

/**
 * Group the static scenery by where it is and bake one chunk per group.
 *
 * Chunks follow course progress, not a spatial grid: the road is a ribbon, so
 * a band of progress is a compact region, and it is also the unit a streamed
 * world adds and drops.
 */
function bakeInChunks(r: Renderer, segments: CourseSegment[], prefix: string): void {
  const mains = segments.filter((sg) => !sg.branch && !sg.overlay);
  let acc = 0;
  const bounds: Array<{ upto: number; x: number; z: number }> = [];
  for (const sg of mains) {
    acc += sg.length;
    bounds.push({ upto: acc, x: sg.bx, z: sg.bz });
  }
  const CHUNK_SPAN = 500;
  const chunkCount = Math.max(1, Math.ceil(acc / CHUNK_SPAN));
  /*
   * A mesh belongs to the chunk nearest its own position, found against the
   * spine. Meshes off the spine - alley furniture, boundary patches - land in
   * whichever chunk their nearest road belongs to, which is the one a player
   * is looking at when they can see them.
   */
  const chunkOf = (x: number, z: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < bounds.length; i += 4) {
      const d = (bounds[i].x - x) ** 2 + (bounds[i].z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return Math.min(chunkCount - 1, Math.floor(bounds[best].upto / CHUNK_SPAN));
  };
  r.bakeGrouped(chunkOf, chunkCount, prefix);
}

export function buildWorld(
  r: Renderer,
  course: Course = DAILY,
  scope: EmitScope = EMIT_ALL,
  /**
   * Colliders already standing, for a window to consult and add to.
   *
   * The vetoes and the racing-line check read this list, so a window handed an
   * empty one decides as though the sections beside it were bare ground - and
   * the seam is precisely where those decisions matter. A streamed world passes
   * its resident set; a one-shot build passes nothing and starts empty.
   */
  into?: StaticCollider[],
  /** Namespace for this build's geometry, so a window can be released later. */
  chunkPrefix = "world",
  /**
   * Segments and terrain that already exist, to be consulted rather than rebuilt.
   *
   * A streamed build emits two sections but has to CONSULT the whole course,
   * and it used to obtain that by rebuilding all of it: every segment, then a
   * fresh terrain grid over them, on every window. That is O(whole course) work
   * to produce O(two sections) of geometry - and it grew as the course did, so
   * the hitch got worse the longer the run lasted. Measured at 37ms of CPU per
   * window against a 16.7ms frame.
   *
   * The streamer already holds both, and they are the same objects this would
   * have produced, so handing them over is not a shortcut - it is not doing
   * the work twice.
   */
  reuse?: { segments: CourseSegment[]; terrain: Terrain },
): BuiltWorld {
  const PROF = (globalThis as unknown as { __profBuild?: Record<string, number> }).__profBuild;
  let _t = performance.now();
  const mark = (k: string): void => {
    if (!PROF) return;
    PROF[k] = (PROF[k] ?? 0) + (performance.now() - _t);
    _t = performance.now();
  };
  const segments = reuse?.segments ?? buildCourseSegments(course).segments;
  const terrain = reuse?.terrain ?? new Terrain(segments);
  mark("segments+terrain");
  const colliders: StaticCollider[] = into ?? [];
  /** Every withdrawable block, for the racing-line check once the world is whole. */
  const props: PlacedProp[] = [];

  // Palette. The day's roll picks each style's variant; shades are shifted copies so a
  // run of chunks is not flat.
  const wallShades: Record<string, Rgb[]> = {};
  for (const [name, style] of Object.entries(WALL_STYLE)) {
    const variants = WALL_VARIANTS[name as Exclude<WallStyle, "none">] ?? [style.color];
    const roll = course.wallRolls[name] ?? 0;
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
    /*
     * Deliberately NOT baked into a chunk. It is two triangles the size of the
     * whole world, so whichever chunk it joined inherited a world-sized
     * bounding box and could never be culled - taking seventeen thousand real
     * triangles along with it. Drawn on its own it costs one call.
     */
    { color: [0.12, 0.06, 0.045], emissive: 0.34, isStatic: false },
  );
  floor.position.set((minX + maxX) / 2, -8, (minZ + maxZ) / 2);

  // --- The spine: continuous ribbon ground + decor ------------------------
  const spineSlices = segments.filter((sg) => !sg.branch && !sg.overlay);
  buildSpineRibbons(r, spineSlices, scope);
  mark("ribbons");
  buildSpineDecor(r, spineSlices, colliders, segments, props, scope);
  mark("decor");
  buildSpineWallLines(r, spineSlices, colliders, wallShades, segments, scope, terrain);
  mark("wallLines");
  cliffRailPass(r, spineSlices, colliders, scope, terrain);
  mark("cliffRails");

  // --- Branches and overlays: short straight pieces, box-built as before ---
  for (const seg of segments) {
    if (!seg.branch && !seg.overlay) continue;
    if (!scope.wants(seg)) continue;
    const midX = (seg.ax + seg.bx) / 2;
    const midZ = (seg.az + seg.bz) / 2;
    const midY = (seg.ay + seg.by) / 2;
    const pitch = -Math.atan(seg.grade);
    // Slope makes the ribbon longer than its ground-plane footprint.
    const ribbonLength = seg.length * Math.hypot(1, seg.grade);

    const tint = SECTION_TINT[seg.section] ?? [1, 1, 1];
    const base = SURFACE_COLOR[seg.surface];
    const surfaceColor: Rgb = [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];

    if (seg.branch) {
      /*
       * A SPUR IS THE ROAD MINUS THE ROADS IT MEETS.
       *
       * A spur used to be one square-ended box, and it meets a road at an
       * angle: measured across its width, the road's edge can sit eleven units
       * further along on one side than the other. However that box was cut, one
       * corner lay on the carriageway - a flat wedge on the lane, throwing its
       * own shadow - or fell short of it, leaving a notch of bare void. A spur
       * that crosses a road part-way along, rather than ending at one, had the
       * whole crossing lying on top of it.
       *
       * So the surface is built by subtracting every same-deck carriageway it
       * touches from its own rectangle. The join is then exactly the kerb line,
       * at any angle, and no ground is ever drawn twice. Roads on another deck
       * are left alone - a spur running under a flyover keeps its surface.
       */
      const perpX = seg.dz;
      const perpZ = -seg.dx;
      let pieces: SpurPt[][] = [
        [
          { a: 0, o: -seg.halfWidth },
          { a: seg.length, o: -seg.halfWidth },
          { a: seg.length, o: seg.halfWidth },
          { a: 0, o: seg.halfWidth },
        ],
      ];
      for (const m of segments) {
        if (m.branch || m.overlay || pieces.length === 0) continue;
        const mcx = (m.ax + m.bx) / 2;
        const mcz = (m.az + m.bz) / 2;
        const reach = m.length / 2 + m.halfWidth + seg.length / 2 + seg.halfWidth;
        if ((mcx - midX) ** 2 + (mcz - midZ) ** 2 > reach * reach) continue;

        // Lateral offset from the main's centre line, and distance along it -
        // both linear in the spur's own coordinates.
        const rx = seg.ax - m.ax;
        const rz = seg.az - m.az;
        const c0 = rx * m.dz - rz * m.dx;
        const ca = seg.dx * m.dz - seg.dz * m.dx;
        const co = perpX * m.dz - perpZ * m.dx;
        const e0 = rx * m.dx + rz * m.dz;
        const ea = seg.dx * m.dx + seg.dz * m.dz;
        const eo = perpX * m.dx + perpZ * m.dz;
        const across = (pt: SpurPt) => c0 + ca * pt.a + co * pt.o;
        const along = (pt: SpurPt) => e0 + ea * pt.a + eo * pt.o;
        const inside: Array<(p: SpurPt) => number> = [
          (pt) => m.halfWidth - across(pt),
          (pt) => m.halfWidth + across(pt),
          (pt) => along(pt),
          (pt) => m.length - along(pt),
        ];

        const next: SpurPt[][] = [];
        for (const piece of pieces) {
          const overlap = piece.reduce(
            (acc, pt) => acc && inside.every((f) => f(pt) > -0.001),
            true,
          );
          const touches = overlap || inside.every((f) => piece.some((pt) => f(pt) > 0));
          if (!touches) {
            next.push(piece);
            continue;
          }
          // Same deck only, judged at the middle of what would be removed.
          const kept = inside.reduce((poly, f) => clipHalf(poly, f), piece);
          if (kept.length < 3 || polyArea(kept) < 0.05) {
            next.push(piece);
            continue;
          }
          let ca2 = 0;
          let co2 = 0;
          for (const pt of kept) {
            ca2 += pt.a / kept.length;
            co2 += pt.o / kept.length;
          }
          const yHere = seg.ay + ((seg.by - seg.ay) * ca2) / seg.length;
          const yThere = m.ay + ((m.by - m.ay) * along({ a: ca2, o: co2 })) / m.length;
          if (Math.abs(yHere - yThere) > SAME_DECK) {
            next.push(piece);
            continue;
          }
          next.push(...subtractConvex(piece, inside));
        }
        pieces = next;
      }

      const pos: number[] = [];
      const norm: number[] = [];
      const idx: number[] = [];
      const skirtPos: number[] = [];
      const skirtNorm: number[] = [];
      const skirtIdx: number[] = [];
      const at = (pt: SpurPt): [number, number, number] => [
        seg.ax + seg.dx * pt.a + perpX * pt.o,
        seg.ay + ((seg.by - seg.ay) * pt.a) / seg.length,
        seg.az + seg.dz * pt.a + perpZ * pt.o,
      ];
      /*
       * A curtain hanging from the surface's own edge, in place of the wide
       * dark box that used to sit under a spur. That box was square and a
       * little wider than the surface above it, so wherever the surface was
       * cut back the box was left showing on the carriageway - the dark patch
       * at the mouth. Hung from the edge it can never rise above the surface
       * it hangs from, and it still closes the void at a dead end.
       */
      for (const piece of pieces) {
        if (piece.length < 3) continue;
        const v = piece.map(at);
        for (let i = 1; i < v.length - 1; i++) {
          pushQuad(pos, norm, idx, v[0], v[i], v[i + 1], v[i + 1]);
        }
        for (let i = 0; i < v.length; i++) {
          const a = v[i];
          const b = v[(i + 1) % v.length];
          /*
           * Only edges that open onto nothing get one. An edge made BY a cut has
           * road on the far side of it, and a spur's plane can sit a little above
           * the carriageway it meets, so a curtain there showed as a black line
           * ruled across the lane.
           */
          const mid = {
            a: (piece[i].a + piece[(i + 1) % piece.length].a) / 2,
            o: (piece[i].o + piece[(i + 1) % piece.length].o) / 2,
          };
          if (overSameDeckMain(segments, seg, mid)) continue;
          const nx = a[2] - b[2];
          const nz = b[0] - a[0];
          const nl = Math.hypot(nx, nz) || 1;
          const bi = skirtPos.length / 3;
          for (const q of [a, b, [b[0], b[1] - 14, b[2]], [a[0], a[1] - 14, a[2]]] as const) {
            skirtPos.push(q[0], q[1], q[2]);
          }
          for (let k = 0; k < 4; k++) skirtNorm.push(nx / nl, 0.2, nz / nl);
          skirtIdx.push(bi, bi + 1, bi + 2, bi, bi + 2, bi + 3);
        }
      }

      if (idx.length > 0) {
        const surface = r.createMesh(
          {
            kind: "custom",
            geometry: {
              positions: new Float32Array(pos),
              normals: new Float32Array(norm),
              indices: new Uint32Array(idx),
            },
          },
          { color: [...surfaceColor] as Rgb, emissive: 0.3, isStatic: true },
        );
        surface.position.set(0, 0, 0);
        const under = r.createMesh(
          {
            kind: "custom",
            geometry: {
              positions: new Float32Array(skirtPos),
              normals: new Float32Array(skirtNorm),
              indices: new Uint32Array(skirtIdx),
            },
          },
          { color: [0.11, 0.1, 0.1], emissive: 0.18, isStatic: true },
        );
        under.position.set(0, 0, 0);
      }
    }

    // Overlays keep the plain box - they lie along a road, never across one.
    if (!seg.branch) {
      const road = r.createMesh(
        { kind: "box", width: seg.halfWidth * 2, height: ROAD_THICKNESS, depth: ribbonLength },
        {
          color: [...surfaceColor] as Rgb,
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
      road.position.set(midX, midY - ROAD_THICKNESS / 2 + (seg.overlay ? OVERLAY_RAISE : 0), midZ);
      road.rotation.y = seg.heading;
      road.rotation.x = pitch;
    }

    /*
     * Centre line on sealed roads only.
     *
     * Only overlays reach this: the loop has already skipped the spine, and a
     * branch is excluded here. Nothing generates an overlay today, so none of
     * the offsets below are on screen - they are kept correct rather than
     * merely unchanged, since an offset nobody can see is exactly the kind that
     * gets left behind when the surface under it moves.
     */
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
          seg.ay + (seg.by - seg.ay) * t + OVERLAY_RAISE + DASH_LIFT,
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
      lip.position.set(
        seg.bx,
        seg.by + (seg.overlay ? OVERLAY_RAISE : 0) + RAMP_LIP_LIFT,
        seg.bz,
      );
      lip.rotation.y = seg.heading;
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

        if (seg.wall !== "none") buildWalls(r, seg, colliders, wallShades, segments, terrain);
    if (seg.capEnd) capDeadEnd(r, seg, colliders, wallShades, terrain);
    buildProps(r, seg, colliders, segments, props);
  }

  sealBoundary(r, segments, colliders, wallShades, terrain, scope);
  mark("sealBoundary");

  /*
   * Last, once every wall, cap and block exists: prove the road is drivable end
   * to end, and withdraw whatever is not.
   */
  const withdrawn = enforceRacingLine(segments, colliders, props, scope);
  mark("racingLine");

  // No gate: endless mode has no finish to build.

  const nav = NavGraph.fromCourse(segments);

  /*
   * Bake the scenery in chunks along the course rather than one buffer.
   *
   * Fog closes at six hundred units and the course runs to twenty-three
   * thousand, so a single buffer meant submitting the whole world's triangles
   * every frame to show a fraction of one. Chunked by position, only what is
   * near enough to see is drawn - and a chunk is a unit the world can later
   * release, which is what streaming needs.
   */
  bakeInChunks(r, segments, chunkPrefix);
  mark("bake");

  return {
    segments,
    terrain,
    colliders,
    nav,
    /** Blocks the racing-line check had to withdraw. Zero is the healthy number. */
    blocksWithdrawn: withdrawn,
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

/**
 * How far inside a MAIN carriageway does this point sit?
 *
 * Zero when it is off the sealed road, positive by however many units it
 * intrudes. `onOtherRoad` cannot answer this: it deliberately ignores nearby
 * slices of the road a wall belongs to, because on a curve a wall is
 * legitimately close to slices a few dozen indices away. But "close to" is not
 * "standing in" - and on a tight inside bend the offset wall line folds across
 * its own road, which that exemption waves straight through. Whole
 * carriageways were being walled off this way, which is what a chokehold with
 * no explanation looks like.
 */
function roadPenetration(
  segments: CourseSegment[],
  x: number,
  z: number,
  baseY: number,
  topY: number,
  terrain?: Terrain,
): number {
  const near = terrain?.segmentsNear(x, z);
  const list = near ?? segments;
  let worst = 0;
  for (let li = 0; li < list.length; li++) {
    const seg = near ? segments[near[li]] : (list[li] as CourseSegment);
    if (seg.branch || seg.overlay) continue;
    const rx = x - seg.ax;
    const rz = z - seg.az;
    const along = rx * seg.dx + rz * seg.dz;
    if (along < 0 || along > seg.length) continue;
    const across = Math.abs(rx * seg.dz - rz * seg.dx);
    if (across >= seg.halfWidth) continue;
    /*
     * Does this thing actually stand in the way?
     *
     * Not "is it on the same deck" - that question let a spur wall whose base
     * sat two units above a road count as a different deck and stay, while its
     * collider rose thirteen units and stopped the car dead. The collision
     * world's rule is the only one that matters: you pass over a solid only if
     * you are above its top. So a wall is an obstruction unless it clears the
     * road high enough to drive under, or is buried below its surface.
     */
    const hRoad = seg.ay + (seg.by - seg.ay) * (along / seg.length);
    if (topY < hRoad + 0.3) continue;
    if (baseY > hRoad + DRIVE_UNDER) continue;
    const bite = seg.halfWidth - across;
    if (bite > worst) worst = bite;
  }
  return worst;
}

/** Deepest a wall may sit inside a carriageway before it is simply not built. */
const WALL_BITE_LIMIT = 1.0;
/** Clearance a structure needs above a road for a car to pass beneath it. */
const DRIVE_UNDER = 3.0;

/**
 * Does any part of this wall box stand meaningfully inside a carriageway?
 * Sampled over the footprint, because thickness is exactly what the centre-line
 * test misses.
 */
function wallEatsRoad(
  segments: CourseSegment[],
  cx: number,
  cz: number,
  baseY: number,
  topY: number,
  halfLength: number,
  halfWidth: number,
  heading: number,
  terrain?: Terrain,
): boolean {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const rx = fz;
  const rz = -fx;
  const nA = Math.max(2, Math.ceil((halfLength * 2) / 1.5));
  const nB = Math.max(2, Math.ceil((halfWidth * 2) / 1.5));
  for (let i = 0; i <= nA; i++) {
    const a = -1 + (2 * i) / nA;
    for (let j = 0; j <= nB; j++) {
      const b = -1 + (2 * j) / nB;
      const x = cx + fx * halfLength * a + rx * halfWidth * b;
      const z = cz + fz * halfLength * a + rz * halfWidth * b;
      if (roadPenetration(segments, x, z, baseY, topY, terrain) > WALL_BITE_LIMIT) return true;
    }
  }
  return false;
}

/**
 * Does a wall's FOOTPRINT land on another road?
 *
 * `onOtherRoad` answers for a point, and every wall builder used to ask about
 * its centre line only. A canyon wall is ten units thick: a chunk whose centre
 * sits comfortably off a crossing road still reaches four to six units onto its
 * carriageway, and that is a wall standing in the road with nothing to explain
 * it - the chokehold at an alley mouth. Asking with the corners and edge
 * midpoints of the actual box costs eight point tests and cannot be fooled by
 * thickness.
 */
function wallFootprintOnRoad(
  segments: CourseSegment[],
  self: CourseSegment,
  cx: number,
  cz: number,
  halfLength: number,
  halfWidth: number,
  heading: number,
  margin: number,
  terrain?: Terrain,
): boolean {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const rx = fz;
  const rz = -fx;
  // Sample density follows the box, not a fixed grid: a thirteen-unit chunk
  // tested at its corners alone can straddle a road that fits between them.
  const STRIDE = 1.5;
  const nA = Math.max(2, Math.ceil((halfLength * 2) / STRIDE));
  const nB = Math.max(2, Math.ceil((halfWidth * 2) / STRIDE));
  for (let i = 0; i <= nA; i++) {
    const a = -1 + (2 * i) / nA;
    for (let j = 0; j <= nB; j++) {
      const b = -1 + (2 * j) / nB;
      const x = cx + fx * halfLength * a + rx * halfWidth * b;
      const z = cz + fz * halfLength * a + rz * halfWidth * b;
      if (onOtherRoad(segments, self, x, z, margin, terrain)) return true;
    }
  }
  return false;
}

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
    if (Math.abs(across) <= other.halfWidth + margin) {
      /*
       * HEIGHT-AWARE: a road three car-heights BELOW is not a road this one
       * connects to - it is a deck of the switchback passing underneath.
       * The 2D veto was deleting every rail along elevated bends that
       * crossed above lower roads or alley tips, leaving an unguarded
       * cliff edge the player sailed off ('through the floor, around the
       * bend'). Grade-separated neighbours keep their walls.
       */
      const hOther =
        other.ay + other.grade * Math.max(0, Math.min(other.length, along));
      const sx = x - self.ax;
      const sz = z - self.az;
      const selfAlong = Math.max(0, Math.min(self.length, sx * self.dx + sz * self.dz));
      const hSelf = self.ay + self.grade * selfAlong;
      if (Math.abs(hOther - hSelf) <= 2.2) return true;
    }
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
/** Deck gap above which a road crossing a spur is a bridge, not a junction. */
const SAME_DECK = 1.2;

/** A point in a spur's own frame: `a` along it, `o` across it. */
interface SpurPt {
  a: number;
  o: number;
}

/**
 * Does a main road's carriageway lie at this point on the spur, on the same deck?
 * Used to tell an edge that was cut by a road from one that opens onto the void.
 */
function overSameDeckMain(segments: CourseSegment[], seg: CourseSegment, pt: SpurPt): boolean {
  const x = seg.ax + seg.dx * pt.a + seg.dz * pt.o;
  const z = seg.az + seg.dz * pt.a - seg.dx * pt.o;
  const y = seg.ay + ((seg.by - seg.ay) * pt.a) / seg.length;
  for (const m of segments) {
    if (m.branch || m.overlay) continue;
    const rx = x - m.ax;
    const rz = z - m.az;
    const along = rx * m.dx + rz * m.dz;
    if (along < -0.05 || along > m.length + 0.05) continue;
    if (Math.abs(rx * m.dz - rz * m.dx) > m.halfWidth + 0.05) continue;
    if (Math.abs(y - (m.ay + ((m.by - m.ay) * along) / m.length)) <= SAME_DECK) return true;
  }
  return false;
}

/** Keep the part of a convex polygon where `f` is positive. */
function clipHalf(poly: SpurPt[], f: (p: SpurPt) => number): SpurPt[] {
  const out: SpurPt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const dc = f(cur);
    const dn = f(nxt);
    if (dc >= 0) out.push(cur);
    if (dc >= 0 !== dn >= 0) {
      const t = dc / (dc - dn);
      out.push({ a: cur.a + (nxt.a - cur.a) * t, o: cur.o + (nxt.o - cur.o) * t });
    }
  }
  return out;
}

function polyArea(poly: SpurPt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i];
    const n = poly[(i + 1) % poly.length];
    sum += c.a * n.o - n.a * c.o;
  }
  return Math.abs(sum) / 2;
}

/**
 * Cut a convex region out of a convex polygon, exactly.
 *
 * `inside` is the region to remove, given as half-planes that are all positive
 * within it. Taking the outside of each in turn, while keeping the inside of
 * the ones already handled, tiles the difference with convex pieces - which is
 * what lets the join be a true straight line along the kerb instead of a
 * stepped or tapered approximation of one.
 */
function subtractConvex(poly: SpurPt[], inside: Array<(p: SpurPt) => number>): SpurPt[][] {
  const pieces: SpurPt[][] = [];
  let rest = poly;
  for (const plane of inside) {
    if (rest.length < 3) break;
    const outer = clipHalf(rest, (pt) => -plane(pt));
    if (outer.length >= 3 && polyArea(outer) > 0.05) pieces.push(outer);
    rest = clipHalf(rest, plane);
  }
  // `rest` is what lies inside every plane: the removed region itself.
  return pieces;
}

/** One flat-shaded quad in world space; normal derived, forced to face up. */
function pushQuad(
  pos: number[],
  norm: number[],
  idx: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  up = true,
): void {
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
  if (up && ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const base = pos.length / 3;
  for (const v of [a, b, c, d]) pos.push(v[0], v[1], v[2]);
  for (let k = 0; k < 4; k++) norm.push(nx, ny, nz);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function buildSpineRibbons(r: Renderer, spine: CourseSegment[], scope: EmitScope): void {
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
    let runLength = 0;
    for (let k = runStart; k < i; k++) runLength += spine[k].length;
    if (
      i < spine.length &&
      runLength < RIBBON_BLOCK &&
      scope.wants(spine[i]) === scope.wants(spine[runStart]) &&
      sameColor(colorOf(spine[i]), colorOf(spine[runStart]))
    ) {
      continue;
    }
    // Rows are built from the whole spine so the ribbon lines up across a seam;
    // only the runs this window owns are actually emitted.
    if (!scope.wants(spine[runStart])) {
      runStart = i;
      continue;
    }
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

  /*
   * Grass shoulders, in blocks along the course rather than one mesh.
   *
   * As a single mesh this ran the whole twenty-three kilometres, which made it
   * one indivisible object with a bounding box the size of the world - never
   * cullable, and never releasable by a streamed world. Cut into blocks it is
   * the same geometry, in pieces that can be skipped when they are behind you.
   */
  {
    let pos: number[] = [];
    let norm: number[] = [];
    let idx: number[] = [];
    let block = 0;
    for (let k = 0; k < spine.length; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      block += Math.hypot(r1.x - r0.x, r1.z - r0.z);
      if (block > RIBBON_BLOCK) {
        emit(pos, norm, idx, SURFACE_COLOR.grass, 0.3);
        pos = [];
        norm = [];
        idx = [];
        block = 0;
      }
      if (r0.s < 0.08 && r1.s < 0.08) continue;
      if (!scope.wants(spine[k])) continue;
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

  /*
   * A dark-earth berm just beyond the drivable edge, both sides, the whole way. The
   * boundary's small diagonal overlaps left slivers of raw void visible at the edge,
   * and being knocked toward one read as being knocked out of the world. The berm is
   * deliberately not grass - it finishes the ground without promising drivability,
   * which is the mistake the old mouth pads made.
   */
  {
    let pos: number[] = [];
    let norm: number[] = [];
    let idx: number[] = [];
    let block = 0;
    for (let k = 0; k < spine.length; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      block += Math.hypot(r1.x - r0.x, r1.z - r0.z);
      if (block > RIBBON_BLOCK) {
        emit(pos, norm, idx, [0.17, 0.12, 0.08], 0.24);
        pos = [];
        norm = [];
        idx = [];
        block = 0;
      }
      if (!scope.wants(spine[k])) continue;
      for (const side of [-1, 1]) {
        quad(pos, norm, idx,
          [r0.x + r0.px * (r0.w + r0.s) * side, r0.y - 0.1, r0.z + r0.pz * (r0.w + r0.s) * side],
          [r0.x + r0.px * (r0.w + r0.s + 2.6) * side, r0.y - 0.1, r0.z + r0.pz * (r0.w + r0.s + 2.6) * side],
          [r1.x + r1.px * (r1.w + r1.s + 2.6) * side, r1.y - 0.1, r1.z + r1.pz * (r1.w + r1.s + 2.6) * side],
          [r1.x + r1.px * (r1.w + r1.s) * side, r1.y - 0.1, r1.z + r1.pz * (r1.w + r1.s) * side]);
      }
    }
    emit(pos, norm, idx, [0.17, 0.12, 0.08], 0.24);
  }

  // Dark skirts at the outer edge, so the ground reads as cut into the world.
  // Blocked along the course like the surfaces above it, and for the same
  // reason: one mesh the length of the world can be neither culled nor freed.
  {
    let pos: number[] = [];
    let norm: number[] = [];
    let idx: number[] = [];
    let block = 0;
    for (let k = 0; k < spine.length; k++) {
      const r0 = rows[k];
      const r1 = rows[k + 1];
      block += Math.hypot(r1.x - r0.x, r1.z - r0.z);
      if (block > RIBBON_BLOCK) {
        emit(pos, norm, idx, [0.11, 0.1, 0.1], 0.18);
        pos = [];
        norm = [];
        idx = [];
        block = 0;
      }
      if (!scope.wants(spine[k])) continue;
      for (const side of [-1, 1]) {
        vquad(pos, norm, idx,
          [r0.x + r0.px * (r0.w + r0.s + 2.6) * side, r0.y - 0.1, r0.z + r0.pz * (r0.w + r0.s + 2.6) * side],
          [r1.x + r1.px * (r1.w + r1.s + 2.6) * side, r1.y - 0.1, r1.z + r1.pz * (r1.w + r1.s + 2.6) * side],
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
  props: PlacedProp[],
  scope: EmitScope,
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
    // Consulted for arc bookkeeping either way; only emitted for this window.
    if (!scope.wants(seg)) continue;
    // Ramp lip marker, exactly as before.
    if (seg.ramp > 0) {
      const lip = r.createMesh(
        { kind: "box", width: seg.halfWidth * 2, height: 0.5, depth: 2.2 },
        { color: [0.95, 0.75, 0.1], emissive: 0.6, isStatic: true },
      );
      lip.position.set(seg.bx, seg.by + RAMP_LIP_LIFT, seg.bz);
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
          seg.ay + seg.grade * seg.length * t + DASH_LIFT,
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
      placePropStation(r, seg, colliders, px, pz, groundY, stationCount, onBranchRoad, props);
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
  props: PlacedProp[],
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
    addCollider(colliders, cx, cz, w * 0.7, w / 2, seg.heading, groundY + height, "spineProp", groundY);
    props.push({ mesh, collider: colliders[colliders.length - 1] });
  };

  const roll = hash2(px * 1.31, pz * 0.73);
  if (roll > 0.62) return; // leave gaps so the route never fully closes
  /*
   * Gates - a block on each edge - only where the road is genuinely wide. In the
   * narrowest sections the pair squeezed the lane from both sides at once and read as
   * a chokehold, and the tightened daily widths made it common. One block against a
   * kerb is a decision; two facing blocks in a corridor is a wall with a slot.
   */
  const mode =
    roll < 0.09 && seg.halfWidth - size / 2 >= 5.5 ? "centre"
    : roll < 0.17 && seg.halfWidth >= 8.6 && seg.halfWidth >= 3.4 + size + 0.5 ? "gate"
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
      /*
       * The outside lane has to be real. A block that leaves less than a car's width
       * of daylight to the wall reads as a lane and drives as a trap, which is worse
       * than no lane: the old 0.4 clearance kept the block off the wall and nothing
       * more. 3.4 matches the centre slot's half-spacing - proven drivable - and is
       * measured against the collider (0.7 of full size), which is wider than the
       * visual block. A side that cannot afford it simply goes without, demoting
       * the gate to a single kerb block.
       */
      if (seg.halfWidth - (Math.abs(lateral) + size * 0.7) < 3.4) continue;
      drop(px + rx * lateral, pz + rz * lateral, size);
    }
    return;
  }
  const side = station % 2 === 0 ? 1 : -1;
  const lateral = (seg.halfWidth - 2.2) * side;
  drop(px + rx * lateral, pz + rz * lateral, size);
}

/*
 * Fence the whole spine with walls that follow the WALL LINE, not the road spine.
 *
 * The old per-segment builder placed the same chunks at a fixed offset on both sides
 * of every slice - but on a bend the outer wall line is longer than the spine and the
 * inner one shorter, so the outside opened black gaps a car could be shoved through
 * while the inside crammed blocks into jagged teeth. This builder computes the mitred
 * offset polyline per side (the ribbon ground's own geometry), marches ITS arc length,
 * and fits chunks to it: the inner line simply gets fewer, shorter chunks and the
 * outer more - both continuous by construction. Colliders overlap joint-to-joint so
 * the collision surface is one unbroken rail.
 */
function buildSpineWallLines(
  r: Renderer,
  slices: CourseSegment[],
  colliders: StaticCollider[],
  wallShades: Record<string, Rgb[]>,
  segments: CourseSegment[],
  scope: EmitScope,
  terrain?: Terrain,
): void {
  if (slices.length === 0) return;
  const heightAt = (x: number, z: number, fallback: number): number =>
    terrain ? terrain.heightAt(x, z) : fallback;

  for (let side = -1; side <= 1; side += 2) {
    let run: { x: number; z: number; seg: CourseSegment }[] = [];
    let runStyle: Exclude<WallStyle, "none"> | null = null;

    /*
     * THE SMOOTH RAIL - collision only, no mesh.
     *
     * One collider per segment of the wall's own polyline, centred on the
     * line at its true thickness. However varied the blocks above are, the
     * surface a car slides along is this: continuous, with no corner poking
     * out of it anywhere.
     */
    const railRun = (
      pts: { x: number; z: number; seg: CourseSegment }[],
      styleName: Exclude<WallStyle, "none">,
    ) => {
      const style = WALL_STYLE[styleName];
      const halfT = style.thickness / 2;
      for (let i = 0; i < pts.length - 1; i++) {
        const cx = (pts[i].x + pts[i + 1].x) / 2;
        const cz = (pts[i].z + pts[i + 1].z) / 2;
        const span = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
        if (span < 0.2) continue;
        const heading = Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
        if (!scope.wants(pts[i].seg)) continue;
        if (
          wallFootprintOnRoad(
            segments,
            pts[i].seg,
            cx,
            cz,
            span / 2 + 0.2,
            halfT,
            heading,
            JUNCTION_CLEARANCE,
            terrain,
          )
        ) {
          continue;
        }
        const groundY = heightAt(cx, cz, pts[i].seg.ay);
        // ...and never on its OWN road either, which a folded offset line does.
        if (
          wallEatsRoad(
            segments,
            cx,
            cz,
            groundY,
            groundY + style.maxHeight,
            span / 2 + 0.2,
            halfT,
            heading,
            terrain,
          )
        ) {
          continue;
        }
        addCollider(colliders, cx, cz, span / 2 + 0.2, halfT, heading, groundY + style.maxHeight, "wallRail", groundY);
      }
    };

    const flushRun = () => {
      const pts = run;
      const styleName = runStyle;
      run = [];
      runStyle = null;
      if (!styleName || pts.length < 2) return;
      const style = WALL_STYLE[styleName];
      const shades = wallShades[styleName];
      railRun(pts, styleName);
      // Arc lengths along the wall line itself.
      const arc: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        arc.push(arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      }
      const total = arc[arc.length - 1];
      if (total < 2) return;
      const count = Math.max(1, Math.round(total / style.chunk));
      const at = (a: number): { x: number; z: number; seg: CourseSegment } => {
        let i = 1;
        while (i < arc.length - 1 && arc[i] < a) i++;
        const t = (a - arc[i - 1]) / Math.max(0.001, arc[i] - arc[i - 1]);
        return {
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
          z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
          seg: pts[i - 1].seg,
        };
      };
      for (let i = 0; i < count; i++) {
        const a0 = (i / count) * total;
        const a1 = ((i + 1) / count) * total;
        const P0 = at(a0);
        const P1 = at(a1);
        const cx = (P0.x + P1.x) / 2;
        const cz = (P0.z + P1.z) / 2;
        const span = Math.hypot(P1.x - P0.x, P1.z - P0.z);
        if (span < 0.8) continue;
        const heading = Math.atan2(P1.x - P0.x, P1.z - P0.z);
        const seg = P0.seg;
        /*
         * The blocks are the visible wall, and they were the one pass left
         * unscoped: the collider rail beside them was already limited to this
         * window, but every window was rebuilding the whole course's wall
         * meshes. Four resident windows therefore held four copies of the
         * scenery, which is how a streamed world ended up carrying twice the
         * geometry of the fixed one it replaced.
         */
        if (!scope.wants(seg)) continue;
        // Junction and spur mouths stay open: never wall across a connecting road.
        if (
          onOtherRoad(segments, seg, cx, cz, JUNCTION_CLEARANCE, terrain) ||
          onOtherRoad(segments, seg, P0.x, P0.z, JUNCTION_CLEARANCE, terrain) ||
          onOtherRoad(segments, seg, P1.x, P1.z, JUNCTION_CLEARANCE, terrain)
        ) {
          continue;
        }
        const y0 = heightAt(P0.x, P0.z, seg.ay);
        const y1 = heightAt(P1.x, P1.z, seg.by);
        const groundY = (y0 + y1) / 2;
        const rnd = hash2(cx, cz);
        const height = style.minHeight + rnd * (style.maxHeight - style.minHeight);
        const mesh = r.createMesh(
          { kind: "box", width: style.thickness, height, depth: span * 1.06 },
          {
            color: [...shades[Math.floor(rnd * 997) % shades.length]],
            emissive: 0.24,
            isStatic: true,
          },
        );
        mesh.position.set(cx, groundY + height / 2, cz);
        mesh.rotation.y = heading;
        mesh.rotation.x = -Math.atan((y1 - y0) / Math.max(0.001, span));
        /*
         * MESH ONLY. The blocks are the look and nothing else now - their
         * corners were what a car caught on. Collision for this run is one
         * continuous rail laid along the wall's own centre line, built in
         * `railRun` below.
         */
      }
    };

    for (let i = 0; i < slices.length; i++) {
      const seg = slices[i];
      const prev = i > 0 ? slices[i - 1] : null;
      const contiguous = prev !== null && Math.hypot(seg.ax - prev.bx, seg.az - prev.bz) < 1.5;
      const wall = seg.wall as WallStyle;
      if (!contiguous || wall === "none" || wall !== runStyle) flushRun();
      if (wall === "none") continue;
      // Mitred perp at this slice's A-joint: average of the adjacent directions,
      // scaled so the offset line stays parallel through the corner.
      let px = seg.dz;
      let pz = -seg.dx;
      if (prev !== null && contiguous) {
        const mx = prev.dz + seg.dz;
        const mz = -prev.dx - seg.dx;
        const ml = Math.hypot(mx, mz) || 1;
        const cosHalf = Math.max(0.45, (mx / ml) * seg.dz + (mz / ml) * -seg.dx);
        px = (mx / ml) / cosHalf;
        pz = (mz / ml) / cosHalf;
      }
      const styleName = wall as Exclude<WallStyle, "none">;
      const offset = seg.halfWidth + seg.shoulder + WALL_STYLE[styleName].thickness / 2;
      if (runStyle === null) runStyle = styleName;
      /*
       * The run is accumulated from every slice so the wall line is mitred
       * across a seam exactly as it would be in a single build; each point
       * remembers its slice, and only the pieces belonging to this window are
       * emitted when the run is flushed.
       */
      run.push({ x: seg.ax + px * offset * side, z: seg.az + pz * offset * side, seg });
      // Close the final joint of the course with the last slice's own perp.
      if (i === slices.length - 1) {
        run.push({
          x: seg.bx + seg.dz * offset * side,
          z: seg.bz - seg.dx * offset * side,
          seg,
        });
        flushRun();
      }
    }
    flushRun();
  }
}

/*
 * THE CLIFF-RAIL PASS - the last line of wall building, on every seed.
 *
 * Whatever the themed wall rules decided, no drivable edge may stand open
 * above a drop: theme exemptions, junction vetoes and stub-chain seams have
 * each been caught deleting the rail off an elevated bend, and a player
 * carrying speed around one sailed off into the void ('through the floor,
 * around the bend'). This pass re-walks every spine slice, probes just past
 * the run-off on each side, and where the ground falls away with no collider
 * standing there, it plants a plain guard rail. Belt, braces, every seed.
 */
function cliffRailPass(
  r: Renderer,
  slices: CourseSegment[],
  colliders: StaticCollider[],
  scope: EmitScope,
  terrain?: Terrain,
): void {
  if (!terrain) return;
  const style = WALL_STYLE.rail;
  const placed: { x: number; z: number }[] = [];
  for (const seg of slices) {
    if (seg.length < 2) continue;
    if (!scope.wants(seg)) continue;
    const midX = (seg.ax + seg.bx) / 2;
    const midZ = (seg.az + seg.bz) / 2;
    const midY = (seg.ay + seg.by) / 2;
    for (let side = -1; side <= 1; side += 2) {
      const off = seg.halfWidth + (seg.shoulder || 0) + 1.6;
      const wx = midX + seg.dz * off * side;
      const wz = midZ - seg.dx * off * side;
      // The drop test, just beyond where a wall would stand.
      const drop = midY - terrain.heightAt(wx + seg.dz * 4 * side, wz - seg.dx * 4 * side);
      if (drop < 2.5) continue;
      // Any collider already guarding this edge?
      let guarded = false;
      for (const c of colliders) {
        const dx = c.obb.x - wx;
        const dz = c.obb.z - wz;
        if (dx * dx + dz * dz < 49) {
          guarded = true;
          break;
        }
      }
      if (!guarded) {
        for (const q of placed) {
          const dx = q.x - wx;
          const dz = q.z - wz;
          if (dx * dx + dz * dz < 25) {
            guarded = true;
            break;
          }
        }
      }
      if (guarded) continue;
      const span = Math.max(seg.length + 2, 8);
      const heading = Math.atan2(seg.dx, seg.dz);
      const h = style.minHeight;
      const mesh = r.createMesh(
        { kind: "box", width: style.thickness, height: h, depth: span },
        { color: [...style.color], emissive: 0.24, isStatic: true },
      );
      mesh.position.set(wx, midY + h / 2, wz);
      mesh.rotation.y = heading;
      addCollider(colliders, wx, wz, span / 2 + 0.35, style.thickness / 2, heading, midY + h, "branchWall", midY);
      placed.push({ x: wx, z: wz });
    }
  }
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
      // The whole box, not its centre line: a thick style reaches onto a
      // crossing road from a centre that is nowhere near it.
      if (
        wallFootprintOnRoad(
          segments,
          seg,
          cx,
          cz,
          halfChunk,
          style.thickness / 2,
          seg.heading,
          clear,
          terrain,
        ) ||
        wallEatsRoad(
          segments,
          cx,
          cz,
          groundY,
          groundY + style.maxHeight,
          halfChunk,
          style.thickness / 2,
          seg.heading,
          terrain,
        )
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
        "branchWallChunk",
        groundY,
      );
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
  scope: EmitScope,
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
  /** Patch pieces laid this build; linked into one barrier at the end. */
  /*
   * `heading` is the direction the boundary runs at this piece, which is the
   * one thing a lone piece needs later and cannot recover on its own: the
   * segment nearest a point out on the boundary is not reliably the segment
   * whose edge put it there - at a spur mouth it is the spur, square across the
   * wall - so re-deriving it from position produced pieces laid at right angles
   * to the fence they belong to.
   */
  const sealPieces: { x: number; z: number; top: number; heading: number }[] = [];
  const piece = (
    x: number,
    z: number,
    ox: number,
    oz: number,
    heading: number,
    halfLen: number,
    theme: string,
    meshJitter = 0,
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
    if (Math.abs(yA - yB) > 1.6) return;
    placed.add(pk);
    /*
     * Sit on the slope, pitched with it, like every wall chunk. Level pieces on rolling
     * ground buried one end and stuck the other out as a jagged spike - the leftover
     * "patchwork" look the ribbon ground was supposed to have ended.
     */
    const groundY = (yA + yB) / 2;
    const rnd = hash2(px, pz);
    const height = style.minHeight + rnd * (style.maxHeight - style.minHeight) * 0.5;
    const mesh = r.createMesh(
      { kind: "box", width: 1.8, height, depth: hl * 2 },
      { color: [...shades[Math.floor(rnd * 997) % shades.length]], emissive: 0.24, isStatic: true },
    );
    /*
     * The anti-shimmer stagger lives on the MESH alone. When the collider carried it
     * too, neighbouring pieces formed quarter-unit lips along the barrier, and a car
     * riding the wall snagged on every joint - the collision surface must be one
     * continuous line even when the faces are deliberately not.
     */
    mesh.position.set(px + ox * meshJitter, groundY + height / 2, pz + oz * meshJitter);
    mesh.rotation.y = heading;
    mesh.rotation.x = -Math.atan((yB - yA) / (2 * hl));
    /*
     * MESH ONLY. Thousands of patch pieces, each nudged outward by its own
     * amount, made a saw-toothed barrier full of pockets - a graze at twelve
     * degrees stopped a car dead. They are scenery now; the barrier a car
     * touches is the chained rail built after every piece is placed.
     */
    sealPieces.push({ x: px, z: pz, top: groundY + height, heading });
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
    // The start barrier belongs to the opening section, not to every window.
    if (head && scope.wants(head)) {
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
      addCollider(colliders, bx, bz, style.thickness / 2, width / 2, head.heading, groundY + height, "capHead", groundY);
    }
  }

  for (const seg of segments) {
    if (seg.overlay) continue;
    // Guard boxes above are gathered from EVERY collider, so a seam is sealed
    // against the walls of the section next door; only this window's own
    // patches are laid.
    if (!scope.wants(seg)) continue;
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
            (ax + bx) / 2,
            (az + bz) / 2,
            seg.dz * side,
            -seg.dx * side,
            heading,
            Math.max(1.6, span / 2 + 0.6),
            seg.wall === "none" ? "fence" : seg.wall,
            jitter,
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
        /*
         * Reach 0.5, not more. The fast path once used 1.4, which also skipped stations
         * sitting in the V-gap between two wall chunks - and on the outside of a hard
         * corner those gaps run three units wide, exactly where the squad shoves you.
         * At 0.5 a genuine wall face still guards its station, but a crack does not.
         */
        if (guarded(qx, qz, 0.5)) { flush(); continue; }
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

  /*
   * THE CHAINED BARRIER. Each piece links to its nearest neighbours and the
   * collider spans centre to centre, so the barrier is one connected chain
   * rather than a row of separate teeth. Links may only run ALONG the
   * boundary - a link more than about fifty degrees off the local road
   * direction would cut across it and close a pocket.
   */
  {
    const CELL2 = 8;
    const grid = new Map<string, number[]>();
    const gkey = (x: number, z: number) => Math.floor(x / CELL2) + ":" + Math.floor(z / CELL2);
    sealPieces.forEach((pc, i) => {
      const k = gkey(pc.x, pc.z);
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    const linked = new Set<string>();
    for (let i = 0; i < sealPieces.length; i++) {
      const a = sealPieces[i];
      const segHere = terrain.sample(a.x, a.z).segment;
      const near: { j: number; d: number }[] = [];
      for (let gx = -1; gx <= 1; gx++) {
        for (let gz = -1; gz <= 1; gz++) {
          const list = grid.get(gkey(a.x + gx * CELL2, a.z + gz * CELL2));
          if (!list) continue;
          for (const j of list) {
            if (j === i) continue;
            const d = Math.hypot(sealPieces[j].x - a.x, sealPieces[j].z - a.z);
            if (d < 9) near.push({ j, d });
          }
        }
      }
      near.sort((p1, p2) => p1.d - p2.d);
      let made = 0;
      for (const nb of near) {
        if (made >= 2) break;
        const b = sealPieces[nb.j];
        const ldx = (b.x - a.x) / (nb.d || 1);
        const ldz = (b.z - a.z) / (nb.d || 1);
        if (Math.abs(ldx * segHere.dx + ldz * segHere.dz) < 0.64) continue;
        const key2 = i < nb.j ? i + "_" + nb.j : nb.j + "_" + i;
        if (linked.has(key2)) continue;
        linked.add(key2);
        made++;
        addCollider(
          colliders,
          (a.x + b.x) / 2,
          (a.z + b.z) / 2,
          nb.d / 2 + 0.5,
          0.75,
          Math.atan2(b.x - a.x, b.z - a.z),
          Math.max(a.top, b.top),
          "sealLink",
          Math.min(a.top, b.top) - 14,
        );
      }
      /*
       * A piece with no neighbour to chain to still has to lie ALONG the
       * boundary, which is the one thing this used to get wrong: the heading
       * was a hard zero, so a 3.8-long block landed pointing down world north
       * whatever direction the wall beside it ran. Measured across a built
       * course, the median lone piece sat 46 degrees across its own wall and
       * the worst sat 90 - a stub jutting nearly two units out of an otherwise
       * flush face. Beside the smooth rail that is what a corner with two
       * prongs and a pocket between them is made of, and a car that clips it
       * does not slide off, it wedges.
       *
       * The links a line above already refuse to form more than about fifty
       * degrees off the road direction, for exactly this reason. This is the
       * same rule applied to the pieces that never found a partner.
       */
      if (made === 0) {
        addCollider(colliders, a.x, a.z, 1.9, 0.75, a.heading, a.top, "sealLone", a.top - 14);
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
  terrain?: Terrain,
): void {
  const style = WALL_STYLE[(seg.wall === "none" ? "fence" : seg.wall) as Exclude<WallStyle, "none">];
  const shades = wallShades[seg.wall === "none" ? "fence" : seg.wall];
  const width = seg.halfWidth * 2 + style.thickness * 2;
  const height = style.minHeight + 0.5;
  const cx = seg.bx + seg.dx * (style.thickness / 2);
  const cz = seg.bz + seg.dz * (style.thickness / 2);

  /*
   * A cap belongs at the dead end of an alley, never across the road. When a
   * spur's ends are recorded the wrong way round its 'far end' lands on the
   * carriageway and the cap becomes a wall to squeeze past - the yellow slab
   * that nearly closed section twenty-two.
   */
  {
    const smpCap = terrain?.sample(cx, cz);
    if (smpCap && smpCap.onCourse && !smpCap.segment.branch) return;
  }

  const mesh = r.createMesh(
    { kind: "box", width, height, depth: style.thickness },
    { color: [...shades[1]], emissive: 0.24, isStatic: true },
  );
  mesh.position.set(cx, seg.by + height / 2, cz);
  mesh.rotation.y = seg.heading;

  addCollider(colliders, cx, cz, style.thickness / 2, width / 2, seg.heading, seg.by + height, "capDeadEnd", seg.by);

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
  props: PlacedProp[],
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
    addCollider(colliders, cx, cz, w * 0.7, w / 2, seg.heading, groundY + height, "branchProp", groundY);
    props.push({ mesh, collider: colliders[colliders.length - 1] });
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

