/**
 * The course, defined as a spine polyline plus the dead-end spurs hanging off it.
 *
 * Each consecutive pair of path nodes becomes a `CourseSegment`: an oriented, sloped,
 * surfaced rectangle. A segment knows enough to generate its own road mesh, its side
 * walls, its nav-graph nodes and its terrain patch, which is what keeps a 20 km course
 * generated rather than authored.
 *
 * The shape itself comes from `generator.ts`; this file turns it into segments and holds
 * the things placed along it.
 */

import { seedForDay } from "../daily";
import { generateCourse } from "./generator";

export type Surface = "asphalt" | "dirt" | "gravel" | "mud" | "grass";

export type SectionId =
  | "downtown"
  | "canyon"
  | "construction"
  | "hills"
  | "industrial"
  | "offroad"
  | "final";

/**
 * How a segment's edges are treated.
 * "open" is the rural case: sparse marker posts far out at the shoulder edge instead of
 * a solid fence, so the section reads as countryside you can drive across.
 */
export type WallStyle = "building" | "barrier" | "rail" | "rock" | "fence" | "open" | "none";

export interface PathNode {
  x: number;
  z: number;
  /** Ground height at this node. */
  y: number;
}

export interface LegDef extends PathNode {
  section: SectionId;
  surface: Surface;
  /** Half the drivable width. */
  halfWidth: number;
  wall: WallStyle;
  /**
   * Drivable grass either side of the road. This is what makes a section feel open: the
   * road is the fast line, but you can run wide, cut a corner, or get shoved off it and
   * still be driving rather than hitting a fence.
   */
  shoulder?: number;
  /**
   * Crossing the END of this leg at speed launches the car. The value scales forward
   * speed into vertical speed. Ramps are explicit rather than emergent so that they stay
   * predictable — the player should always know why they got airborne.
   */
  ramp?: number;
}

/**
 * A dead-end side road the police ambush from.
 *
 * Its mouth sits on the spine; its far end is capped. Police spawn deep inside one and
 * come out sideways as you pass, which is the only way a walled course produces a threat
 * that is not directly ahead or directly behind you.
 */
export interface SpurDef {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  halfWidth: number;
  surface: Surface;
  wall: WallStyle;
  section: SectionId;
  /** Distance along the spine at the mouth, for picking one near the player. */
  progress: number;
}

/** A strip laid over an existing road to change its surface locally. */
export interface StripDef {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y: number;
  halfWidth: number;
  surface: Surface;
  section: SectionId;
}

/** A generated piece of road: an oriented rectangle with a height at each end. */
export interface CourseSegment {
  index: number;
  section: SectionId;
  surface: Surface;
  wall: WallStyle;
  ramp: number;
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  halfWidth: number;
  /** Drivable grass beyond `halfWidth` on each side. */
  shoulder: number;
  /** Unit direction from A to B, and the segment length. */
  dx: number;
  dz: number;
  length: number;
  heading: number;
  /** Height change per unit of distance travelled along the segment. */
  grade: number;
  /** True for branch segments, which are optional routes off the main spine. */
  branch: boolean;
  /** Wall off the far end: this segment is a dead end, not a route. */
  capEnd: boolean;
  /**
   * Overlay strips sit *on top of* another road to vary the surface within it (the firm
   * ruts through the mud). They win terrain sampling over the road beneath them, and are
   * excluded from the nav graph, walls, props and progress.
   */
  overlay: boolean;
  /** Higher wins when several segments contain the same point. */
  priority: number;
  /**
   * Drivable apron extending past each end of the segment, in units.
   *
   * Consecutive legs meet at an angle, and the wedge between their run-off rectangles
   * was dead black ground standing inside the course walls - unplayable, force-fielded
   * by the off-course push, and wrong-looking. The extensions fill those wedges with
   * grass. Zero where continuation would break something: behind the start line, past a
   * dead-end cap, and past a ramp lip, where the jump needs the ground to fall away.
   */
  extA: number;
  extB: number;
}

// ---------------------------------------------------------------------------
// The spine
// ---------------------------------------------------------------------------

export const COURSE_START: PathNode = { x: 0, z: -140, y: 0 };
export const START_HEADING = 0; // facing +Z

/**
 * How many sections the world is built with.
 *
 * Endless mode has no finish, but the world is still generated once up front rather than
 * streamed: it keeps building, batching and collider indexing to a single startup pass.
 * The difficulty ramp ends runs long before anyone sees the end of this.
 */
export const SECTION_COUNT = 40;

