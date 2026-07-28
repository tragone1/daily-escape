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

export class Terrain {
  /** Cumulative distance to the START of each main-spine segment. */
  private readonly spineStart: number[] = [];
  readonly mainLength: number;

  constructor(readonly segments: CourseSegment[]) {
    let acc = 0;
    for (const s of segments) {
      if (s.branch || s.overlay) {
        this.spineStart.push(-1);
        continue;
      }
      this.spineStart.push(acc);
      acc += s.length;
    }
    this.mainLength = acc;
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

    let nearest: CourseSegment = this.segments[0];
    let nearestDist = Infinity;
    let nearestAlong = 0;

    for (const seg of this.segments) {
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
      const insideAlong = Math.min(along, seg.length - along);
      // A point past the segment's ends is outside regardless of the road bonus.
      const margin = insideAlong < 0 ? insideAlong : Math.min(insideAcross, insideAlong + ROAD_PRIORITY);
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
      surface: onShoulder ? "grass" : seg.surface,
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
