/**
 * A small WebGL2 renderer built for exactly this game.
 *
 * It replaced Babylon.js, which was 1.5 MB of the 1.55 MB shareable build and
 * stopped that build from running at all. It began as a single forward pass of
 * flat-shaded primitives; the visual overhaul grew it into a four-pass
 * pipeline - sun shadow map, sky, scene, post - while keeping the property
 * that made it viable in the first place: the world is baked into a handful of
 * chunk buffers, so a frame is still only a few dozen draw calls.
 *
 * The passes, in order:
 *   1. SHADOW - the near field into a depth texture, from the sun.
 *   2. SKY    - a procedural evening behind everything.
 *   3. SCENE  - chunks and meshes, lit by sun + hemisphere + point lights,
 *               shadowed, specular where the material asks for it. Rendered
 *               into a multisampled offscreen target.
 *   4. POST   - resolve, tonemap, grade, vignette, dither to the canvas.
 */

import { compose, lookAt, lookAtUp, mat4, multiply, ortho, perspective, Vec3, type Mat4 } from "./math3d";
import {
  boxGeometry,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
  torusGeometry,
  type Geometry,
} from "./primitives";
import {
  DEPTH_FRAG,
  DEPTH_VERT,
  MAX_LIGHTS,
  POST_FRAG,
  POST_VERT,
  SCENE_FRAG,
  SCENE_VERT,
  SKY_FRAG,
  SKY_VERT,
} from "./shaders";

export type Shape =
  | { kind: "box"; width: number; height: number; depth: number }
  | {
      /**
       * Arbitrary pre-built triangle geometry, in the mesh's local space.
       *
       * Exists for the ground and, since the overhaul, the cars: a curved
       * course cannot be tiled out of boxes, and neither can a car body that
       * is more than a box. Custom geometry supplies its own normals - flat
       * for faceted work, smoothed where a surface should read as continuous.
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
  /**
   * Specular strength 0..1. Zero is matte tarmac; car paint sits around 0.5,
   * glass close to 1. This is what separates the materials under one sun.
   */
  specular?: number;
  /** Specular exponent. Higher is tighter: 16 is satin, 64 is polished. */
  gloss?: number;
  /**
   * Excluded from the shadow pass. For things that fake light rather than
   * receive it: contact-shadow quads, flasher glow sprites, boost flames.
   */
  noShadow?: boolean;
}

export class Mesh extends Node3D {
  color: [number, number, number];
  emissive: number;
  alpha: number;
  specular: number;
  gloss: number;
  noShadow: boolean;
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
    this.specular = opts.specular ?? 0;
    this.gloss = opts.gloss ?? 24;
    this.noShadow = opts.noShadow ?? false;
    this.isStatic = opts.isStatic ?? false;
    renderer.register(this);
  }

  dispose(): void {
    this.renderer.remove(this);
  }
}