/**
 * Today's course.
 *
 * Built once at module load from the day's seed, so everybody driving the challenge on a
 * given day drives an identical map and nothing has to be fetched to know what it is. A
 * page left open across the rollover keeps yesterday's course until it is reloaded, which
 * the intro card's countdown makes visible.
 */
const GENERATED = generateCourse(SECTION_COUNT, seedForDay());

export const MAIN_LEGS: LegDef[] = GENERATED.legs;
/** Ambush spurs, in course order. */
export const SPURS: SpurDef[] = GENERATED.spurs;
/** Distance along the spine where each section starts. */
export const SECTION_STARTS = GENERATED.sectionStarts;
/**
 * Theme per section. These drive surfacing, walls and props only — sections are numbered,
 * not named. A run has no destination, so "FINAL APPROACH" was a promise the game does not
 * keep, and a number is the honest label for how far you have got.
 */
export const SECTION_THEMES = GENERATED.sectionNames;
/** The day's palette rolls, one per wall style. */
export const WALL_ROLLS = GENERATED.wallRolls;

/** Which section (0-based) a given distance along the course falls in. */
export function sectionIndexAt(progress: number): number {
  let i = 0;
  while (i + 1 < SECTION_STARTS.length && progress >= SECTION_STARTS[i + 1]) i++;
  return i;
}

/**
 * Optional branches. Each rejoins the spine, so taking one is a routing decision rather
 * than a detour that has to be undone. `fromLeg` / `toLeg` index into MAIN_LEGS and are
 * used to wire the nav graph back together.
 */
export interface BranchDef {
  name: string;
  /** Drives the colour of the fork marker: supply routes are orange, shortcuts cyan. */
  kind: "supply" | "shortcut";
  /** Index of the main leg whose END the branch departs from. */
  fromLeg: number;
  /** Index of the main leg whose END the branch rejoins. */
  toLeg: number;
  /** Cost multiplier the police apply. >1 means they avoid it. */
  policyWeight: number;
  legs: LegDef[];
}

export const BRANCHES: BranchDef[] = [];


/**
 * Firm ruts through the off-road section.
 *
 * The mud leg used to be a pure speed tax — nothing to do but wallow. These two dried
 * tracks run its whole length on dirt (0.93 top speed) instead of mud (0.68), so there is
 * a fast line through it for anyone willing to hold a precise course. They are narrow,
 * offset from the obvious centre line, and they feed straight into the big kicker, which
 * turns the slowest part of the course into the run-up you have to nail.
 *
 * Police cars are wider and steer to junction centres, so they mostly stay in the mud.
 */
export const OVERLAY_STRIPS: StripDef[] = [];

// ---------------------------------------------------------------------------
// Segment generation
// ---------------------------------------------------------------------------

function makeSegment(
  index: number,
  from: PathNode,
  to: LegDef,
  branch: boolean,
  overlay = false,
  capEnd = false,
): CourseSegment {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    index,
    section: to.section,
    surface: to.surface,
    wall: to.wall,
    ramp: to.ramp ?? 0,
    ax: from.x,
    az: from.z,
    ay: from.y,
    bx: to.x,
    bz: to.z,
    by: to.y,
    halfWidth: to.halfWidth,
    shoulder: to.shoulder ?? 0,
    dx: dx / length,
    dz: dz / length,
    length,
    heading: Math.atan2(dx, dz),
    grade: (to.y - from.y) / length,
    branch,
    capEnd,
    extA: 0,
    extB: 0,
    overlay,
    priority: overlay ? 1 : 0,
  };
}

export interface BuiltCourse {
  segments: CourseSegment[];
  /** Main-spine path nodes in order, including the start. */
  spine: PathNode[];
  /** Segment indices belonging to each branch, keyed by branch name. */
  branchSegments: Map<string, CourseSegment[]>;
}

/**
 * The smooth spine: the generator's coarse polyline resampled along a Catmull-Rom
 * spline into ~6-unit micro-legs.
 *
 * This is the whole "curved world" in one function. The generator still thinks in
 * five-leg sections, straight lines and sharp joints - all its daily-variety logic is
 * untouched - but what the rest of the game sees is the smooth curve threaded through
 * those control points. Every consumer downstream (terrain, walls, nav, police, the
 * boundary sealer) already works per-segment, so curving the world is a matter of
 * making the segments fine enough that a chain of them IS the curve. Facets run ~6
 * units, matching the game's low-poly look.
 *
 * Guarantees preserved by construction:
 *  - the spline passes exactly through every control point, so everything anchored to
 *    node coordinates (spur mouths, the start, ramp lips) stays on the road;
 *  - widths blend smoothly between legs and across section boundaries, and are floored
 *    by each leg's own generated width, so no slice is ever narrower than the tuned
 *    minimums;
 *  - a leg's ramp lands exactly on the sample at its end control, so `crossedRamp`
 *    keeps firing at the lip.
 */
