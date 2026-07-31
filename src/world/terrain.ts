/**
 * Terrain queries over the course segments.
 *
 * The whole elevation system is deliberately shallow: no heightmap, no mesh raycasts.
 * A point is located inside an oriented segment rectangle, and the ground height is a
 * linear interpolation along that segment. That keeps hills, slopes and surfaces exactly
 * as predictable as the segment list says they are — the player can always see why the
 * car is slowing down or picking up speed.
 */

import type { CourseSegment, Surface } from "./course";

export interface TerrainSample {
  /** Ground height at the queried point. */
  height: number;
  surface: Surface;
  /** Height gradient, i.e. rise per unit travelled along X and Z. */
  gradX: number;
  gradZ: number;
  /** False when the point is off the drivable ribbon entirely. */
  onCourse: boolean;
  segment: CourseSegment;
}

/** Margin bonus that makes sealed road outrank any shoulder in sampling. */
const ROAD_PRIORITY = 1000;

/**
 * How far each segment is treated as extending past its own ends.
 *
 * Consecutive legs share exactly one point, so a car sitting on a joint is, to floating
 * point, a fraction past the end of one and a fraction before the start of the next —
 * outside both, and therefore "off the course". Harmless when off-course meant nothing;
 * a real defect once it meant a speed penalty, a frozen score and a warning on the HUD,
 * because the course has some two hundred joints and you cross every one of them.
 */
const JOINT_TOLERANCE = 1.5;

/**
 * Penalty applied to a segment that only contains the point via `JOINT_TOLERANCE`.
 *
 * The tolerance is a safety net, not a claim. Without this, both legs at a joint report
 * the point as inside with near-identical margins, and the winner flips frame to frame —
 * which the player sees as the ground shimmering between dirt and tarmac wherever two
 * sections meet, and feels as the surface multipliers switching underneath them. Making
 * the overlap strictly worse than genuine containment settles it.
 */
const TOLERANCE_PENALTY = 500;

export class Terrain {
  /** Cumulative distance to the START of each main-spine segment. */
  private readonly spineStart: number[] = [];
  readonly mainLength: number;

  /*
   * Uniform grid over segment bounding boxes. The curved world is thousands of short
   * slices instead of a few hundred long legs, and sample() runs for every car every
   * frame - a linear scan stopped being viable the day the segments got fine. Cells
   * hold indices of every segment whose padded bounds touch them.
   */
  private readonly gridCell = 48;
  private readonly grid = new Map<number, number[]>();
  private gridKey(cx: number, cz: number): number {
    return cx * 100003 + cz;
  }

  constructor(readonly segments: CourseSegment[]) {
    let acc = 0;
    for (const s of segments) {
      if (s.branch || s.overlay) {
        this.spineStart.push(-1);
      } else {
        this.spineStart.push(acc);
        acc += s.length;
      }
    }
    this.mainLength = acc;
    for (let i = 0; i < segments.length; i += 8) this.coarse.push(segments[i]);

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const pad = s.halfWidth + s.shoulder + Math.max(s.extA, s.extB) + 4;
      const minX = Math.min(s.ax, s.bx) - pad;
      const maxX = Math.max(s.ax, s.bx) + pad;
      const minZ = Math.min(s.az, s.bz) - pad;
      const maxZ = Math.max(s.az, s.bz) + pad;
      for (let cx = Math.floor(minX / this.gridCell); cx <= Math.floor(maxX / this.gridCell); cx++)
        for (let cz = Math.floor(minZ / this.gridCell); cz <= Math.floor(maxZ / this.gridCell); cz++) {
          const k = this.gridKey(cx, cz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(i);
        }
    }
  }

  /** A thin sample of the spine for nearest-fallback when a point is far off-world. */
  private coarse: CourseSegment[] = [];

  /** Indices of segments whose padded bounds cover the point - for build-time queries. */
  segmentsNear(x: number, z: number): number[] | null {
    return this.candidates(x, z);
  }

