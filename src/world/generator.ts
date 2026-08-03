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
  /**
   * Narrowest this theme's road, or a spur off it, may be tightened to.
   *
   * Per-theme rather than global. The hard-walled corridors — the canyon and the
   * downtown blocks — are the ones that played too mean to thread, and only those were
   * meant to open up; the barrier and rail themes have run-off to spill into and were
   * fine as they were.
   */
  minHalfWidth: number;
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
 * Floor for the hard-walled corridors: the canyon and the downtown blocks.
 *
 * These two are the only themes with no shoulder *and* a solid wall — rock one side,
 * building the other — so tightening them produced passages with nothing to spill into,
 * where a strip laid across left barely a car's width to either side. Ten percent up
 * from the 6.5 everything else still uses.
 */
const CORRIDOR_MIN_HALF_WIDTH = 7.15;
/** Floor for every other theme: what the whole course used before. */
const OPEN_MIN_HALF_WIDTH = 6.5;

const THEMES: Theme[] = [
  { id: "hills", surface: "asphalt", wall: "rail", halfWidth: 10, shoulder: 7, hills: 1.0, ramps: 0.25, minHalfWidth: OPEN_MIN_HALF_WIDTH },
  { id: "construction", surface: "dirt", wall: "barrier", halfWidth: 8.5, shoulder: 3, hills: 0.25, ramps: 0.8, minHalfWidth: OPEN_MIN_HALF_WIDTH },
  { id: "downtown", surface: "asphalt", wall: "building", halfWidth: 9, shoulder: 0, hills: 0.0, ramps: 0.0, minHalfWidth: CORRIDOR_MIN_HALF_WIDTH },
  { id: "offroad", surface: "dirt", wall: "open", halfWidth: 11, shoulder: 11, hills: 0.35, ramps: 0.7, minHalfWidth: OPEN_MIN_HALF_WIDTH },
  { id: "canyon", surface: "gravel", wall: "rock", halfWidth: 7.5, shoulder: 0, hills: 0.6, ramps: 0.2, minHalfWidth: CORRIDOR_MIN_HALF_WIDTH },
  { id: "industrial", surface: "asphalt", wall: "fence", halfWidth: 9, shoulder: 0, hills: 0.15, ramps: 0.3, minHalfWidth: OPEN_MIN_HALF_WIDTH },
  { id: "final", surface: "gravel", wall: "barrier", halfWidth: 8, shoulder: 4, hills: 0.5, ramps: 0.35, minHalfWidth: OPEN_MIN_HALF_WIDTH },
];

