/**
 * Route network used by the police, generated from the course spine.
 *
 * Nodes sit at every segment joint plus extra nodes along long legs, so a unit always has
 * a waypoint within about 40 units. Branch segments splice back into the spine, which is
 * what lets police take a shortcut — or lets you take one they weight against.
 *
 * Endless mode made the graph long — hundreds of nodes strung out over kilometres — so
 * routing is A* with a binary heap rather than the flat Dijkstra scan this started as.
 * The straight-line heuristic keeps the search inside a narrow corridor around the
 * direct line, which matters when twenty units re-plan several times a second.
 */

import { dist, dist2 } from "../math";
import type { CourseSegment } from "./course";
import { BRANCHES } from "./course";

export interface NavNode {
  id: number;
  x: number;
  z: number;
  y: number;
  /** Distance along the main spine, or -1 for branch-only nodes. */
  progress: number;
  edges: NavEdge[];
}

export interface NavEdge {
  to: number;
  /** Physical length multiplied by a preference weight. */
  cost: number;
}

/** Extra cost, in world units, for entering the graph at a node behind the unit. */
const BEHIND_PENALTY = 45;
/** Target spacing between nav nodes along a leg. */
const NODE_SPACING = 40;

export class NavGraph {
  readonly nodes: NavNode[] = [];

  private addNode(x: number, z: number, y: number, progress: number): NavNode {
    const existing = this.nodes.find(
      (n) => Math.abs(n.x - x) < 1.0 && Math.abs(n.z - z) < 1.0,
    );
    if (existing) {
      if (existing.progress < 0 && progress >= 0) existing.progress = progress;
      return existing;
    }
    const node: NavNode = { id: this.nodes.length, x, z, y, progress, edges: [] };
    this.nodes.push(node);
    return node;
  }

  private connect(a: NavNode, b: NavNode, weight = 1): void {
    if (a.id === b.id) return;
    const cost = dist(a.x, a.z, b.x, b.z) * weight;
    if (!a.edges.some((e) => e.to === b.id)) a.edges.push({ to: b.id, cost });
    if (!b.edges.some((e) => e.to === a.id)) b.edges.push({ to: a.id, cost });
  }

  /** Build the graph by walking the course segments. */
  static fromCourse(segments: CourseSegment[]): NavGraph {
    const g = new NavGraph();
    const branchWeight = new Map<string, number>();
    for (const b of BRANCHES) branchWeight.set(b.name, b.policyWeight);

    // Main spine first, accumulating progress so units can reason about "ahead".
    // Node spacing accumulates ACROSS segments: the curved world's spine is thousands
    // of ~6-unit slices, and a node per slice made every A* and every replan several
    // times heavier than the game was tuned for. Distance-based emission keeps the old
    // ~40-unit rhythm whatever the slice grain is.
    let progress = 0;
    let prev: NavNode | null = null;
    let sinceNode = 0;
    for (const seg of segments) {
      if (seg.branch || seg.overlay) continue;
      if (!prev) prev = g.addNode(seg.ax, seg.az, seg.ay, progress);

      sinceNode += seg.length;
      if (sinceNode >= NODE_SPACING) {
        sinceNode = 0;
        const node = g.addNode(seg.bx, seg.bz, seg.by, progress + seg.length);
        g.connect(prev, node);
        prev = node;
      }
      progress += seg.length;
    }
    // Always land a final node on the course end so lookahead queries clamp cleanly.
    {
      const last = segments.filter((sg) => !sg.branch && !sg.overlay).pop();
      if (last && prev && (prev.x !== last.bx || prev.z !== last.bz)) {
        const node = g.addNode(last.bx, last.bz, last.by, progress);
        g.connect(prev, node);
      }
    }

    // Branches: chain their own nodes, then stitch both ends into the spine.
    for (const branch of BRANCHES) {
      const segs = segments.filter(
        (s) => s.branch && branchIncludes(branch.name, s, segments),
      );
      if (segs.length === 0) continue;

      const weight = branchWeight.get(branch.name) ?? 1;
      let node = g.nearestNode(segs[0].ax, segs[0].az);
      for (const seg of segs) {
        const steps = Math.max(1, Math.round(seg.length / NODE_SPACING));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const next = g.addNode(
            seg.ax + (seg.bx - seg.ax) * t,
            seg.az + (seg.bz - seg.az) * t,
            seg.ay + (seg.by - seg.ay) * t,
            -1,
          );
          g.connect(node, next, weight);
          node = next;
        }
      }
      // Rejoin: the branch's last point coincides with a spine node.
      const rejoin = g.nearestNode(node.x, node.z, node.id);
      g.connect(node, rejoin, weight);
    }

