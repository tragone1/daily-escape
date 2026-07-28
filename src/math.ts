/** Small 2D helpers. The whole simulation is 2D on the XZ plane; Y is cosmetic. */

export interface Vec2 {
  x: number;
  z: number;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent smoothing factor.
 * `lerp(current, target, damp(rate, dt))` converges at the same real-world rate
 * regardless of frame time, unlike a raw per-frame lerp.
 */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Heading (radians, 0 = +Z) of a direction vector, matching Babylon's left-handed Y rotation. */
export function headingOf(x: number, z: number): number {
  return Math.atan2(x, z);
}

/** Unit forward vector for a heading. */
export function forwardOf(heading: number): Vec2 {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

/** Unit right vector for a heading. */
export function rightOf(heading: number): Vec2 {
  return { x: Math.cos(heading), z: -Math.sin(heading) };
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(dist2(ax, az, bx, bz));
}

export function length(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/**
 * Time until a pursuer travelling at `speed` can meet a target that keeps moving at its
 * current velocity, or null when it simply cannot be caught.
 *
 * Solving |D + V t| = speed * t gives a quadratic in t; we take the smallest positive
 * root. Aiming at the resulting point instead of at the target's current position is the
 * difference between a unit that trails you forever and one that actually lands hits.
 */
export function interceptTime(
  dx: number,
  dz: number,
  vx: number,
  vz: number,
  speed: number,
): number | null {
  const a = vx * vx + vz * vz - speed * speed;
  const b = 2 * (dx * vx + dz * vz);
  const c = dx * dx + dz * dz;

  // Target and pursuer are equally fast: the quadratic degenerates to a linear equation.
  if (Math.abs(a) < 1e-4) {
    if (Math.abs(b) < 1e-6) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  const candidates = [t1, t2].filter((t) => t > 0).sort((p, q) => p - q);
  return candidates.length > 0 ? candidates[0] : null;
}
