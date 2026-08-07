/** Minimal 3D maths for the renderer: just the vector and matrix work this game needs. */

export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setAll(v: number): this {
    return this.set(v, v, v);
  }

  copyFrom(o: Vec3): this {
    return this.set(o.x, o.y, o.z);
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  /** Frame-rate independent blend toward `to`, written in place. */
  lerpTo(to: Vec3, t: number): this {
    this.x += (to.x - this.x) * t;
    this.y += (to.y - this.y) * t;
    this.z += (to.z - this.z) * t;
    return this;
  }
}

/** Column-major 4x4, laid out to match what WebGL's uniformMatrix4fv expects. */
export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * Compose translation, YXZ euler rotation and scale.
 *
 * The rotation order matters: it matches yaw-then-pitch-then-roll, which is what the
 * vehicle code assumes when it sets heading on Y and terrain attitude on X and Z.
 */
export function compose(
  out: Mat4,
  px: number,
  py: number,
  pz: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
): Mat4 {
  const cx = Math.cos(rx);
  const sxr = Math.sin(rx);
  const cy = Math.cos(ry);
  const syr = Math.sin(ry);
  const cz = Math.cos(rz);
  const szr = Math.sin(rz);

  // R = Ry * Rx * Rz
  const m00 = cy * cz + syr * sxr * szr;
  const m01 = cx * szr;
  const m02 = -syr * cz + cy * sxr * szr;
  const m10 = -cy * szr + syr * sxr * cz;
  const m11 = cx * cz;
  const m12 = syr * szr + cy * sxr * cz;
  const m20 = syr * cx;
  const m21 = -sxr;
  const m22 = cy * cx;

  out[0] = m00 * sx;
  out[1] = m01 * sx;
  out[2] = m02 * sx;
  out[3] = 0;
  out[4] = m10 * sy;
  out[5] = m11 * sy;
  out[6] = m12 * sy;
  out[7] = 0;
  out[8] = m20 * sz;
  out[9] = m21 * sz;
  out[10] = m22 * sz;
  out[11] = 0;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
  return out;
}

/**
 * Left-handed perspective.
 *
 * The whole game is written left-handed: at heading 0 the car's forward is +Z and its
 * right is +X. A right-handed projection mirrors that on screen, so the car steers
 * correctly in world space while appearing to turn the wrong way — which is exactly the
 * bug this replaced. Handedness has to match the simulation, not the graphics convention.
 */
export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (far - near);
  out[11] = 1;
  out[14] = -(2 * far * near) / (far - near);
  return out;
}

/**
 * Left-handed orthographic projection, for the shadow pass.
 *
 * Maps x∈[-w,w], y∈[-h,h], z∈[near,far] onto clip space with +z forward,
 * matching the game's left-handed convention exactly as `perspective` does.
 */
export function ortho(out: Mat4, halfW: number, halfH: number, near: number, far: number): Mat4 {
  out.fill(0);
  out[0] = 1 / halfW;
  out[5] = 1 / halfH;
  out[10] = 2 / (far - near);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

/**
 * Left-handed view matrix with an arbitrary up vector.
 *
 * The camera never needed roll until it did: a degree or two of lean into a
 * fast corner is one of the cheapest speed cues there is, and it can only be
 * expressed through the up vector.
 */
export function lookAtUp(out: Mat4, eye: Vec3, target: Vec3, ux: number, uy: number, uz: number): Mat4 {
  let zx = target.x - eye.x;
  let zy = target.y - eye.y;
  let zz = target.z - eye.z;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) {
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
  out[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  out[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  out[15] = 1;
  return out;
}

/** Left-handed view matrix, matching the projection above. */
export function lookAt(out: Mat4, eye: Vec3, target: Vec3, upY = 1): Mat4 {
  // Forward, not backward: the left-handed z axis points from the eye toward the target.
  let zx = target.x - eye.x;
  let zy = target.y - eye.y;
  let zz = target.z - eye.z;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  // up x z
  let xx = upY * zz - 0 * zy;
  let xy = 0 * zx - 0 * zz;
  let xz = 0 * zy - upY * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) {
    // Looking straight up or down; pick any stable right vector.
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
  out[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  out[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  out[15] = 1;
  return out;
}
