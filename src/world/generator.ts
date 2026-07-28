/**
 * Procedural course generation for endless mode.
 *
 * The course is a chain of themed sections that never reaches a finish line — it just
 * keeps going and keeps getting worse. Everything is driven by a seeded PRNG so every
 * player drives the identical course and scores are comparable.
 *
 * The generator's only hard job is staying drivable: headings stay within a cone of
 * "forward", turns are bounded, and every gradient change is eased in and out over
 * several legs so the road reads as a curve rather than a folded sheet.
 */

import type { LegDef, SectionId, SpurDef, Surface, WallStyle } from "./course";

/** Small deterministic PRNG (mulberry32). Same seed, same course, every time. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Theme {
  id: SectionId;
  surface: Surface;
  wall: WallStyle;
  /** Road half width, before difficulty tightening. */
  halfWidth: number;
  /** Drivable run-off each side; 0 means a walled corridor. */
  shoulder: number;
  /** Chance per leg of a gradient change. */
  hills: number;
  /** Chance per section of a launch ramp. */
  ramps: number;
}

/**
 * Section themes, cycled in order. Repeating a five-beat rhythm gives the run a shape you
 * can learn — you know roughly what is coming — while the difficulty ramp underneath
 * makes each pass through the cycle meaner than the last.
 */
const THEMES: Theme[] = [
  { id: "downtown", surface: "asphalt", wall: "building", halfWidth: 12, shoulder: 0, hills: 0.0, ramps: 0.0 },
  { id: "construction", surface: "dirt", wall: "barrier", halfWidth: 10, shoulder: 12, hills: 0.2, ramps: 0.8 },
  { id: "hills", surface: "asphalt", wall: "rail", halfWidth: 10, shoulder: 20, hills: 1.0, ramps: 0.2 },
  { id: "offroad", surface: "dirt", wall: "open", halfWidth: 11, shoulder: 34, hills: 0.3, ramps: 0.7 },
  { id: "final", surface: "gravel", wall: "fence", halfWidth: 10, shoulder: 14, hills: 0.4, ramps: 0.3 },
];

export interface GeneratedCourse {
  legs: LegDef[];
  /** Distance along the spine at which each section begins. */
  sectionStarts: number[];
  /** Theme id per section, used for surfacing and props. */
  sectionNames: SectionId[];
  /** Dead-end side roads the police ambush from. */
  spurs: SpurDef[];
}

/** Ambush spurs per section, from section 1 on. */
const SPURS_PER_SECTION = 2;

const LEGS_PER_SECTION = 5;
/** Course stays inside this half-width so the world does not sprawl sideways forever. */
const LATERAL_LIMIT = 460;

/**
 * Build `sections` worth of course.
 *
 * Nobody is expected to reach the end — the difficulty curve ends runs long before — but
 * the course is finite so the whole world can be built, batched and indexed once at
 * startup rather than streamed. Raise the count if runs ever get that far.
 */
