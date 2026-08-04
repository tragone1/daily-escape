/**
 * A course that keeps going.
 *
 * The world used to be generated once, forty sections long, and that was the
 * end of it - a player good enough to reach the end found their score frozen
 * at the last metre of road, the tow system dragging them back onto a course
 * they had run out of, and a run that never ended. Forty sections is about
 * eight and a half minutes flat out, so the game's own promise of no finish
 * line had a finish line in it.
 *
 * This grows the course ahead of the player instead. Two measurements decided
 * the shape of it: generating legs costs 3-18ms even for four hundred sections,
 * while building their geometry costs about 15ms a section - a hundred times
 * more. So the legs are regenerated wholesale whenever the course needs to be
 * longer, and only geometry is built incrementally, a window at a time.
 *
 * That regeneration is safe because the generator is prefix-stable: a course
 * generated to any length is an exact prefix of the same course generated
 * longer. Without that, extending the road ahead would rewrite the road behind.
 */

import type { Renderer } from "../gfx/renderer";
import type { CollisionWorld, StaticCollider } from "../physics/collisionWorld";
import {
  buildCourseSegments,
  makeCourse,
  setActiveCourse,
  type Course,
  type CourseSegment,
} from "./course";
import { buildWorld, emitSections } from "./courseBuilder";
import { NavGraph } from "./navGraph";
import type { Terrain } from "./terrain";

/**
 * Sections built in one go.
 *
 * This is a frame budget, and it has been cut twice. Four measured 168ms; two
 * measured 38ms once the sweep inside it was profiled and coarsened; one puts
 * the build under a single 16.7ms frame, which is the only figure that
 * actually matters - a hitch you cannot see is not a hitch. The work per
 * section is identical either way, so the only cost of going smaller is doing
 * it more often.
 */
const WINDOW = 1;
/**
 * How far ahead of the player the road must already exist.
 *
 * Generous on purpose: the police are dispatched up to three hundred units up
 * the course and path along it, so the road they are sent to has to be there
 * before they are. Two sections is roughly a thousand units, which is beyond
 * anything the director reaches for.
 */
const LOOKAHEAD_SECTIONS = 3;
/**
 * Sections kept behind the player before a stretch of course is released.
 *
 * Generous, because "behind" is not the same as "finished with": the police
 * are dispatched up to a couple of hundred units back and a car shoved off the
 * road can lose ground, and neither should find the world missing. Beyond this
 * nothing can drive back into it - the arrest ends a run long before a player
 * could reverse that far.
 */
const KEEP_BEHIND_SECTIONS = 6;

export interface StreamedWorld {
  segments: CourseSegment[];
  terrain: Terrain;
  colliders: StaticCollider[];
  nav: NavGraph;
  blocksWithdrawn: number;
}

/** A stretch of course that was built together, and can be released together. */
interface Window {
  id: number;
  from: number;
  to: number;
}