  /** Segments whose padded bounds cover this point, gathered from the 3x3 cell block. */
  private candidates(x: number, z: number): number[] | null {
    const cx = Math.floor(x / this.gridCell);
    const cz = Math.floor(z / this.gridCell);
    const centre = this.grid.get(this.gridKey(cx, cz));
    if (centre) return centre;
    // Off the padded bounds of everything in this cell: check the ring before giving up.
    let ring: number[] | null = null;
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++) {
        if (gx === 0 && gz === 0) continue;
        const list = this.grid.get(this.gridKey(cx + gx, cz + gz));
        if (list) ring = ring ? ring.concat(list) : list;
      }
    return ring;
  }

  /** Local coordinates of a point relative to a segment: distance along and across. */
  private local(seg: CourseSegment, x: number, z: number): { along: number; across: number } {
    const rx = x - seg.ax;
    const rz = z - seg.az;
    return {
      along: rx * seg.dx + rz * seg.dz,
      // Right-hand perpendicular of (dx,dz) is (dz,-dx).
      across: rx * seg.dz - rz * seg.dx,
    };
  }

  /**
   * Ground height, surface and slope at a point.
   *
   * Segments overlap at corners, so the winner is whichever the point sits most deeply
   * inside. Points that are off the ribbon fall back to the nearest segment rather than
   * to a hard-coded zero, which stops the car dropping through the world if it is ever
   * shoved past a wall on a hillside.
   */
  sample(x: number, z: number): TerrainSample {
    let best: CourseSegment | null = null;
    let bestMargin = -Infinity;
    let bestPriority = -1;
    let bestAlong = 0;
    let bestInApron = false;

    let nearest: CourseSegment = this.segments[0];
    let nearestDist = Infinity;
    let nearestAlong = 0;

    /*
     * No candidate cell means the point is beyond the padded bounds of every segment -
     * definitively off-course - and the only thing still owed is a plausible nearest
     * segment for the height fallback, which a thin sample of the spine answers. The
     * full scan this used to do ran during boundary sealing for every off-world probe,
     * hundreds of thousands of times, and turned world build from seconds into minutes.
     */
    const cand = this.candidates(x, z);
    const list: ArrayLike<number> | CourseSegment[] = cand ?? this.coarse;
    for (let ci = 0; ci < list.length; ci++) {
      const seg = cand ? this.segments[(list as number[])[ci]] : (list as CourseSegment[])[ci];
      const { along, across } = this.local(seg, x, z);
      const clamped = Math.max(0, Math.min(seg.length, along));

      /*
       * How far inside the rectangle the point is; negative means outside.
       *
       * Shoulders count as inside — they are grass, but they are drivable. Sealed road
       * gets a large bonus so that any road always beats any shoulder: without it a wide
       * open section's 42-unit run-off swallows the narrow branch roads crossing it, and
       * the bog shortcut silently stopped being mud.
       */
      const acrossAbs = Math.abs(across);
      const insideAcross =
        acrossAbs <= seg.halfWidth
          ? seg.halfWidth - acrossAbs + ROAD_PRIORITY
          : seg.halfWidth + seg.shoulder - acrossAbs;
      const rawAlong = Math.min(along, seg.length - along);
      /*
       * End aprons: the segment's drivable footprint continues `extA`/`extB` past its
       * ends, filling the wedge between this leg's run-off and the next one's. Apron
       * containment is ranked *barely* inside - a genuine containment by any segment
       * beats it by orders of magnitude - so the apron never steals a point from the
       * road that actually owns it, which is what kept surfaces from flickering at
       * joints when the tolerance overlap was added for the same reason.
       */
      const inApron =
        rawAlong < 0 &&
        ((along < 0 && along >= -seg.extA) ||
          (along > seg.length && along <= seg.length + seg.extB));
      // Only lean on the tolerance when the point is genuinely off the end, and rank any
      // segment that needs it below one that contains the point outright.
      const insideAlong =
        rawAlong >= 0 ? rawAlong : inApron ? 0.05 : rawAlong + JOINT_TOLERANCE - TOLERANCE_PENALTY;
      // A point past the segment's ends is outside regardless of the road bonus.
      const margin =
        insideAlong < 0
          ? insideAlong
          : inApron
            ? Math.min(insideAcross, 0.05)
            : Math.min(insideAcross, insideAlong + ROAD_PRIORITY);
      // Priority first: a narrow rut laid over a wide mud lane must win, even though the
      // point sits far more deeply inside the lane beneath it.
      const inside = margin >= 0;
      const better =
        inside && bestPriority >= 0
          ? seg.priority > bestPriority ||
            (seg.priority === bestPriority && margin > bestMargin)
          : inside
            ? true
            : bestPriority < 0 && margin > bestMargin;
      if (better) {
        bestMargin = margin;
        bestPriority = inside ? seg.priority : -1;
        best = seg;
        bestAlong = clamped;
        bestInApron = inApron;
      }

      // Distance to the segment's centre line, for the off-course fallback.
      const overshoot = along < 0 ? -along : along > seg.length ? along - seg.length : 0;
      const d = Math.hypot(across, overshoot);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = seg;
        nearestAlong = clamped;
      }
    }

    const onCourse = bestMargin >= 0 && best !== null;
    const seg = onCourse ? (best as CourseSegment) : nearest;
    const along = onCourse ? bestAlong : nearestAlong;

    // Off the sealed width but still on the segment means you are on the shoulder.
    const acrossHere = Math.abs(this.local(seg, x, z).across);
    const onShoulder = seg.shoulder > 0 && acrossHere > seg.halfWidth;

    return {
      height: seg.ay + seg.grade * along,
      // An apron is grass whatever the road surface was: it is the corner's run-off.
      surface: onShoulder || bestInApron ? "grass" : seg.surface,
      gradX: seg.grade * seg.dx,
      gradZ: seg.grade * seg.dz,
      onCourse,
      segment: seg,
    };
  }

  /** Convenience for callers that only need the ground height. */
  heightAt(x: number, z: number): number {
    return this.sample(x, z).height;
  }

  /**
   * Did this movement step cross the lip of a ramp fast enough to launch?
   * Returns the vertical launch speed, or 0. Explicit rather than emergent so a jump
   * always happens for a reason the player can see coming.
   */
  checkLaunch(
    prevX: number,
    prevZ: number,
    x: number,
    z: number,
    forwardSpeed: number,
    minSpeed: number,
  ): number {
    if (forwardSpeed < minSpeed) return 0;

    for (const seg of this.segments) {
      if (seg.ramp <= 0) continue;
      const before = this.local(seg, prevX, prevZ);
      const after = this.local(seg, x, z);
      if (before.along >= seg.length || after.along < seg.length) continue;
      if (Math.abs(after.across) > seg.halfWidth) continue;
      return forwardSpeed * seg.ramp;
    }
    return 0;
  }

  /** Distance travelled along the main spine, used for pacing and the progress readout. */
  progressAt(x: number, z: number): number {
    let bestDist = Infinity;
    let bestProgress = 0;

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.branch || seg.overlay) continue;
      const { along, across } = this.local(seg, x, z);
      const clamped = Math.max(0, Math.min(seg.length, along));
      const overshoot = along < 0 ? -along : along > seg.length ? along - seg.length : 0;
      const d = Math.hypot(across, overshoot);
      if (d < bestDist) {
        bestDist = d;
        bestProgress = this.spineStart[i] + clamped;
      }
    }
    return bestProgress;
  }

  /** Which section a point is in — drives police pacing and the HUD banner. */
  sectionAt(x: number, z: number) {
    return this.sample(x, z).segment.section;
  }
}