export interface GeneratedCourse {
  legs: LegDef[];
  /** Distance along the spine at which each section begins. */
  sectionStarts: number[];
  /** Theme id per section, used for surfacing and props. */
  sectionNames: SectionId[];
  /** Dead-end side roads the police ambush from. */
  spurs: SpurDef[];
  /** One 0..1 roll per wall style, picking the day's palette variant. */
  wallRolls: Record<string, number>;
  /** Index into `legs` of each section's first leg - sections vary in leg count. */
  sectionFirstLeg: number[];
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
/**
 * The day's section order.
 *
 * The fixed cycle made every day legible after one run: section 3 was always the
 * downtown, 5 always the canyon, and a regular could pace a whole run from memory. The
 * order is now drawn per day from a shuffled bag - the bag keeps the theme mix even, so
 * a day is never five canyons - under three rules that protect drivability rather than
 * rhythm: the run never opens in a corridor, the two corridor themes never lead into
 * each other, and no theme repeats back to back.
 */
function dailyThemeOrder(rnd: () => number, sections: number): Theme[] {
  const corridor = new Set<SectionId>(["downtown", "canyon"]);
  const order: Theme[] = [];
  let bag: Theme[] = [];
  while (order.length < sections) {
    if (bag.length === 0) {
      bag = [...THEMES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    const prev = order[order.length - 1];
    let idx = bag.findIndex((t) => {
      if (order.length === 0) return !corridor.has(t.id);
      if (prev.id === t.id) return false;
      if (corridor.has(prev.id) && corridor.has(t.id)) return false;
      return true;
    });
    // A bag can dead-end (only a forbidden theme left); taking it anyway would break
    // the rules, so borrow the first legal theme from a fresh cycle instead.
    if (idx < 0) {
      bag = [...THEMES].filter(
        (t) => t.id !== prev.id && !(corridor.has(prev.id) && corridor.has(t.id)),
      );
      idx = Math.floor(rnd() * bag.length);
    }
    order.push(bag.splice(idx, 1)[0]);
  }
  return order;
}

export function generateCourse(sections: number, seed = 20260728): GeneratedCourse {
  const rnd = makeRandom(seed);
  const legs: LegDef[] = [];
  const sectionStarts: number[] = [];
  const sectionNames: SectionId[] = [];
  const spurs: SpurDef[] = [];

  const order = dailyThemeOrder(rnd, sections);
  /*
   * Daily size character, per theme. A day can run its canyons a touch wider and its
   * flats a touch meaner, which changes what the hard sections *are* - but the floors
   * below are hard floors, so no day is ever tighter than the tuned minimums.
   */
  const widthVar = new Map<SectionId, number>();
  const shoulderVar = new Map<SectionId, number>();
  for (const t of THEMES) {
    widthVar.set(t.id, 0.94 + rnd() * 0.18);
    shoulderVar.set(t.id, 0.85 + rnd() * 0.3);
  }
  const wallRolls: Record<string, number> = {};
  for (const w of ["building", "barrier", "rail", "rock", "fence", "open"]) wallRolls[w] = rnd();

  let x = 0;
  let z = -140;
  let y = 0;
  let heading = 0; // radians, 0 = +Z
  let progress = 0;
  // Gradient carries across legs so climbs and descents ease rather than snap.
  let grade = 0;

  const sectionFirstLeg: number[] = [];
  for (let s = 0; s < sections; s++) {
    const theme = order[s];
    sectionStarts.push(progress);
    sectionFirstLeg.push(legs.length);
    sectionNames.push(theme.id);

    // Difficulty tightening: later sections are narrower and have less run-off. Gentler
    // than it was, because the themes now start tight enough that compounding a third off
    // the top of them produced roads a car could not turn around in.
    const tighten = Math.min(0.22, s * 0.014);
    const halfWidth = Math.max(
      theme.minHalfWidth,
      theme.halfWidth * (widthVar.get(theme.id) ?? 1) * (1 - tighten),
    );
    const shoulder = theme.shoulder * (shoulderVar.get(theme.id) ?? 1) * (1 - tighten);

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
      let length = 70 + rnd() * 70;

      // The very first leg runs dead straight. The player is placed facing +Z, and a
      // course that turns immediately means starting the run pointed off the road for no
      // reason the player can see.
      const opening = s === 0 && i === 0;

      /*
       * The leg's character.
       *
       * A course that always wanders at the same gentle rate reads as one long ease -
       * pleasant and forgettable. Each leg now rolls a move: mostly the old cruising
       * wander, but sometimes a hard corner pushed in as three tight control points the
       * spline has no room to soften, sometimes a dead-flat straight, sometimes a pitch
       * steep enough to feel like a drop rather than a slope. All from the same daily
       * PRNG, so which day has the vicious corner is part of what the day is.
       */
      const move = opening || i === rampLeg ? "cruise" : rnd();
      /*
       * No hard corners where there is nothing to run wide into: a
       * near-right-angle between two solid walls is not a corner, it is a wall
       * with extra steps. What decides that is the RUN-OFF, not the width - the
       * test used to key off the minimum half-width, which caught the canyon and
       * the downtown blocks but not the industrial fences, a theme with a solid
       * wall each side and no shoulder at all. That is where the day's vicious
       * corner became an eighty-eight-degree hairpin in a seventeen-unit road,
       * arriving as a wall across the windscreen with no way to carry speed
       * through it.
       */
      const corridor = theme.shoulder < 1;
      /*
       * Never on a section's first or last leg either. A corner rolled on the
       * boundary is entered or left in the NEXT theme, which may be one of the
       * walled-in ones - and a hairpin that spits you into a fenced corridor is
       * the same trap as one built inside it. Kept off the seams, a hard corner
       * is always approached and exited on road with run-off.
       */
      const atSeam = i === 0 || i === LEGS_PER_SECTION - 1;
      const hardCorner =
        typeof move === "number" && move < 0.1 && s > 0 && !corridor && !atSeam;
      const flatStraight = typeof move === "number" && move >= 0.1 && move < 0.24;
      const steep = typeof move === "number" && move >= 0.24 && move < 0.36;

      if (hardCorner) {
        // Approach stub, then the turn itself, then an exit stub. Short stubs pin the
        // spline tight to the apex, so the corner stays a corner instead of an arc.
        const stub = 26 + rnd() * 10;
        x += Math.sin(heading) * stub;
        z += Math.cos(heading) * stub;
        y = Math.max(0, y + grade * stub);
        legs.push({ x, z, y, section: theme.id, surface: theme.surface, halfWidth, wall: theme.wall, shoulder });
        // Turn across the current drift, so the corner also recentres the course.
        const sign = x / LATERAL_LIMIT + heading * 0.4 > 0 ? -1 : 1;
        heading += sign * (0.95 + rnd() * 0.4);
        heading = Math.max(-1.35, Math.min(1.35, heading));
        const stub2 = 26 + rnd() * 10;
        x += Math.sin(heading) * stub2;
        z += Math.cos(heading) * stub2;
        legs.push({ x, z, y, section: theme.id, surface: theme.surface, halfWidth, wall: theme.wall, shoulder });
        grade *= 0.4;
        length = 55 + rnd() * 45;
      } else if (!opening) {
        if (flatStraight) {
          // Dead flat and dead straight, and longer than a normal leg - a breather that
          // reads as one on purpose.
          grade = 0;
          length = 110 + rnd() * 60;
        } else {
          // Turn, biased back toward +Z whenever the course drifts sideways.
          const drift = x / LATERAL_LIMIT;
          let turn = (rnd() - 0.5) * 1.5 - drift * 0.9;
          // In a corridor there is no shoulder to save a hot entry: the same wander
          // that reads as a sweeper on the flats reads as a trap between rock faces.
          if (corridor) turn = Math.max(-0.55, Math.min(0.55, turn));
          heading += turn;
          // Keep every leg pointed broadly forward so the course always advances.
          heading = Math.max(-1.15, Math.min(1.15, heading));
        }
      }

      // Elevation: ease the gradient toward a new target rather than jumping to it.
      if (opening || flatStraight) {
        grade = opening ? 0 : grade;
      } else if (steep) {
        // No easing: the slope arrives all at once, up to three times the cruising
        // pitch, and the spline rounds only the crest and the foot.
        const sign = y < 6 ? 1 : rnd() < 0.5 ? 1 : -1;
        grade = sign * (0.14 + rnd() * 0.1);
        length = 60 + rnd() * 40;
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

  return { legs, sectionStarts, sectionNames, spurs, wallRolls, sectionFirstLeg };
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
    halfWidth: Math.max(theme.minHalfWidth, halfWidth * 0.62),
    surface: theme.surface,
    // "open" has no wall to speak of, and a spur with no walls hides nothing.
    wall: theme.wall === "open" ? "fence" : theme.wall,
    section: theme.id,
    progress,
  };
}