export class WorldStream {
  /** Sections whose geometry exists. Everything below this has been built. */
  private builtThrough = 0;
  /** Windows currently standing, oldest first. */
  private windows: Window[] = [];
  private nextWindowId = 0;
  private retiredSections = 0;
  private course: Course;
  private segments: CourseSegment[];
  private colliders: StaticCollider[] = [];
  private withdrawn = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly seed: number,
    private readonly world: StreamedWorld,
    private readonly collision: CollisionWorld,
    initialSections: number,
  ) {
    this.course = makeCourse(seed, initialSections);
    this.segments = buildCourseSegments(this.course).segments;
    setActiveCourse(this.course);
  }

  get sectionCount(): number {
    return this.course.sectionCount;
  }

  get sectionStarts(): number[] {
    return this.course.sectionStarts;
  }

  get currentCourse(): Course {
    return this.course;
  }

  /**
   * Make sure the road exists this far along, building it if not.
   *
   * Called with the section the player has reached. Returns true when it
   * actually built something, which is the caller's cue that the terrain,
   * collision and navigation it holds have been rebuilt underneath it.
   */
  ensureBuiltThrough(sectionIndex: number): boolean {
    const wanted = sectionIndex + LOOKAHEAD_SECTIONS;
    if (wanted < this.builtThrough) return false;

    // Grow the course itself first if the window would run off the end of it.
    if (wanted + WINDOW >= this.course.sectionCount) {
      const longer = Math.max(this.course.sectionCount + 20, wanted + WINDOW + 10);
      this.course = makeCourse(this.seed, longer);
      this.segments = buildCourseSegments(this.course).segments;
      /*
       * Reindex the terrain here, not only in `publish`. The build below is
       * handed this same terrain to consult, and it asks it which ground is
       * road - so a terrain that still describes the shorter course answers for
       * sections that no longer end where it thinks. Measured: a couple of props
       * per course landed differently at the growth seam. Only on a grow step,
       * which is once every twenty sections, so it costs nothing per window.
       */
      this.world.terrain.reset(this.segments);
      // Section boundaries moved; everything that asks which section a distance
      // falls in has to be looking at this generation.
      setActiveCourse(this.course);
    }

    const from = this.builtThrough;
    const to = Math.min(this.course.sectionCount, Math.max(wanted + 1, from + WINDOW));
    if (to <= from) return false;

    /*
     * The window consults every collider already standing and adds to the same
     * list, so its walls and its racing-line check see the sections beside it.
     * Building against an empty list would treat each seam as the edge of the
     * world - which is where blocked roads came from before.
     */
    const id = this.nextWindowId++;
    const before = this.colliders.length;
    const built = buildWorld(
      this.renderer,
      this.course,
      emitSections(from, to),
      this.colliders,
      `w${id}`,
      // Consult the course we already have rather than rebuilding all of it.
      { segments: this.segments, terrain: this.world.terrain },
    );
    // Tag what this window added, so releasing it takes its own and no more.
    for (let i = before; i < this.colliders.length; i++) this.colliders[i].window = id;
    this.windows.push({ id, from, to });
    this.builtThrough = to;
    this.withdrawn += built.blocksWithdrawn;

    this.retireBehind(sectionIndex);
    this.publish();
    return true;
  }

  /**
   * Start the world again from the beginning.
   *
   * A run retires the course behind the player, so by the end of a good one
   * the opening sections have been released - their geometry disposed and
   * their colliders dropped. Restarting puts the player back at the start,
   * where there was then nothing to see: the road was gone and only the cars
   * and the HUD still drew, because those are not part of the streamed
   * geometry. `ensureBuiltThrough` could not repair it either, since it had
   * already built past that point and returns early.
   *
   * The course itself is kept. It is the same seed and the generator is
   * prefix-stable, so the segments and the navigation graph are still exactly
   * right - it is only the geometry and the colliders that have to come back.
   */
  restart(): void {
    for (const w of this.windows) this.renderer.disposeChunkGroup(`w${w.id}`);
    this.windows = [];
    this.colliders.length = 0;
    this.builtThrough = 0;
    this.withdrawn = 0;
    this.retiredSections = 0;
    this.ensureBuiltThrough(0);
  }

  /**
   * Let go of course far enough behind that nothing can return to it.
   *
   * Without this a long run grows for as long as it lasts - which, now that
   * there is no end to reach, means without bound. What is DRAWN stays flat
   * either way because the chunks cull, so this is about memory: the colliders,
   * their index, and the geometry sitting in GPU buffers behind the player.
   */
  private retireBehind(sectionIndex: number): void {
    const cutoff = sectionIndex - KEEP_BEHIND_SECTIONS;
    if (cutoff <= 0) return;
    const dead = this.windows.filter((w) => w.to <= cutoff);
    if (dead.length === 0) return;

    const ids = new Set(dead.map((w) => w.id));
    for (const w of dead) this.renderer.disposeChunkGroup(`w${w.id}`);
    // One filter rather than repeated splices: the array is thousands long and
    // the whole point of this is to stop paying for what is behind you.
    const kept = this.colliders.filter((c) => c.window === undefined || !ids.has(c.window));
    this.colliders.length = 0;
    this.colliders.push(...kept);
    this.windows = this.windows.filter((w) => !ids.has(w.id));
    this.retiredSections += dead.reduce((n, w) => n + (w.to - w.from), 0);
  }

  /** Sections released behind the player. Diagnostic. */
  get retired(): number {
    return this.retiredSections;
  }

  /** Hand the freshly built world to the objects that hold it, in place. */
  private publish(): void {
    this.world.segments = this.segments;
    this.world.colliders = this.colliders;
    this.world.blocksWithdrawn = this.withdrawn;
    // Identity is preserved: the game, the police context and every unit hold
    // these, and a new object would leave all of them pointing at the old world.
    this.world.terrain.reset(this.segments);
    this.world.nav = NavGraph.fromCourse(this.segments);
    this.collision.reset(this.colliders);
  }
}