const SLICE_LENGTH = 6;

function smoothSpine(start: PathNode, legs: LegDef[]): { micro: LegDef[]; controlProgress: number[] } {
  const pts: PathNode[] = [start, ...legs.map((l) => ({ x: l.x, z: l.z, y: l.y }))];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const cr = (a: number, b: number, c: number, d: number, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      0.5 *
      (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * (b - c) - a + d) * t3)
    );
  };

  const micro: LegDef[] = [];
  const controlProgress: number[] = [0];
  let arc = 0;
  let prevX = start.x;
  let prevZ = start.z;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const a = P(i - 1);
    const b = P(i);
    const c = P(i + 1);
    const d = P(i + 2);
    const chord = Math.hypot(c.x - b.x, c.z - b.z);
    const n = Math.max(2, Math.round(chord / SLICE_LENGTH));

    // Width rides a tent across the span: the leg's own width mid-span, averaged with
    // its neighbours at the joints, so section transitions ease over a leg rather than
    // snapping at a line. The max() floors every sample at the tuned leg widths.
    const prevLeg = legs[i - 1] ?? leg;
    const nextLeg = legs[i + 1] ?? leg;
    const wJoinA = (prevLeg.halfWidth + leg.halfWidth) / 2;
    const wJoinB = (leg.halfWidth + nextLeg.halfWidth) / 2;
    const sJoinA = ((prevLeg.shoulder ?? 0) + (leg.shoulder ?? 0)) / 2;
    const sJoinB = ((leg.shoulder ?? 0) + (nextLeg.shoulder ?? 0)) / 2;

    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = k === n ? c.x : cr(a.x, b.x, c.x, d.x, t);
      const z = k === n ? c.z : cr(a.z, b.z, c.z, d.z, t);
      const y = k === n ? c.y : cr(a.y, b.y, c.y, d.y, t);
      const w =
        t < 0.5
          ? wJoinA + (leg.halfWidth - wJoinA) * (t * 2)
          : leg.halfWidth + (wJoinB - leg.halfWidth) * ((t - 0.5) * 2);
      const sh =
        t < 0.5
          ? sJoinA + ((leg.shoulder ?? 0) - sJoinA) * (t * 2)
          : (leg.shoulder ?? 0) + (sJoinB - (leg.shoulder ?? 0)) * ((t - 0.5) * 2);
      arc += Math.hypot(x - prevX, z - prevZ);
      prevX = x;
      prevZ = z;
      micro.push({
        x,
        z,
        y,
        section: leg.section,
        surface: leg.surface,
        wall: leg.wall,
        halfWidth: w,
        shoulder: sh,
        // The lip fires on crossing the END of the slice that lands on the control.
        ramp: k === n ? (leg.ramp ?? 0) : 0,
      });
    }
    controlProgress.push(arc);
  }
  return { micro, controlProgress };
}

const SMOOTHED = smoothSpine(COURSE_START, MAIN_LEGS);
/** The micro-legs everything downstream is actually built from. */
export const SMOOTH_LEGS: LegDef[] = SMOOTHED.micro;

/*
 * Re-anchor everything that was measured against the coarse polyline onto the smooth
 * arc, which is a few percent longer. Section starts come from control indices (five
 * legs per section), and spur mouths sit exactly on control points, so both re-anchor
 * exactly rather than approximately.
 */
{
  // Sections are five legs, six when a ramp adds its landing - so the mapping comes
  // from the generator's own record of each section's first leg, never from division.
  for (let sIdx = 0; sIdx < SECTION_COUNT; sIdx++) {
    SECTION_STARTS[sIdx] = SMOOTHED.controlProgress[GENERATED.sectionFirstLeg[sIdx]];
  }
  const controlByKey = new Map<string, number>();
  for (let i = 0; i < MAIN_LEGS.length; i++) {
    const l = MAIN_LEGS[i];
    controlByKey.set(l.x.toFixed(2) + ":" + l.z.toFixed(2), SMOOTHED.controlProgress[i + 1]);
  }
  for (const spur of SPURS) {
    const hit = controlByKey.get(spur.ax.toFixed(2) + ":" + spur.az.toFixed(2));
    if (hit !== undefined) spur.progress = hit;
  }
}

