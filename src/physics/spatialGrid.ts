/**
 * Uniform spatial hash over the static world.
 *
 * Endless mode made this necessary. A fixed course could get away with testing every car
 * against every collider — there were a few hundred of them. The generated course is
 * twenty-odd sections long with thousands, and the per-frame cost is multiplied by the
 * whole squad: every unit resolves collisions twice a frame and casts avoidance feelers
 * on top of that. Bucketing by cell turns all of it into a handful of local tests.
 *
 * Items are inserted into every cell their bounding circle touches, so a query only has
 * to visit the cells overlapping its own bounds. An epoch-stamped seen-list keeps results
 * duplicate-free without allocating a Set per query.
 */

export interface GridItem {
  radius: number;
  obb: { x: number; z: number };
}

/** Cell size in world units. Comfortably larger than the biggest collider. */
const CELL = 48;

export class SpatialGrid<T extends GridItem> {
  private cells = new Map<number, number[]>();
  private seen: Int32Array;
  private epoch = 0;

  constructor(private readonly items: T[]) {
    this.seen = new Int32Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const minX = Math.floor((it.obb.x - it.radius) / CELL);
      const maxX = Math.floor((it.obb.x + it.radius) / CELL);
      const minZ = Math.floor((it.obb.z - it.radius) / CELL);
      const maxZ = Math.floor((it.obb.z + it.radius) / CELL);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = keyOf(cx, cz);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  /**
   * Everything whose cell overlaps the given world-space box, written into `out`.
   *
   * `out` is caller-owned and reused, so a hot loop can query without allocating.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): T[] {
    out.length = 0;
    this.epoch++;
    const cx0 = Math.floor(minX / CELL);
    const cx1 = Math.floor(maxX / CELL);
    const cz0 = Math.floor(minZ / CELL);
    const cz1 = Math.floor(maxZ / CELL);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = this.cells.get(keyOf(cx, cz));
        if (!bucket) continue;
        for (const i of bucket) {
          if (this.seen[i] === this.epoch) continue;
          this.seen[i] = this.epoch;
          out.push(this.items[i]);
        }
      }
    }
    return out;
  }

  /** Convenience wrapper for a circular region. */
  queryCircle(x: number, z: number, radius: number, out: T[]): T[] {
    return this.query(x - radius, z - radius, x + radius, z + radius, out);
  }
}

/**
 * Hash a cell coordinate. The course is bounded to a few thousand units either way, so
 * offsetting into positive space and packing is exact and faster than a mixing hash.
 */
function keyOf(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}