/** A point light for one frame. Pushed by the game, consumed and cleared by render(). */
export interface PointLight {
  x: number;
  y: number;
  z: number;
  /** World units at which the light's contribution reaches zero. */
  radius: number;
  r: number;
  g: number;
  b: number;
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
    /** Radians of lean about the view axis. A speed cue, used in whispers. */
    roll: 0,
  };

  /** Scene-wide lighting and atmosphere, set once by the game. */
  lightDir: [number, number, number] = [-0.52, -0.58, 0.34];
  /** What the sun contributes at full lambert. */
  sunColor: [number, number, number] = [1.12, 0.92, 0.7];
  sky: [number, number, number] = [0.4, 0.42, 0.55];
  ground: [number, number, number] = [0.3, 0.26, 0.28];
  fogColor: [number, number, number] = [0.3, 0.28, 0.38];
  fogRange: [number, number] = [190, 620];
  clearColor: [number, number, number] = [0.03, 0.04, 0.07];
  /** The procedural evening: straight up, at the horizon sunward, and away. */
  zenith: [number, number, number] = [0.06, 0.09, 0.2];
  horizon: [number, number, number] = [0.95, 0.5, 0.28];
  horizonAway: [number, number, number] = [0.28, 0.28, 0.42];
  exposure = 1.0;
  /** Point lights for this frame. Push during update; render() consumes and clears. */
  readonly lights: PointLight[] = [];
  /** Side length of the shadow map. Halve it on weak devices. */
  shadowSize = 2048;
  /** World radius the shadow map covers around the action. */
  shadowRadius = 78;

  private scene: WebGLProgram;
  private depth: WebGLProgram;
  private skyProg: WebGLProgram;
  private post: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private ud: Record<string, WebGLUniformLocation | null> = {};
  private us: Record<string, WebGLUniformLocation | null> = {};
  private up: Record<string, WebGLUniformLocation | null> = {};
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
  private lightView = mat4();
  private lightProj = mat4();
  private lightVP = mat4();
  private identity = mat4();
  private lastTime = 0;
  private fps = 60;

  // Offscreen plumbing, rebuilt on resize.
  private msaaFbo: WebGLFramebuffer | null = null;
  private msaaColor: WebGLRenderbuffer | null = null;
  private msaaDepth: WebGLRenderbuffer | null = null;
  private resolveFbo: WebGLFramebuffer | null = null;
  private resolveTex: WebGLTexture | null = null;
  private fboWidth = 0;
  private fboHeight = 0;
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private shadowAllocated = 0;
  private fullscreenVao: WebGLVertexArrayObject;
  private fullscreenBuf: WebGLBuffer;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // Lets the canvas be read back (screenshots, share cards); negligible cost.
      preserveDrawingBuffer: true,
      // The scene renders into our own multisampled target; the default
      // framebuffer only ever receives the post pass's fullscreen quad.
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    this.scene = this.link(SCENE_VERT, SCENE_FRAG);
    this.depth = this.link(DEPTH_VERT, DEPTH_FRAG);
    this.skyProg = this.link(SKY_VERT, SKY_FRAG, "aCorner");
    this.post = this.link(POST_VERT, POST_FRAG, "aCorner");

    const grab = (prog: WebGLProgram, names: string[], into: Record<string, WebGLUniformLocation | null>) => {
      for (const name of names) into[name] = gl.getUniformLocation(prog, name);
    };
    grab(this.scene, [
      "uViewProj", "uModel", "uLightVP", "uCamPos", "uLightDir", "uSunColor", "uSky", "uGround",
      "uFogColor", "uFogRange", "uTint", "uAlpha", "uSpec",
      "uShadowMap", "uShadowParams", "uShadowCentre", "uLightCount", "uLightPos", "uLightColor",
    ], this.u);
    grab(this.depth, ["uLightVP", "uModel"], this.ud);
    grab(this.skyProg, ["uCamRight", "uCamUp", "uCamFwd", "uHalfTan", "uLightDir", "uZenith", "uHorizon", "uHorizonAway", "uSunColor"], this.us);
    grab(this.post, ["uScene", "uExposure"], this.up);

    // One triangle that covers the screen, shared by the sky and post passes.
    this.fullscreenBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.fullscreenVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fullscreenVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // The shadow map: a depth texture with hardware compare, so one sample
    // returns a filtered lit/shadowed answer rather than a raw depth.
    this.shadowTex = gl.createTexture()!;
    this.shadowFbo = gl.createFramebuffer()!;
    this.allocShadow();

    gl.enable(gl.DEPTH_TEST);
    // Everything is drawn double-sided: the ground planes and the fake contact shadows
    // are single quads that must be visible from either side, and nothing here is heavy
    // enough for backface culling to be worth the risk of invisible geometry.
    gl.disable(gl.CULL_FACE);
    this.resize();
  }

  private allocShadow(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowAllocated = this.shadowSize;
  }

  private allocSceneTargets(w: number, h: number): void {
    const gl = this.gl;
    if (this.msaaFbo) {
      gl.deleteFramebuffer(this.msaaFbo);
      gl.deleteRenderbuffer(this.msaaColor!);
      gl.deleteRenderbuffer(this.msaaDepth!);
      gl.deleteFramebuffer(this.resolveFbo!);
      gl.deleteTexture(this.resolveTex!);
    }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);

    this.msaaColor = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    this.msaaDepth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
    this.msaaFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msaaColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msaaDepth);

    this.resolveTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.resolveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.resolveFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.resolveTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.fboWidth = w;
    this.fboHeight = h;
  }

  private link(vertSrc: string, fragSrc: string, corner?: string): WebGLProgram {
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
    if (corner) {
      gl.bindAttribLocation(prog, 0, corner);
    } else {
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.bindAttribLocation(prog, 1, "aNormal");
      gl.bindAttribLocation(prog, 2, "aColor");
    }
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
    if (this.fboWidth !== w || this.fboHeight !== h) this.allocSceneTargets(w, h);
    if (this.shadowAllocated !== this.shadowSize) this.allocShadow();
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

    // --- Matrices --------------------------------------------------------
    perspective(this.proj, this.camera.fov, this.canvas.width / this.canvas.height, this.camera.near, this.camera.far);
    if (this.camera.roll !== 0) {
      // Rotate the up vector about the view axis: roll without a matrix inverse.
      const e = this.camera.position;
      const t = this.camera.target;
      let fx = t.x - e.x, fy = t.y - e.y, fz = t.z - e.z;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const cr = Math.cos(this.camera.roll);
      const sr = Math.sin(this.camera.roll);
      // Rodrigues on (0,1,0) about f.
      const ux = sr * (fy * 0 - fz * 1) + fx * fy * (1 - cr);
      const uy = cr + fy * fy * (1 - cr);
      const uz = sr * (fx * 1 - fy * 0) + fz * fy * (1 - cr);
      lookAtUp(this.view, e, t, ux, uy, uz);
    } else {
      lookAt(this.view, this.camera.position, this.camera.target);
    }
    multiply(this.viewProj, this.proj, this.view);

    const ldl = Math.hypot(this.lightDir[0], this.lightDir[1], this.lightDir[2]) || 1;
    const lx = this.lightDir[0] / ldl, ly = this.lightDir[1] / ldl, lz = this.lightDir[2] / ldl;

    // --- Shadow matrix, texel-snapped so edges do not crawl ---------------
    const R = this.shadowRadius;
    let cx = this.camera.target.x + (this.camera.target.x - this.camera.position.x) * 0.6;
    let cz = this.camera.target.z + (this.camera.target.z - this.camera.position.z) * 0.6;
    const cy = this.camera.target.y;
    {
      // Build the light basis once, snap the centre onto its texel grid.
      const eye = new Vec3(cx - lx * 150, cy - ly * 150, cz - lz * 150);
      lookAt(this.lightView, eye, new Vec3(cx, cy, cz));
      const v = this.lightView;
      const step = (2 * R) / this.shadowSize;
      // Light-space x/y of the centre, snapped.
      const sx = Math.round((v[0] * cx + v[4] * cy + v[8] * cz + v[12]) / step) * step;
      const sy = Math.round((v[1] * cx + v[5] * cy + v[9] * cz + v[13]) / step) * step;
      const ox = sx - (v[0] * cx + v[4] * cy + v[8] * cz + v[12]);
      const oy = sy - (v[1] * cx + v[5] * cy + v[9] * cz + v[13]);
      // Move the centre by the snap delta expressed back in world space.
      cx += v[0] * ox + v[1] * oy;
      cz += v[8] * ox + v[9] * oy;
      const eye2 = new Vec3(cx - lx * 150, cy - ly * 150, cz - lz * 150);
      lookAt(this.lightView, eye2, new Vec3(cx, cy, cz));
    }
    ortho(this.lightProj, R, R, 10, 320);
    multiply(this.lightVP, this.lightProj, this.lightView);

    // --- Pass 1: shadow depth --------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.depth);
    gl.uniformMatrix4fv(this.ud.uLightVP, false, this.lightVP);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 6);

    gl.uniformMatrix4fv(this.ud.uModel, false, this.identity);
    for (const chunk of this.chunks.values()) {
      if (chunk.minX > cx + R || chunk.maxX < cx - R || chunk.minZ > cz + R || chunk.maxZ < cz - R) continue;
      gl.bindVertexArray(chunk.gpu.vao);
      gl.drawElements(gl.TRIANGLES, chunk.gpu.indexCount, gl.UNSIGNED_INT, 0);
    }
    for (const mesh of this.meshes) {
      if (this.batched.has(mesh) || !mesh.isEnabled() || mesh.noShadow || mesh.alpha < 1) continue;
      const m = mesh.worldMatrix();
      const dxs = m[12] - cx;
      const dzs = m[14] - cz;
      if (dxs * dxs + dzs * dzs > (R + 30) * (R + 30)) continue;
      const geo = this.gpuFor(mesh.shape);
      gl.uniformMatrix4fv(this.ud.uModel, false, m);
      gl.bindVertexArray(geo.vao);
      gl.drawElements(gl.TRIANGLES, geo.indexCount, geo.indexType, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // --- Pass 2 + 3: sky, then the scene, into the multisampled target ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.viewport(0, 0, this.fboWidth, this.fboHeight);
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.skyProg);
    gl.depthMask(false);
    const v = this.view;
    const tanY = Math.tan(this.camera.fov / 2);
    const tanX = tanY * (this.canvas.width / this.canvas.height);
    gl.uniform3f(this.us.uCamRight, v[0], v[4], v[8]);
    gl.uniform3f(this.us.uCamUp, v[1], v[5], v[9]);
    gl.uniform3f(this.us.uCamFwd, v[2], v[6], v[10]);
    gl.uniform2f(this.us.uHalfTan, tanX, tanY);
    gl.uniform3f(this.us.uLightDir, lx, ly, lz);
    gl.uniform3fv(this.us.uZenith, this.zenith);
    gl.uniform3fv(this.us.uHorizon, this.horizon);
    gl.uniform3fv(this.us.uHorizonAway, this.horizonAway);
    gl.uniform3fv(this.us.uSunColor, this.sunColor);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    gl.useProgram(this.scene);
    const u = this.u;
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
    gl.uniform3f(u.uCamPos, this.camera.position.x, this.camera.position.y, this.camera.position.z);
    gl.uniform3f(u.uLightDir, lx, ly, lz);
    gl.uniform3fv(u.uSunColor, this.sunColor);
    gl.uniform3fv(u.uSky, this.sky);
    gl.uniform3fv(u.uGround, this.ground);
    gl.uniform3fv(u.uFogColor, this.fogColor);
    gl.uniform2fv(u.uFogRange, this.fogRange);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(u.uShadowMap, 0);
    gl.uniform3f(u.uShadowParams, 1 / this.shadowSize, R * 0.8, R * 0.98);
    gl.uniform3f(u.uShadowCentre, cx, 0, cz);

    // The nearest lights win the slots; a chase can easily offer more than fit.
    const lightList = this.lights;
    if (lightList.length > MAX_LIGHTS) {
      const px = this.camera.position.x;
      const pz = this.camera.position.z;
      lightList.sort((a, b) =>
        ((a.x - px) ** 2 + (a.z - pz) ** 2) - ((b.x - px) ** 2 + (b.z - pz) ** 2));
    }
    const count = Math.min(MAX_LIGHTS, lightList.length);
    const posArr = new Float32Array(MAX_LIGHTS * 4);
    const colArr = new Float32Array(MAX_LIGHTS * 3);
    for (let i = 0; i < count; i++) {
      const l = lightList[i];
      posArr[i * 4] = l.x;
      posArr[i * 4 + 1] = l.y;
      posArr[i * 4 + 2] = l.z;
      posArr[i * 4 + 3] = 1 / Math.max(1e-3, l.radius);
      colArr[i * 3] = l.r;
      colArr[i * 3 + 1] = l.g;
      colArr[i * 3 + 2] = l.b;
    }
    gl.uniform1i(u.uLightCount, count);
    gl.uniform4fv(u.uLightPos, posArr);
    gl.uniform3fv(u.uLightColor, colArr);

    /*
     * Static world: one call per chunk, and only the chunks worth drawing.
     *
     * Fog closes long before the far plane, so a chunk whose nearest corner is
     * already past the fog's end contributes nothing but vertex work.
     */
    gl.uniformMatrix4fv(u.uModel, false, this.identity);
    gl.uniform4f(u.uTint, 1, 1, 1, 0);
    gl.uniform1f(u.uAlpha, 1);
    gl.uniform2f(u.uSpec, 0, 24);
    const camX = this.camera.position.x;
    const camZ = this.camera.position.z;
    const cutoff = this.fogRange[1] + CHUNK_FOG_SLACK;
    for (const chunk of this.chunks.values()) {
      const dx = Math.max(chunk.minX - camX, 0, camX - chunk.maxX);
      const dz = Math.max(chunk.minZ - camZ, 0, camZ - chunk.maxZ);
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

    // --- Pass 4: resolve and post ----------------------------------------
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
    gl.blitFramebuffer(0, 0, this.fboWidth, this.fboHeight, 0, 0, this.fboWidth, this.fboHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.post);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveTex);
    gl.uniform1i(this.up.uScene, 0);
    gl.uniform1f(this.up.uExposure, this.exposure);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);

    this.lights.length = 0;
  }

  private drawMesh(mesh: Mesh): void {
    const gl = this.gl;
    const geo = this.gpuFor(mesh.shape);
    const u = this.u;
    gl.uniformMatrix4fv(u.uModel, false, mesh.worldMatrix());
    gl.uniform4f(
      u.uTint,
      mesh.color[0] * mesh.tint[0],
      mesh.color[1] * mesh.tint[1],
      mesh.color[2] * mesh.tint[2],
      mesh.emissive + mesh.tint[3],
    );
    gl.uniform1f(u.uAlpha, mesh.alpha);
    gl.uniform2f(u.uSpec, mesh.specular, mesh.gloss);
    gl.bindVertexArray(geo.vao);
    gl.drawElements(gl.TRIANGLES, geo.indexCount, geo.indexType, 0);
  }
}
