/**
 * Primitive geometry, generated at runtime.
 *
 * Every object in the game is a box, cylinder, sphere, torus or plane with flat shading,
 * which is exactly why the renderer can be this small — there is no mesh format to parse
 * and no assets to load.
 */

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
}

function build(
  positions: number[],
  normals: number[],
  indices: number[],
): Geometry {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

/** Axis-aligned box centred on the origin. Depth runs along Z, matching the game's convention. */
export function boxGeometry(width: number, height: number, depth: number): Geometry {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const p: number[] = [];
  const n: number[] = [];
  const i: number[] = [];

  const face = (
    nx: number, ny: number, nz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ) => {
    const base = p.length / 3;
    const cx = nx * x;
    const cy = ny * y;
    const cz = nz * z;
    // Four corners from the face centre plus its two in-plane axes.
    const corners = [
      [cx - ax - bx, cy - ay - by, cz - az - bz],
      [cx + ax - bx, cy + ay - by, cz + az - bz],
      [cx + ax + bx, cy + ay + by, cz + az + bz],
      [cx - ax + bx, cy - ay + by, cz - az + bz],
    ];
    for (const c of corners) {
      p.push(c[0], c[1], c[2]);
      n.push(nx, ny, nz);
    }
    i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  face(0, 0, 1, x, 0, 0, 0, y, 0);
  face(0, 0, -1, -x, 0, 0, 0, y, 0);
  face(1, 0, 0, 0, 0, -z, 0, y, 0);
  face(-1, 0, 0, 0, 0, z, 0, y, 0);
  face(0, 1, 0, x, 0, 0, 0, 0, z);
  face(0, -1, 0, x, 0, 0, 0, 0, -z);

  return build(p, n, i);
}

/** Cylinder or cone along Y, centred on the origin. */
export function cylinderGeometry(
  diameterTop: number,
  diameterBottom: number,
  height: number,
  segments = 12,
): Geometry {
  const rt = diameterTop / 2;
  const rb = diameterBottom / 2;
  const hy = height / 2;
  const p: number[] = [];
  const n: number[] = [];
  const i: number[] = [];

  // Side wall.
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Slope-corrected normal so cones do not shade like cylinders.
    const slope = (rb - rt) / height;
    const len = Math.hypot(1, slope);
    p.push(ca * rt, hy, sa * rt);
    n.push(ca / len, slope / len, sa / len);
    p.push(ca * rb, -hy, sa * rb);
    n.push(ca / len, slope / len, sa / len);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  // Caps.
  const cap = (radius: number, y: number, ny: number) => {
    if (radius <= 0) return;
    const centre = p.length / 3;
    p.push(0, y, 0);
    n.push(0, ny, 0);
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      p.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      n.push(0, ny, 0);
    }
    for (let s = 0; s < segments; s++) {
      if (ny > 0) i.push(centre, centre + s + 2, centre + s + 1);
      else i.push(centre, centre + s + 1, centre + s + 2);
    }
  };
  cap(rt, hy, 1);
  cap(rb, -hy, -1);

  return build(p, n, i);
}

export function sphereGeometry(diameter: number, segments = 10): Geometry {
  const r = diameter / 2;
  const rings = Math.max(3, Math.round(segments));
  const sectors = Math.max(4, Math.round(segments * 1.5));
  const p: number[] = [];
  const n: number[] = [];
  const i: number[] = [];

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let s = 0; s <= sectors; s++) {
      const theta = (s / sectors) * Math.PI * 2;
      const nx = sp * Math.cos(theta);
      const ny = cp;
      const nz = sp * Math.sin(theta);
      p.push(nx * r, ny * r, nz * r);
      n.push(nx, ny, nz);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let s = 0; s < sectors; s++) {
      const a = ring * (sectors + 1) + s;
      const b = a + sectors + 1;
      i.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return build(p, n, i);
}

/** Torus lying flat in XZ, spun about Y — the shape the blast shockwave uses. */
export function torusGeometry(diameter: number, thickness: number, segments = 24): Geometry {
  const R = diameter / 2;
  const r = thickness / 2;
  const tubeSegments = Math.max(6, Math.round(segments / 3));
  const p: number[] = [];
  const n: number[] = [];
  const i: number[] = [];

  for (let s = 0; s <= segments; s++) {
    const u = (s / segments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let t = 0; t <= tubeSegments; t++) {
      const v = (t / tubeSegments) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      p.push((R + r * cv) * cu, r * sv, (R + r * cv) * su);
      n.push(cv * cu, sv, cv * su);
    }
  }
  for (let s = 0; s < segments; s++) {
    for (let t = 0; t < tubeSegments; t++) {
      const a = s * (tubeSegments + 1) + t;
      const b = a + tubeSegments + 1;
      i.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return build(p, n, i);
}

/** Flat quad facing +Y, used for ground and the fake contact shadows. */
export function planeGeometry(width: number, depth: number): Geometry {
  const x = width / 2;
  const z = depth / 2;
  return build(
    [-x, 0, -z, x, 0, -z, x, 0, z, -x, 0, z],
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [0, 2, 1, 0, 3, 2],
  );
}
