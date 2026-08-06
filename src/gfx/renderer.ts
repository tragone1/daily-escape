/**
 * A small WebGL2 renderer built for exactly this game.
 *
 * It replaced Babylon.js, which was 1.5 MB of the 1.55 MB shareable build and stopped
 * that build from running at all. Everything here is flat-shaded primitives with a
 * hemispheric + directional light and linear fog, which is all the game's look ever used.
 *
 * The important trick is static batching: the ~1,100 pieces of scenery are baked into a
 * single vertex buffer at build time, so the entire world costs one draw call and only
 * the cars and effects are drawn individually.
 */

import { compose, lookAt, mat4, multiply, perspective, Vec3, type Mat4 } from "./math3d";
import {
  boxGeometry,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
  torusGeometry,
  type Geometry,
} from "./primitives";

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec4 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uCamPos;
out vec3 vNormal;
out vec4 vColor;
out float vDepth;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vDepth = length(uCamPos - world.xyz);
  gl_Position = uViewProj * world;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec4 vColor;
in float vDepth;
uniform vec3 uLightDir;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform vec4 uTint;
uniform float uAlpha;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  float lambert = max(dot(n, -uLightDir), 0.0);
  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5);
  vec3 base = vColor.rgb * uTint.rgb;
  // vColor.a carries the emissive amount; uTint.a adds a per-draw boost.
  vec3 lit = base * (ambient + lambert * 0.72) + base * (vColor.a + uTint.a);
  float fog = clamp((vDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  fragColor = vec4(mix(lit, uFogColor, fog), uAlpha);
}`;

export type Shape =
  | { kind: "box"; width: number; height: number; depth: number }
  | {
      /**
       * Arbitrary pre-built triangle geometry, in the mesh's local space.
       *
       * Exists for the ground: a curved course cannot be tiled out of boxes without
       * either gaps or overlapping coplanar faces, and both of those looks are exactly
       * what the terrain overhaul removed. Custom meshes are expected to be static and
       * flat-shaded - callers duplicate vertices per face and supply face normals.
       */
      kind: "custom";
      geometry: Geometry;
    }
  | { kind: "cylinder"; diameterTop: number; diameterBottom: number; height: number; tessellation?: number }
  | { kind: "sphere"; diameter: number; segments?: number }
  | { kind: "torus"; diameter: number; thickness: number; tessellation?: number }
  | { kind: "plane"; width: number; depth: number };

function geometryFor(shape: Shape): Geometry {
  switch (shape.kind) {
    case "custom":
      return shape.geometry;
    case "box":
      return boxGeometry(shape.width, shape.height, shape.depth);
    case "cylinder":
      return cylinderGeometry(
        shape.diameterTop,
        shape.diameterBottom,
        shape.height,
        shape.tessellation ?? 12,
      );
    case "sphere":
      return sphereGeometry(shape.diameter, shape.segments ?? 10);
    case "torus":
      return torusGeometry(shape.diameter, shape.thickness, shape.tessellation ?? 24);
    case "plane":
      return planeGeometry(shape.width, shape.depth);
  }
}

/** A transform in the scene graph. Mirrors just enough of a classic node to be familiar. */
export class Node3D {
  readonly position = new Vec3();
  readonly rotation = new Vec3();
  readonly scaling = new Vec3(1, 1, 1);
  parent: Node3D | null = null;
  private enabled = true;
  private readonly local = mat4();
  private readonly world = mat4();

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isEnabled(): boolean {
    if (!this.enabled) return false;
    return this.parent ? this.parent.isEnabled() : true;
  }

  /** World matrix, recomputed on demand — the scene is small enough not to need caching. */
  worldMatrix(): Mat4 {
    compose(
      this.local,
      this.position.x, this.position.y, this.position.z,
      this.rotation.x, this.rotation.y, this.rotation.z,
      this.scaling.x, this.scaling.y, this.scaling.z,
    );
    if (!this.parent) {
      this.world.set(this.local);
      return this.world;
    }
    return multiply(this.world, this.parent.worldMatrix(), this.local);
  }
}

export interface MeshOptions {
  color: [number, number, number];
  /** 0 = fully lit, 1 = fully self-lit. Matches the old emissive-scale look. */
  emissive?: number;
  alpha?: number;
  /** Baked into the world batch. Static meshes must not move after `bake()`. */
  isStatic?: boolean;
}

export class Mesh extends Node3D {
  color: [number, number, number];
  emissive: number;
  alpha: number;
  readonly isStatic: boolean;
  /** Per-draw multiply on colour plus additive emissive, for flashing lights and fades. */
  tint: [number, number, number, number] = [1, 1, 1, 0];

  constructor(
    readonly shape: Shape,
    opts: MeshOptions,
    private readonly renderer: Renderer,
  ) {
    super();
    this.color = opts.color;
    this.emissive = opts.emissive ?? 0.26;
    this.alpha = opts.alpha ?? 1;
    this.isStatic = opts.isStatic ?? false;
    renderer.register(this);
  }

  dispose(): void {
    this.renderer.remove(this);
  }
}

/**
 * How far past the fog's end a chunk may still be drawn.
 *
 * A chunk is culled by its bounding box, and the box's nearest corner can be
 * well behind geometry that still shows at the box's far side; the slack keeps
 * that from popping at the edge of visibility.
 */
const CHUNK_FOG_SLACK = 260;

interface GpuGeometry {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  /** gl.UNSIGNED_SHORT or gl.UNSIGNED_INT, matching the uploaded index array. */
  indexType: number;
  /**
   * Every buffer bound into the VAO, so it can be released.
   *
   * Deleting a vertex array does NOT free the buffers attached to it - they
   * only go when the last reference does. A streamed world that dropped chunks
   * without these would leak the whole course's geometry over a long run.
   */
  buffers: WebGLBuffer[];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera = {
    position: new Vec3(0, 10, -20),
    target: new Vec3(),
    fov: 0.95,
    near: 0.4,
    far: 900,
  };

  /** Scene-wide lighting and fog, set once by the game. */
  lightDir: [number, number, number] = [-0.4, -0.85, 0.3];
  sky: [number, number, number] = [0.62, 0.64, 0.72];
  ground: [number, number, number] = [0.2, 0.21, 0.28];
  fogColor: [number, number, number] = [0.04, 0.05, 0.09];
  fogRange: [number, number] = [190, 620];
  clearColor: [number, number, number] = [0.03, 0.04, 0.07];

  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private meshes: Mesh[] = [];
  private cache = new Map<string, GpuGeometry>();
  /**
   * Static geometry, baked in chunks rather than one buffer.
   *
   * One buffer meant one draw call for the whole world, which was the right
   * trade when the world was fixed - but it also meant every triangle in it was
   * submitted every frame, and a streamed world cannot release anything from a
   * buffer it shares with everything else. Chunks keep the draw calls low (one
   * per resident chunk, a handful) while making the world both cullable and
   * disposable.
   */
  private chunks = new Map<string, { gpu: GpuGeometry; minX: number; maxX: number; minZ: number; maxZ: number }>();
  private batched = new Set<Mesh>();
  private viewProj = mat4();
  private proj = mat4();
  private view = mat4();
  private identity = mat4();
  private lastTime = 0;
  private fps = 60;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // Lets the canvas be read back (screenshots, future share cards); negligible cost.
      preserveDrawingBuffer: true,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    this.program = this.link(VERT, FRAG);
    for (const name of [
      "uViewProj", "uModel", "uCamPos", "uLightDir", "uSky", "uGround",
      "uFogColor", "uFogRange", "uTint", "uAlpha",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    gl.enable(gl.DEPTH_TEST);
    // Everything is drawn double-sided: the ground planes and the fake contact shadows
    // are single quads that must be visible from either side, and nothing here is heavy
    // enough for backface culling to be worth the risk of invisible geometry.
    gl.disable(gl.CULL_FACE);
    this.resize();
  }

  private link(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("Shader failed: " + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.bindAttribLocation(prog, 1, "aNormal");
    gl.bindAttribLocation(prog, 2, "aColor");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Program link failed: " + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  register(mesh: Mesh): void {
    this.meshes.push(mesh);
  }

  remove(mesh: Mesh): void {
    const i = this.meshes.indexOf(mesh);
    if (i >= 0) this.meshes.splice(i, 1);
  }

  createMesh(shape: Shape, opts: MeshOptions): Mesh {
    return new Mesh(shape, opts, this);
  }

  createNode(): Node3D {
    return new Node3D();
  }

  private customCache = new WeakMap<Geometry, GpuGeometry>();

  /** Upload a unit primitive once and reuse it for every mesh of that shape. */
  private gpuFor(shape: Shape): GpuGeometry {
    if (shape.kind === "custom") {
      const hit = this.customCache.get(shape.geometry);
      if (hit) return hit;
      const geo = shape.geometry;
      const vertexCount = geo.positions.length / 3;
      const colors = new Float32Array(vertexCount * 4);
      for (let i = 0; i < vertexCount; i++) {
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
      }
      const made = this.upload(geo.positions, geo.normals, colors, geo.indices);
      this.customCache.set(shape.geometry, made);
      return made;
    }
    const key = JSON.stringify(shape);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const geo = geometryFor(shape);
    // Unit primitives carry no colour of their own; it arrives through uTint at draw
    // time. RGB stays 1 so the tint passes through unchanged, and emissive stays 0 so
    // the draw's tint alpha is the only self-lit contribution.
    const vertexCount = geo.positions.length / 3;
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = 0;
    }
    const made = this.upload(geo.positions, geo.normals, colors, geo.indices);
    this.cache.set(key, made);
    return made;
  }

  private upload(
    positions: Float32Array,
    normals: Float32Array,
    colors: Float32Array,
    indices: Uint16Array | Uint32Array,
  ): GpuGeometry {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const buffers: WebGLBuffer[] = [];
    const bind = (data: Float32Array, loc: number, size: number) => {
      const buf = gl.createBuffer()!;
      buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data as unknown as ArrayBufferView, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(positions, 0, 3);
    bind(normals, 1, 3);
    bind(colors, 2, 4);

    const ib = gl.createBuffer()!;
    buffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices as unknown as ArrayBufferView, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    return {
      vao,
      indexCount: indices.length,
      indexType: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      buffers,
    };
  }

  /**
   * Bake every static mesh into one buffer.
   *
   * Called once after the world is built. Transforms are applied on the CPU here, which
   * is why static meshes must not move afterwards — in exchange the whole course renders
   * in a single draw call instead of eleven hundred.
   */
  /**
   * Bake the static scenery into several chunks at once.
   *
   * `chunkOf` says which chunk a mesh's position belongs to; every mesh is
   * transformed and copied into that chunk's buffer, then dropped, because a
   * baked mesh has no life of its own afterwards.
   */
  bakeGrouped(
    chunkOf: (x: number, z: number) => number,
    chunkCount: number,
    /** Namespace for the chunk ids, so windows cannot overwrite each other's. */
    prefix = "chunk",
    /**
     * Meshes to leave out of this bake. Baking is permanent - the mesh is
     * copied into a chunk's buffer and forgotten - so anything that might
     * still be withdrawn (a streamed window's road blocks, until the next
     * window's sweep has run) is excluded here and baked by a later call.
     */
    exclude?: ReadonlySet<unknown>,
  ): void {
    const statics = this.meshes.filter(
      (m) => m.isStatic && !this.batched.has(m) && !exclude?.has(m),
    );
    if (statics.length === 0) return;
    const groups: Mesh[][] = Array.from({ length: chunkCount }, () => []);
    for (const mesh of statics) {
      /*
       * Place a mesh by where its geometry actually is, not by its transform.
       *
       * The road ribbon, the spur surfaces and their curtains are built with
       * world-space vertices and left sitting at the origin, so their
       * transforms all read (0,0,0) - grouping on that dropped every one of
       * them into a single chunk, which is most of the world's triangles in
       * one indivisible lump that is always on screen.
       */
      const geo = geometryFor(mesh.shape);
      const m = mesh.worldMatrix();
      let sx = 0;
      let sz = 0;
      const n = geo.positions.length / 3;
      const step = Math.max(1, Math.floor(n / 32));
      let taken = 0;
      for (let i = 0; i < n; i += step) {
        const x = geo.positions[i * 3];
        const y = geo.positions[i * 3 + 1];
        const z = geo.positions[i * 3 + 2];
        sx += m[0] * x + m[4] * y + m[8] * z + m[12];
        sz += m[2] * x + m[6] * y + m[10] * z + m[14];
        taken++;
      }
      const idx = Math.max(0, Math.min(chunkCount - 1, chunkOf(sx / taken, sz / taken)));
      groups[idx].push(mesh);
    }
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].length > 0) this.bakeMeshes(groups[i], `${prefix}:${i}`);
    }
    this.forgetBaked();
  }

  bake(chunkId = "world"): void {
    const statics = this.meshes.filter((m) => m.isStatic && !this.batched.has(m));
    if (statics.length === 0) return;
    this.bakeMeshes(statics, chunkId);
  }

  private bakeMeshes(statics: Mesh[], chunkId: string): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (const mesh of statics) {
      const geo = geometryFor(mesh.shape);
      const m = mesh.worldMatrix();
      const base = positions.length / 3;

      for (let i = 0; i < geo.positions.length; i += 3) {
        const x = geo.positions[i];
        const y = geo.positions[i + 1];
        const z = geo.positions[i + 2];
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
        const nx = geo.normals[i];
        const ny = geo.normals[i + 1];
        const nz = geo.normals[i + 2];
        // Uniform scale only, so the plain rotation part is a fine normal matrix.
        const wx = m[0] * nx + m[4] * ny + m[8] * nz;
        const wy = m[1] * nx + m[5] * ny + m[9] * nz;
        const wz = m[2] * nx + m[6] * ny + m[10] * nz;
        const len = Math.hypot(wx, wy, wz) || 1;
        normals.push(wx / len, wy / len, wz / len);
        colors.push(mesh.color[0], mesh.color[1], mesh.color[2], mesh.emissive);
        const px = positions[positions.length - 3];
        const pz = positions[positions.length - 1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      for (const idx of geo.indices) indices.push(base + idx);
      this.batched.add(mesh);
    }

    const gpu = this.upload(
      new Float32Array(positions),
      new Float32Array(normals),
      new Float32Array(colors),
      new Uint32Array(indices),
    );
    this.disposeChunk(chunkId);
    this.chunks.set(chunkId, { gpu, minX, maxX, minZ, maxZ });
  }

  /**
   * Release a baked chunk and the meshes that went into it.
   *
   * The meshes are scenery that has been copied into the chunk's buffer, so
   * they have no life of their own once it exists - dropping both together is
   * what keeps a streamed world's memory flat however long a run lasts.
   */
  disposeChunk(chunkId: string): void {
    const existing = this.chunks.get(chunkId);
    if (!existing) return;
    const gl = this.gl;
    gl.deleteVertexArray(existing.gpu.vao);
    for (const buf of existing.gpu.buffers) gl.deleteBuffer(buf);
    this.chunks.delete(chunkId);
  }

  /**
   * Drop every chunk in a namespace: the geometry of a retired stretch of
   * course, released in one call along with its GPU buffers.
   */
  disposeChunkGroup(prefix: string): number {
    let dropped = 0;
    for (const id of [...this.chunks.keys()]) {
      if (id.startsWith(`${prefix}:`)) {
        this.disposeChunk(id);
        dropped++;
      }
    }
    return dropped;
  }

  /** Meshes already folded into a chunk, so they are not drawn individually. */
  forgetBaked(): void {
    for (let i = this.meshes.length - 1; i >= 0; i--) {
      if (this.batched.has(this.meshes[i])) this.meshes.splice(i, 1);
    }
    this.batched.clear();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Milliseconds since the previous frame, clamped by the caller. */
  frameTime(): number {
    const now = performance.now();
    const dt = this.lastTime === 0 ? 16.7 : now - this.lastTime;
    this.lastTime = now;
    if (dt > 0) this.fps += (1000 / dt - this.fps) * 0.1;
    return dt;
  }

  getFps(): number {
    return this.fps;
  }

  render(): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    perspective(this.proj, this.camera.fov, this.canvas.width / this.canvas.height, this.camera.near, this.camera.far);
    lookAt(this.view, this.camera.position, this.camera.target);
    multiply(this.viewProj, this.proj, this.view);

    const u = this.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform3f(u.uCamPos, this.camera.position.x, this.camera.position.y, this.camera.position.z);
    gl.uniform3fv(u.uLightDir, this.lightDir);
    gl.uniform3fv(u.uSky, this.sky);
    gl.uniform3fv(u.uGround, this.ground);
    gl.uniform3fv(u.uFogColor, this.fogColor);
    gl.uniform2fv(u.uFogRange, this.fogRange);

    /*
     * Static world: one call per chunk, and only the chunks worth drawing.
     *
     * Fog closes long before the far plane, so a chunk whose nearest corner is
     * already past the fog's end contributes nothing but vertex work. The whole
     * course used to be submitted every frame regardless - a hundred and twenty
     * thousand triangles for a road you could see six hundred units of.
     */
    gl.uniformMatrix4fv(u.uModel, false, this.identity);
    gl.uniform4f(u.uTint, 1, 1, 1, 0);
    gl.uniform1f(u.uAlpha, 1);
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    const cutoff = this.fogRange[1] + CHUNK_FOG_SLACK;
    for (const chunk of this.chunks.values()) {
      const dx = Math.max(chunk.minX - cx, 0, cx - chunk.maxX);
      const dz = Math.max(chunk.minZ - cz, 0, cz - chunk.maxZ);
      if (dx * dx + dz * dz > cutoff * cutoff) continue;
      gl.bindVertexArray(chunk.gpu.vao);
      gl.drawElements(gl.TRIANGLES, chunk.gpu.indexCount, gl.UNSIGNED_INT, 0);
    }

    // --- Dynamic meshes, opaque then transparent -------------------------
    const opaque: Mesh[] = [];
    const blended: Mesh[] = [];
    for (const mesh of this.meshes) {
      if (this.batched.has(mesh) || !mesh.isEnabled()) continue;
      (mesh.alpha < 1 ? blended : opaque).push(mesh);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    for (const mesh of opaque) this.drawMesh(mesh);

    // Transparent last, back to front, without writing depth so they layer correctly.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const cam = this.camera.position;
    blended.sort((a, b) => {
      const am = a.worldMatrix();
      const bm = b.worldMatrix();
      const ad = (am[12] - cam.x) ** 2 + (am[13] - cam.y) ** 2 + (am[14] - cam.z) ** 2;
      const bd = (bm[12] - cam.x) ** 2 + (bm[13] - cam.y) ** 2 + (bm[14] - cam.z) ** 2;
      return bd - ad;
    });
    for (const mesh of blended) this.drawMesh(mesh);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private drawMesh(mesh: Mesh): void {
    const gl = this.gl;
    const geo = this.gpuFor(mesh.shape);
    const u = this.uniforms;
    gl.uniformMatrix4fv(u.uModel, false, mesh.worldMatrix());
    gl.uniform4f(
      u.uTint,
      mesh.color[0] * mesh.tint[0],
      mesh.color[1] * mesh.tint[1],
      mesh.color[2] * mesh.tint[2],
      mesh.emissive + mesh.tint[3],
    );
    gl.uniform1f(u.uAlpha, mesh.alpha);
    gl.bindVertexArray(geo.vao);
    gl.drawElements(gl.TRIANGLES, geo.indexCount, geo.indexType, 0);
  }
}
