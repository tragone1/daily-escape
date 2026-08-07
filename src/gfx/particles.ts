/**
 * Pooled particles and skid marks, drawn in two draw calls.
 *
 * Everything transient the game throws - tire smoke, surface dust, sparks,
 * explosion fire, boost jets - lives in one fixed pool of soft billboard
 * discs, split at draw time into an alpha-blended pass (smoke, dust) and an
 * additive pass (fire, sparks, glow). Skid marks are a second, simpler pool:
 * world-space quads laid on the road that fade with age. Nothing is allocated
 * after construction; a spawn past capacity recycles the oldest slot, which
 * in a busy chase is exactly the particle nobody was looking at.
 */

import type { Mat4 } from "./math3d";

const PARTICLE_VERT = `#version 300 es
in vec3 aCenter;
in vec2 aCorner;
in vec4 aColor;
in float aSize;
uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
out vec2 vCorner;
out vec4 vColor;
out float vDepth;
void main() {
  vec3 world = aCenter + (uCamRight * aCorner.x + uCamUp * aCorner.y) * aSize;
  vCorner = aCorner;
  vColor = aColor;
  vDepth = length(uCamPos - world);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const PARTICLE_FRAG = `#version 300 es
precision mediump float;
in vec2 vCorner;
in vec4 vColor;
in float vDepth;
uniform vec2 uFogRange;
uniform vec3 uFogColor;
/** 1: alpha blend toward fog colour. 0: additive, fade out with distance. */
uniform float uFoggy;
out vec4 fragColor;
void main() {
  float d = length(vCorner);
  float soft = smoothstep(1.0, 0.25, d);
  float fog = clamp((vDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  vec3 rgb = mix(vColor.rgb, uFogColor, fog * uFoggy);
  float a = vColor.a * soft * (1.0 - fog * (1.0 - uFoggy));
  fragColor = vec4(rgb, a);
}`;

const SKID_VERT = `#version 300 es
in vec3 aPos;
in float aAlpha;
uniform mat4 uViewProj;
out float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const SKID_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.02, 0.02, 0.025, vAlpha);
}`;

const MAX_PARTICLES = 2048;
const MAX_SKIDS = 512;

export interface SpawnOpts {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  life: number;
  /** Diameter at birth and at death; particles grow or shrink linearly. */
  size0: number; size1: number;
  r: number; g: number; b: number;
  alpha?: number;
  gravity?: number;
  drag?: number;
  additive?: boolean;
}

export class EffectsField {
  // Particle pool, structure-of-arrays.
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pz = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private vz = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private size0 = new Float32Array(MAX_PARTICLES);
  private size1 = new Float32Array(MAX_PARTICLES);
  private cr = new Float32Array(MAX_PARTICLES);
  private cg = new Float32Array(MAX_PARTICLES);
  private cb = new Float32Array(MAX_PARTICLES);
  private ca = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private additive = new Uint8Array(MAX_PARTICLES);
  private cursor = 0;
  private liveCount = 0;

  // Skid pool: two triangles per segment, world-space.
  private skid = new Float32Array(MAX_SKIDS * 12); // 4 corners x,y,z
  private skidAge = new Float32Array(MAX_SKIDS);
  private skidStrength = new Float32Array(MAX_SKIDS);
  private skidCursor = 0;

  // GL plumbing, lazily built against whichever context draws first.
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private skidProg: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private skidVao: WebGLVertexArrayObject | null = null;
  private skidVbo: WebGLBuffer | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private skidUni: Record<string, WebGLUniformLocation | null> = {};
  private scratch = new Float32Array(MAX_PARTICLES * 4 * 10);
  private skidScratch = new Float32Array(MAX_SKIDS * 6 * 4);
  private quadIndices: WebGLBuffer | null = null;

  /** How many particles a device is allowed; the mobile tier halves it. */
  budget = MAX_PARTICLES;

  spawn(o: SpawnOpts): void {
    // Recycle round-robin: past the budget the oldest slot is simply taken.
    let i = this.cursor;
    const start = i;
    do {
      i = (i + 1) % this.budget;
      if (this.life[i] <= 0) break;
    } while (i !== start);
    this.cursor = i;
    this.px[i] = o.x; this.py[i] = o.y; this.pz[i] = o.z;
    this.vx[i] = o.vx ?? 0; this.vy[i] = o.vy ?? 0; this.vz[i] = o.vz ?? 0;
    this.life[i] = o.life; this.maxLife[i] = o.life;
    this.size0[i] = o.size0; this.size1[i] = o.size1;
    this.cr[i] = o.r; this.cg[i] = o.g; this.cb[i] = o.b;
    this.ca[i] = o.alpha ?? 1;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.additive[i] = o.additive ? 1 : 0;
  }

  /** Lay one skid quad from the previous wheel point to the current one. */
  mark(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number, strength: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || len > 4) return;
    const pxn = -dz / len * (width / 2);
    const pzn = dx / len * (width / 2);
    const i = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % MAX_SKIDS;
    const b = i * 12;
    this.skid[b] = x0 - pxn; this.skid[b + 1] = y0; this.skid[b + 2] = z0 - pzn;
    this.skid[b + 3] = x0 + pxn; this.skid[b + 4] = y0; this.skid[b + 5] = z0 + pzn;
    this.skid[b + 6] = x1 + pxn; this.skid[b + 7] = y1; this.skid[b + 8] = z1 + pzn;
    this.skid[b + 9] = x1 - pxn; this.skid[b + 10] = y1; this.skid[b + 11] = z1 - pzn;
    this.skidAge[i] = 0.001;
    this.skidStrength[i] = strength;
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < this.budget; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const dragK = this.drag[i] > 0 ? Math.exp(-this.drag[i] * dt) : 1;
      this.vx[i] *= dragK;
      this.vz[i] *= dragK;
      this.vy[i] = this.vy[i] * dragK + this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      live++;
    }
    this.liveCount = live;
    for (let i = 0; i < MAX_SKIDS; i++) {
      if (this.skidAge[i] > 0) this.skidAge[i] += dt;
    }
  }

  /** Called by the renderer inside the blended phase. Never call directly. */
  draw(
    gl: WebGL2RenderingContext,
    viewProj: Mat4,
    camRight: [number, number, number],
    camUp: [number, number, number],
    camPos: [number, number, number],
    fogRange: [number, number],
    fogColor: [number, number, number],
  ): void {
    if (this.gl !== gl) this.build(gl);

    // --- Skids first: they lie on the road under everything else ----------
    let skidVerts = 0;
    {
      const out = this.skidScratch;
      for (let i = 0; i < MAX_SKIDS; i++) {
        const age = this.skidAge[i];
        if (age <= 0 || age > 9) continue;
        const alpha = Math.min(0.42, this.skidStrength[i]) * (1 - age / 9);
        if (alpha <= 0.01) continue;
        const b = i * 12;
        // Two triangles: 0,1,2 and 0,2,3.
        for (const c of [0, 1, 2, 0, 2, 3]) {
          out[skidVerts * 4] = this.skid[b + c * 3];
          out[skidVerts * 4 + 1] = this.skid[b + c * 3 + 1];
          out[skidVerts * 4 + 2] = this.skid[b + c * 3 + 2];
          out[skidVerts * 4 + 3] = alpha;
          skidVerts++;
        }
      }
      if (skidVerts > 0) {
        gl.useProgram(this.skidProg);
        gl.uniformMatrix4fv(this.skidUni.uViewProj, false, viewProj);
        gl.bindVertexArray(this.skidVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.skidVbo);
        gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, skidVerts * 4), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, skidVerts);
      }
    }

    if (this.liveCount === 0) {
      gl.bindVertexArray(null);
      return;
    }

    // --- Particles: alpha pass then additive pass -------------------------
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uni.uViewProj, false, viewProj);
    gl.uniform3fv(this.uni.uCamRight, camRight);
    gl.uniform3fv(this.uni.uCamUp, camUp);
    gl.uniform3fv(this.uni.uCamPos, camPos);
    gl.uniform2fv(this.uni.uFogRange, fogRange);
    gl.uniform3fv(this.uni.uFogColor, fogColor);
    gl.bindVertexArray(this.vao);

    for (const pass of [0, 1] as const) {
      let quads = 0;
      const out = this.scratch;
      for (let i = 0; i < this.budget; i++) {
        if (this.life[i] <= 0 || this.additive[i] !== pass) continue;
        const k = this.life[i] / this.maxLife[i];
        const size = (this.size1[i] + (this.size0[i] - this.size1[i]) * k) / 2;
        const alpha = this.ca[i] * Math.min(1, k * 3);
        let v = quads * 40;
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          out[v] = this.px[i]; out[v + 1] = this.py[i]; out[v + 2] = this.pz[i];
          out[v + 3] = cx; out[v + 4] = cy;
          out[v + 5] = this.cr[i]; out[v + 6] = this.cg[i]; out[v + 7] = this.cb[i];
          out[v + 8] = alpha;
          out[v + 9] = size;
          v += 10;
        }
        quads++;
      }
      if (quads === 0) continue;
      if (pass === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.uni.uFoggy, pass === 1 ? 0 : 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, quads * 40), gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, quads * 6, gl.UNSIGNED_SHORT, 0);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
  }

  private build(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    const compile = (vs: string, fs: string, attrs: string[]): WebGLProgram => {
      const mk = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error("Particle shader failed: " + gl.getShaderInfoLog(sh));
        }
        return sh;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("Particle link failed: " + gl.getProgramInfoLog(p));
      }
      return p;
    };

    this.prog = compile(PARTICLE_VERT, PARTICLE_FRAG, ["aCenter", "aCorner", "aColor", "aSize"]);
    this.skidProg = compile(SKID_VERT, SKID_FRAG, ["aPos", "aAlpha"]);
    for (const n of ["uViewProj", "uCamRight", "uCamUp", "uCamPos", "uFogRange", "uFogColor", "uFoggy"]) {
      this.uni[n] = gl.getUniformLocation(this.prog, n);
    }
    for (const n of ["uViewProj"]) this.skidUni[n] = gl.getUniformLocation(this.skidProg, n);

    // Shared static index buffer: quads in order.
    const idx = new Uint16Array(MAX_PARTICLES * 6);
    for (let q = 0; q < MAX_PARTICLES; q++) {
      idx[q * 6] = q * 4;
      idx[q * 6 + 1] = q * 4 + 1;
      idx[q * 6 + 2] = q * 4 + 2;
      idx[q * 6 + 3] = q * 4;
      idx[q * 6 + 4] = q * 4 + 2;
      idx[q * 6 + 5] = q * 4 + 3;
    }
    this.quadIndices = gl.createBuffer()!;

    this.vbo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 10 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.skidVbo = gl.createBuffer()!;
    this.skidVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.skidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skidVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
  }
}

/**
 * The one shared field, wired by the game at boot.
 *
 * A module singleton rather than a constructor parameter, because the things
 * that emit - rockets, hazards, the collision handler - are constructed in
 * half a dozen places that have no business knowing about GPU pools.
 */
export const FX: { field: EffectsField | null } = { field: null };