export function generateCourse(sections: number, seed = 20260728): GeneratedCourse {
  const rnd = makeRandom(seed);
  const legs: LegDef[] = [];
  const sectionStarts: number[] = [];
  const sectionNames: SectionId[] = [];
  const spurs: SpurDef[] = [];

  let x = 0;
  let z = -140;
  let y = 0;
  let heading = 0; // radians, 0 = +Z
  let progress = 0;
  // Gradient carries across legs so climbs and descents ease rather than snap.
  let grade = 0;

  for (let s = 0; s < sections; s++) {
    const theme = THEMES[s % THEMES.length];
    sectionStarts.push(progress);
    sectionNames.push(theme.id);

    // Difficulty tightening: later sections are narrower and have less run-off.
    const tighten = Math.min(0.35, s * 0.02);
    const halfWidth = Math.max(7, theme.halfWidth * (1 - tighten));
    const shoulder = theme.shoulder * (1 - tighten);

    // One ramp per section at most, placed on a middle leg.
    const rampLeg = rnd() < theme.ramps ? 1 + Math.floor(rnd() * (LEGS_PER_SECTION - 2)) : -1;

    // Which legs in this section get an ambush spur hanging off their far end.
    const spurLegs = new Set<number>();
    if (s > 0) {
      while (spurLegs.size < Math.min(SPURS_PER_SECTION, LEGS_PER_SECTION)) {
        spurLegs.add(Math.floor(rnd() * LEGS_PER_SECTION));
      }
    }

    for (let i = 0; i < LEGS_PER_SECTION; i++) {
      const length = 70 + rnd() * 70;

      // Turn, biased back toward +Z whenever the course drifts sideways.
      const drift = x / LATERAL_LIMIT;
      const turn = (rnd() - 0.5) * 1.5 - drift * 0.9;
      heading += turn;
      // Keep every leg pointed broadly forward so the course always advances.
      heading = Math.max(-1.15, Math.min(1.15, heading));

      // Elevation: ease the gradient toward a new target rather than jumping to it.
      if (rnd() < theme.hills) {
        const target = (rnd() - 0.5) * 0.5;
        grade += (target - grade) * 0.55;
      } else {
        grade *= 0.45;
      }
      if (y < 2 && grade < 0) grade = Math.abs(grade) * 0.5;

      x += Math.sin(heading) * length;
      z += Math.cos(heading) * length;
      y = Math.max(0, y + grade * length);

      const isRamp = i === rampLeg;
      legs.push({
        x,
        z,
        y,
        section: theme.id,
        surface: theme.surface,
        halfWidth,
        wall: theme.wall,
        shoulder: shoulder > 1 ? shoulder : undefined,
        // A ramp needs a rising lip; force a modest climb into it.
        ...(isRamp ? { ramp: 0.3 + rnd() * 0.16 } : {}),
      });

      if (isRamp) {
        // Landing apron straight after the lip, so a jump always has somewhere to land.
        const landLen = 90;
        x += Math.sin(heading) * landLen;
        z += Math.cos(heading) * landLen;
        y = Math.max(0, y - 6);
        legs.push({
          x,
          z,
          y,
          section: theme.id,
          surface: theme.surface,
          halfWidth: halfWidth + 2,
          wall: theme.wall,
          shoulder: shoulder > 1 ? shoulder + 4 : undefined,
        });
        progress += landLen;
        grade = 0;
      }

      progress += length;

      if (spurLegs.has(i)) {
        spurs.push(
          makeSpur(rnd, theme, x, z, y, heading, halfWidth, shoulder, progress, spurs.length),
        );
      }
    }
  }

  return { legs, sectionStarts, sectionNames, spurs };
}

/**
 * A dead-end side road hanging off the spine.
 *
 * These exist for one reason: without them every police car has to arrive from directly
 * behind or directly in front, because a walled corridor has no other way in. A spur gives
 * the squad somewhere to be waiting off to the side, so a unit can come out of an alley
 * and put you into a wall as you pass.
 *
 * They are deliberately dead ends. An opening that went somewhere would be a route, and a
 * route the player can take is a route the player can use to skip — which is exactly the
 * cheat the enclosed course was built to remove.
 */
function makeSpur(
  rnd: () => number,
  theme: Theme,
  x: number,
  z: number,
  y: number,
  heading: number,
  halfWidth: number,
  shoulder: number,
  progress: number,
  index: number,
): SpurDef {
  // Roughly perpendicular, alternating sides, jittered so they do not read as a pattern.
  const side = index % 2 === 0 ? 1 : -1;
  const angle = heading + side * (Math.PI / 2 + (rnd() - 0.5) * 0.7);
  // Long enough to clear the run-off and still leave a corridor to hide in.
  const length = shoulder + 42 + rnd() * 26;

  return {
    ax: x,
    az: z,
    ay: y,
    bx: x + Math.sin(angle) * length,
    bz: z + Math.cos(angle) * length,
    // Flat: a sloping dead end is a place for a unit to get wedged, not a hiding place.
    by: y,
    halfWidth: Math.max(6.5, halfWidth * 0.62),
    surface: theme.surface,
    // "open" has no wall to speak of, and a spur with no walls hides nothing.
    wall: theme.wall === "open" ? "fence" : theme.wall,
    section: theme.id,
    progress,
  };
}
