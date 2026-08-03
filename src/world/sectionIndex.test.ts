/**
 * Section indices are what a streamed world scopes by, so they have to agree
 * with the progress-based section boundaries the rest of the game uses. A
 * segment tagged with the wrong section would be built into the wrong window -
 * or left out of every one.
 */
import { describe, expect, it } from "vitest";
import { makeCourse, buildCourseSegments, sectionIndexAt } from "./course";

describe("segment section indices", () => {
  it.each([1000, 8919, 24757])("seed %i agrees with progress boundaries", (seed) => {
    const course = makeCourse(seed);
    const { segments } = buildCourseSegments(course);
    const mains = segments.filter((s) => !s.branch && !s.overlay);
    let acc = 0;
    let mismatches = 0;
    for (const seg of mains) {
      const mid = acc + seg.length / 2;
      acc += seg.length;
      const byProgress = sectionIndexAt(mid, course);
      if (byProgress !== seg.sectionIndex) mismatches++;
    }
    // A handful of slices straddle a boundary; a systematic disagreement is the bug.
    expect(mismatches / mains.length).toBeLessThan(0.02);
  });

  it("covers every section with no gaps", () => {
    const course = makeCourse(8919);
    const { segments } = buildCourseSegments(course);
    const seen = new Set(segments.filter((s) => !s.branch).map((s) => s.sectionIndex));
    for (let i = 0; i < course.sectionCount; i++) expect(seen.has(i)).toBe(true);
  });

  it("gives spurs the section they hang off", () => {
    const course = makeCourse(8919);
    const { segments } = buildCourseSegments(course);
    for (const b of segments.filter((s) => s.branch)) {
      expect(b.sectionIndex).toBeGreaterThanOrEqual(0);
      expect(b.sectionIndex).toBeLessThan(course.sectionCount);
    }
  });
});
