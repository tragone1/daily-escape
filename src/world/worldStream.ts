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

/** Sections built in one go. Each costs about 15ms, so this is a frame budget. */
const WINDOW = 4;
/**
 * How far ahead of the player the road must already exist.
 *
 * Generous on purpose: the police are dispatched up to three hundred units up
 * the course and path along it, so the road they are sent to has to be there
 * before they are. Two sections is roughly a thousand units, which is beyond
 * anything the director reaches for.
 */
const LOOKAHEAD_SECTIONS = 3;

export interface StreamedWorld {
  segments: CourseSegment[];
  terrain: Terrain;
  colliders: StaticCollider[];
  nav: NavGraph;
  blocksWithdrawn: number;
}

export class WorldStream {
  /** Sections whose geometry exists. Everything below this has been built. */
  private builtThrough = 0;
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
    const built = buildWorld(this.renderer, this.course, emitSections(from, to), this.colliders);
    this.builtThrough = to;
    this.withdrawn += built.blocksWithdrawn;

    this.publish();
    return true;
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