export function buildCourseSegments(): BuiltCourse {
  const segments: CourseSegment[] = [];
  const spine: PathNode[] = [COURSE_START];

  let prev: PathNode = COURSE_START;
  for (const leg of SMOOTH_LEGS) {
    segments.push(makeSegment(segments.length, prev, leg, false));
    prev = leg;
    spine.push({ x: leg.x, z: leg.z, y: leg.y });
  }

  // Ambush spurs. Marked as branches so they never contribute spine progress: driving
  // down one must never look like making ground.
  for (const spur of SPURS) {
    segments.push(
      makeSegment(
        segments.length,
        { x: spur.ax, z: spur.az, y: spur.ay },
        {
          x: spur.bx,
          z: spur.bz,
          y: spur.by,
          section: spur.section,
          surface: spur.surface,
          halfWidth: spur.halfWidth,
          wall: spur.wall,
        },
        true,
        false,
        true,
      ),
    );
  }

  const branchSegments = new Map<string, CourseSegment[]>();
  for (const branch of BRANCHES) {
    const list: CourseSegment[] = [];
    // Branches leave from the END of `fromLeg`, which is spine[fromLeg + 1].
    let node: PathNode = spine[branch.fromLeg + 1];
    for (const leg of branch.legs) {
      const seg = makeSegment(segments.length, node, leg, true);
      segments.push(seg);
      list.push(seg);
      node = { x: leg.x, z: leg.z, y: leg.y };
    }
    branchSegments.set(branch.name, list);
  }

  // Overlay strips go last so branch indexing stays contiguous.
  for (const strip of OVERLAY_STRIPS) {
    segments.push(
      makeSegment(
        segments.length,
        { x: strip.ax, z: strip.az, y: strip.y },
        {
          x: strip.bx,
          z: strip.bz,
          y: strip.y,
          section: strip.section,
          surface: strip.surface,
          halfWidth: strip.halfWidth,
          wall: "none",
        },
        false,
        true,
      ),
    );
  }

  /*
   * End aprons. Everything gets one unless continuation would break the thing the end
   * is for: the course head stays sealed at the start wall, a capEnd keeps its dead-end
   * wall on the boundary, and a ramp keeps the drop its jump is made of.
   */
  let firstSpine = true;
  for (const seg of segments) {
    if (seg.overlay) continue;
    // Micro-joints bend a few degrees at most, so a two-unit apron seals their wedges;
    // a spur still meets the spine at a real angle and keeps the deep one at its mouth.
    seg.extA = seg.branch ? 9 : 2;
    seg.extB = 2;
    if (!seg.branch && firstSpine) {
      seg.extA = 0;
      firstSpine = false;
    }
    if (seg.capEnd) seg.extB = 0;
    if (seg.ramp > 0) seg.extB = 0;
  }

  return { segments, spine, branchSegments };
}

/** Total driven length of the main spine — used for progress and pacing. */
export function mainRouteLength(segments: CourseSegment[]): number {
  return segments.filter((s) => !s.branch && !s.overlay).reduce((sum, s) => sum + s.length, 0);
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/**
 * There is no gate any more. Police plan against a point far ahead of the player on the
 * spine instead, which is what keeps interceptors and blockers setting up in front of you
 * rather than trailing behind.
 */
export const POLICE_LOOKAHEAD = 420;

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

export type PickupKind = "rocket";

export interface PickupDef {
  kind: PickupKind;
  x: number;
  z: number;
}

/**
 * Rocket ammunition.
 *
 * Two out of every three sit out in the run-off, well off the racing line — you have to
 * leave the tarmac, lose grip and lose time to take one, with the squad on you. The rest
 * sit mid-road and are simply free. That mix is the point: most rockets should cost you
 * something, but a player who never gambles should still see one occasionally.
 */
export const PICKUPS: PickupDef[] = MAIN_LEGS.flatMap((leg, i) => {
  // Regularly spaced, so ammo keeps turning up across a run that has no end.
  if (i < 4 || i % 7 !== 0) return [];
  const n = Math.floor(i / 7);
  const side = n % 2 === 0 ? 1 : -1;
  // Safe every third one; the rest are out in the run-off, or hard against the kerb in
  // sections that have no run-off to gamble with.
  const risky = n % 3 !== 0;
  const shoulder = leg.shoulder ?? 0;
  const lateral = risky
    ? shoulder > 6
      ? leg.halfWidth + shoulder * 0.7
      : leg.halfWidth - 1.6
    : 0;

  // Offset across the leg, not across world X: on a diagonal leg the two are nowhere near
  // the same thing, and the difference is the width of the road.
  const prev = i === 0 ? COURSE_START : MAIN_LEGS[i - 1];
  const dx = leg.x - prev.x;
  const dz = leg.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  return [
    {
      kind: "rocket" as const,
      x: leg.x + (dz / len) * lateral * side,
      z: leg.z - (dx / len) * lateral * side,
    },
  ];
});