    return g;
  }

  nearestNode(x: number, z: number, excludeId = -1): NavNode {
    let best = this.nodes[0];
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (n.id === excludeId) continue;
      const d = dist2(n.x, n.z, x, z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * Entry point into the graph for a unit that is already moving.
   *
   * Nodes behind the unit are penalised rather than excluded. A hard filter looks
   * correct but backfires badly: a car pointing away from its goal picks a node far in
   * the wrong direction, drives there, and so reinforces its own mistake.
   */
  nearestNodeAhead(x: number, z: number, dirX: number, dirZ: number): NavNode {
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = dirX / len;
    const nz = dirZ / len;

    let best = this.nodes[0];
    let bestCost = Infinity;
    for (const n of this.nodes) {
      const dx = n.x - x;
      const dz = n.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const cost = d + (dx * nx + dz * nz < 0 ? BEHIND_PENALTY : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = n;
      }
    }
    return best;
  }

  /**
   * Node closest to a given distance along the spine — used for spawning and posts.
   *
   * Backed by a sorted index built once, because this runs for every spawn decision and
   * every frame's squad goal on a graph that is now hundreds of nodes long.
   */
  nodeAtProgress(target: number): NavNode {
    const spine = this.spine ?? this.buildSpineIndex();
    let lo = 0;
    let hi = spine.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spine[mid].progress < target) lo = mid + 1;
      else hi = mid;
    }
    const at = spine[lo];
    const before = spine[Math.max(0, lo - 1)];
    return Math.abs(before.progress - target) < Math.abs(at.progress - target) ? before : at;
  }

  private spine: NavNode[] | null = null;

  private buildSpineIndex(): NavNode[] {
    this.spine = this.nodes
      .filter((n) => n.progress >= 0)
      .sort((a, b) => a.progress - b.progress);
    return this.spine;
  }

  /**
   * A* over the node set. Returns nodes from `fromId` to `toId` inclusive.
   *
   * The heuristic is plain straight-line distance, which is admissible as long as no edge
   * is cheaper than its own length — that is, as long as branch preference weights stay
   * at or above 1. A weight below 1 would make the route *look* longer than the heuristic
   * promises and A* could then miss the true shortest path.
   */
  findPath(fromId: number, toId: number): NavNode[] {
    if (fromId === toId) return [this.nodes[toId]];

    const count = this.nodes.length;
    // Scratch arrays are held on the graph and refilled per call: routing runs dozens of
    // times a second and should not be handing the collector fresh typed arrays.
    if (!this.distTo || this.distTo.length !== count) {
      this.distTo = new Float64Array(count);
      this.prev = new Int32Array(count);
      this.closed = new Uint8Array(count);
    }
    const distTo = this.distTo!;
    const prev = this.prev!;
    const closed = this.closed!;
    distTo.fill(Infinity);
    prev.fill(-1);
    closed.fill(0);

    const goal = this.nodes[toId];
    const heap = new MinHeap();
    distTo[fromId] = 0;
    heap.push(fromId, dist(this.nodes[fromId].x, this.nodes[fromId].z, goal.x, goal.z));

    while (heap.size > 0) {
      const current = heap.pop();
      if (current === toId) break;
      if (closed[current]) continue;
      closed[current] = 1;

      for (const edge of this.nodes[current].edges) {
        const alt = distTo[current] + edge.cost;
        if (alt >= distTo[edge.to]) continue;
        distTo[edge.to] = alt;
        prev[edge.to] = current;
        const n = this.nodes[edge.to];
        heap.push(edge.to, alt + dist(n.x, n.z, goal.x, goal.z));
      }
    }

    if (distTo[toId] === Infinity) return [];

    const path: NavNode[] = [];
    for (let at = toId; at !== -1; at = prev[at]) {
      path.push(this.nodes[at]);
      if (at === fromId) break;
    }
    return path.reverse();
  }

  private distTo: Float64Array | null = null;
  private prev: Int32Array | null = null;
  private closed: Uint8Array | null = null;
}

/**
 * Binary heap keyed by f-score. Lazy deletion — a node can be pushed more than once and
 * stale entries are skipped by the closed set — which is cheaper than a decrease-key.
 */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.keys.length && this.keys[l] < this.keys[best]) best = l;
        if (r < this.keys.length && this.keys[r] < this.keys[best]) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = id;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

/** Branch segments are stored contiguously; match them back to their branch by order. */
function branchIncludes(name: string, seg: CourseSegment, all: CourseSegment[]): boolean {
  let index = 0;
  for (const b of BRANCHES) {
    const start = all.findIndex((s) => s.branch) + index;
    if (b.name === name) {
      return seg.index >= start && seg.index < start + b.legs.length;
    }
    index += b.legs.length;
  }
  return false;
}
