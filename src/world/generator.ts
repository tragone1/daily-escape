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
  /**
   * Drivable run-off each side, inside the containment wall.
   *
   * Every theme has one now. The wall used to sit at the edge of the tarmac for most
   * themes and at the edge of the run-off for the open one, which meant "shoulder" was
   * sometimes ground you could not actually reach. It is now uniformly the lane between
   * the kerb and the wall — somewhere to run wide, get shoved, or be pinned against.
   */
  shoulder: number;
  /** Chance per leg of a gradient change. */
  hills: number;
  /** Chance per section of a launch ramp. */
  ramps: number;
}

/**
 * Section themes, cycled in order.
 *
 * The rhythm matters as much as the contents, and the order is the rhythm. Total width
 * across the cycle runs 34, 23, 18, 64, 15, 18, 24 — roomy to start, a first real squeeze
 * at the third, the flats as relief at the fourth, then the canyon, which is the tightest
 * road in the game and where good runs tend to end. Sections that are all the same width
 * are all the same section, however differently they are painted.
 *
 * Width is the difficulty dial and it is used as one. The canyon and downtown are barely
 * wider than three cars and are where runs end; the flats are genuinely open and are the
 * one place you get to breathe. Everything used to sit somewhere between 42 and 90 units
 * across, which made the whole course a motorway — nothing could trap you on it, so the
 * heavy units and the roadblocks had nothing to work with.
 */
/**
 * Narrowest half-width anything on the course may be, main road or spur.
 *
 * Almost every spur lands on this floor (0.62 of a road that is itself already tightened)
 * and so do the canyon and final themes in the late sections, which makes this single
 * number the width of most of the tight corridors in the game. It was 6.5 and they played
 * a shade too mean - a strip laid across one left barely a car's width either side of it.
 */
const MIN_HALF_WIDTH = 7.15;

const THEMES: Theme[] = [
  { id: "hills", surface: "asphalt", wall: "rail", halfWidth: 10, shoulder: 7, hills: 1.0, ramps: 0.25 },
  { id: "construction", surface: "dirt", wall: "barrier", halfWidth: 8.5, shoulder: 3, hills: 0.25, ramps: 0.8 },
  { id: "downtown", surface: "asphalt", wall: "building", halfWidth: 9, shoulder: 0, hills: 0.0, ramps: 0.0 },
  { id: "offroad", surface: "dirt", wall: "open", halfWidth: 11, shoulder: 11, hills: 0.35, ramps: 0.7 },
  { id: "canyon", surface: "gravel", wall: "rock", halfWidth: 7.5, shoulder: 0, hills: 0.6, ramps: 0.2 },
  { id: "industrial", surface: "asphalt", wall: "fence", halfWidth: 9, shoulder: 0, hills: 0.15, ramps: 0.3 },
  { id: "final", surface: "gravel", wall: "barrier", halfWidth: 8, shoulder: 4, hills: 0.5, ramps: 0.35 },
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

    // Difficulty tightening: later sections are narrower and have less run-off. Gentler
    // than it was, because the themes now start tight enough that compounding a third off
    // the top of them produced roads a car could not turn around in.
    const tighten = Math.min(0.22, s * 0.014);
    const halfWidth = Math.max(MIN_HALF_WIDTH, theme.halfWidth * (1 - tighten));
    const shoulder = theme.shoulder * (1 - tighten);

    // One ramp per section at most, placed on a middle leg.
    const rampLeg = rnd() < theme.ramps ? 1 + Math.floor(rnd() * (LEGS_PER_SECTION - 2)) : -1;

    /*
     * Which legs in this section get an ambush spur hanging off their far end.
     *
     * Section 0 gets them too, but only on its later legs. The opening needs somewhere
     * for the first side-on threat to come from — the alternative is a corridor with
     * nothing in it but cars driving at you head-on — while the first hundred metres
     * still have to be clean enough to get moving in.
     */
    const firstLeg = s === 0 ? 2 : 0;
    const spurLegs = new Set<number>();
    const wanted = Math.min(SPURS_PER_SECTION, LEGS_PER_SECTION - firstLeg);
    while (spurLegs.size < wanted) {
      spurLegs.add(firstLeg + Math.floor(rnd() * (LEGS_PER_SECTION - firstLeg)));
    }

    for (let i = 0; i < LEGS_PER_SECTION; i++) {
      const length = 70 + rnd() * 70;


      // The very first leg runs dead straight. The player is placed facing +Z, and a
      // course that turns immediately means starting the run pointed off the road for no
      // reason the player can see.
      const opening = s === 0 && i === 0;
      if (!opening) {
        // Turn, biased back toward +Z whenever the course drifts sideways.
        const drift = x / LATERAL_LIMIT;
        const turn = (rnd() - 0.5) * 1.5 - drift * 0.9;
        heading += turn;
        // Keep every leg pointed broadly forward so the course always advances.
        heading = Math.max(-1.15, Math.min(1.15, heading));
      }

      // Elevation: ease the gradient toward a new target rather than jumping to it.
      if (opening) {
        grade = 0;
      } else if (rnd() < theme.hills) {
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
        shoulder,
        // A ramp needs a rising lip; force a modest climb into it.
        ...(isRamp ? { ramp: 0.56 + rnd() * 0.22 } : {}),
      });

      if (isRamp) {
        // Landing apron straight after the lip, so a jump always has somewhere to land.
        // Long, because a boosted launch covers a lot of ground before it comes down.
        const landLen = 130;
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
          shoulder: shoulder + 4,
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
    halfWidth: Math.max(MIN_HALF_WIDTH, halfWidth * 0.62),
    surface: theme.surface,
    // "open" has no wall to speak of, and a spur with no walls hides nothing.
    wall: theme.wall === "open" ? "fence" : theme.wall,
    section: theme.id,
    progress,
  };
}
