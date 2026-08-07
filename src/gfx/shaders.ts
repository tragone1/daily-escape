/**
 * Every shader in the game, in one place.
 *
 * The renderer began as a single program: hemisphere ambient, one lambert term,
 * linear fog. That was the right size for a world of flat-shaded boxes; the
 * visual overhaul replaced it with a small pipeline - a sky pass behind
 * everything, a sun shadow map over the near field, a handful of point lights
 * for police flashers and explosions, a specular term so paint and glass read
 * as materials, and a tonemapped post pass - and this file is that pipeline's
 * whole GLSL surface. Each program is still deliberately small: the game draws
 * a few dozen chunks and meshes, so the win is in what the light DOES, not in
 * how many features the shader ships.
 */

/** How many point lights the scene pass accepts per frame. */
export const MAX_LIGHTS = 10;

// ---------------------------------------------------------------------------
// Scene pass
// ---------------------------------------------------------------------------

export const SCENE_VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec4 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat4 uLightVP;
uniform vec3 uCamPos;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorld;
out float vDepth;
out vec4 vShadowPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vDepth = length(uCamPos - world.xyz);
  vShadowPos = uLightVP * world;
  gl_Position = uViewProj * world;
}`;

export const SCENE_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorld;
in float vDepth;
in vec4 vShadowPos;

uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform vec4 uTint;
uniform float uAlpha;
uniform vec3 uCamPos;
/** x: specular strength 0..1, y: gloss exponent. */
uniform vec2 uSpec;

uniform highp sampler2DShadow uShadowMap;
/** x: 1/shadow texel, y: fade start (world units from centre), z: fade end. */
uniform vec3 uShadowParams;
uniform vec3 uShadowCentre;

uniform int uLightCount;
/** xyz: position, w: 1/radius. */
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightColor[${MAX_LIGHTS}];

out vec4 fragColor;

float sunShadow() {
  vec3 sc = vShadowPos.xyz / vShadowPos.w;
  // Outside the map entirely: lit. The map follows the camera, so this is the far field.
  if (abs(sc.x) > 0.99 || abs(sc.y) > 0.99) return 1.0;
  vec3 uvz = vec3(sc.xy * 0.5 + 0.5, sc.z * 0.5 + 0.5 - 0.0016);
  float texel = uShadowParams.x;
  // Four rotated taps: soft enough for the art style at a quarter of the 3x3 cost.
  float s = texture(uShadowMap, uvz + vec3( 0.6 * texel,  0.2 * texel, 0.0))
          + texture(uShadowMap, uvz + vec3(-0.2 * texel,  0.6 * texel, 0.0))
          + texture(uShadowMap, uvz + vec3(-0.6 * texel, -0.2 * texel, 0.0))
          + texture(uShadowMap, uvz + vec3( 0.2 * texel, -0.6 * texel, 0.0));
  s *= 0.25;
  // Ease back to fully lit at the map's edge so the boundary never draws a line.
  float d = distance(vWorld.xz, uShadowCentre.xz);
  float fade = smoothstep(uShadowParams.y, uShadowParams.z, d);
  return mix(s, 1.0, fade);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCamPos - vWorld);
  // Double-sided lighting: ground quads and shadow planes face either way.
  if (dot(n, view) < 0.0) n = -n;

  float lambert = max(dot(n, -uLightDir), 0.0);
  float shadow = lambert > 0.001 ? sunShadow() : 1.0;

  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5);
  vec3 base = vColor.rgb * uTint.rgb;

  // Point lights: wrapped diffuse so the spill pools on the road around the source.
  vec3 pointLit = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 toL = uLightPos[i].xyz - vWorld;
    float dist = length(toL);
    float att = clamp(1.0 - dist * uLightPos[i].w, 0.0, 1.0);
    if (att <= 0.0) continue;
    float nl = clamp(dot(n, toL / max(dist, 0.001)) * 0.6 + 0.4, 0.0, 1.0);
    pointLit += uLightColor[i] * (att * att * nl);
  }

  vec3 lit = base * (ambient + uSunColor * (lambert * shadow) + pointLit)
           + base * (vColor.a + uTint.a);

  // Specular: sun highlight plus a sky-coloured fresnel rim. Zero for the world;
  // the cars and glass carry it, which is what separates paint from tarmac.
  if (uSpec.x > 0.001) {
    vec3 h = normalize(view - uLightDir);
    float spec = pow(max(dot(n, h), 0.0), uSpec.y) * uSpec.x * shadow;
    float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0) * uSpec.x;
    lit += uSunColor * spec + uSky * fres * 0.6 + pointLit * spec * 2.0;
  }

  float fog = clamp((vDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  fragColor = vec4(mix(lit, uFogColor, fog), uAlpha);
}`;

// ---------------------------------------------------------------------------
// Shadow pass: depth only
// ---------------------------------------------------------------------------

export const DEPTH_VERT = `#version 300 es
in vec3 aPos;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main() {
  gl_Position = uLightVP * uModel * vec4(aPos, 1.0);
}`;

export const DEPTH_FRAG = `#version 300 es
precision mediump float;
void main() {}`;

// ---------------------------------------------------------------------------
// Sky pass: a gradient atmosphere with a low sun, drawn behind everything
// ---------------------------------------------------------------------------

export const SKY_VERT = `#version 300 es
in vec2 aCorner;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uHalfTan; // x: tan(fov/2)*aspect, y: tan(fov/2)
out vec3 vRay;
void main() {
  vRay = uCamFwd + aCorner.x * uHalfTan.x * uCamRight + aCorner.y * uHalfTan.y * uCamUp;
  gl_Position = vec4(aCorner, 0.9999, 1.0);
}`;

export const SKY_FRAG = `#version 300 es
precision mediump float;
in vec3 vRay;
uniform vec3 uLightDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHorizonAway;
uniform vec3 uSunColor;
out vec4 fragColor;
void main() {
  vec3 dir = normalize(vRay);
  float up = clamp(dir.y, -0.12, 1.0);

  // The horizon is warm toward the sun and cool away from it: the one cue that
  // makes a gradient read as an evening rather than as a texture.
  vec2 sunAz = normalize(-uLightDir.xz);
  vec2 dirAz = normalize(dir.xz + vec2(1e-5, 0.0));
  float toward = dot(sunAz, dirAz) * 0.5 + 0.5;
  vec3 horizon = mix(uHorizonAway, uHorizon, toward * toward);

  float h = pow(1.0 - clamp(up, 0.0, 1.0), 3.0);
  vec3 sky = mix(uZenith, horizon, h);

  // Sun: a small disc, a tight glow and a wide soft halo.
  float s = max(dot(dir, -uLightDir), 0.0);
  sky += uSunColor * (smoothstep(0.9996, 0.9999, s) * 1.6);
  sky += uSunColor * (pow(s, 220.0) * 0.5);
  sky += uSunColor * (pow(s, 12.0) * 0.14);

  // Below the horizon line, settle to the ground haze rather than a hard cut.
  sky = mix(sky, horizon * 0.72, smoothstep(0.0, -0.1, dir.y));

  fragColor = vec4(sky, 1.0);
}`;

// ---------------------------------------------------------------------------
// Post pass: tonemap, grade, vignette, dither
// ---------------------------------------------------------------------------

export const POST_VERT = `#version 300 es
in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

export const POST_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uExposure;
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 c = texture(uScene, vUv).rgb * uExposure;
  c = aces(c);

  // A touch more colour than the tonemap leaves behind.
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, 1.07);

  // Vignette: quiet at the centre of the action, darker in the corners.
  vec2 v = vUv - 0.5;
  c *= 1.0 - dot(v, v) * 0.55;

  // Dither, or the sky gradient bands on every 8-bit screen.
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (noise - 0.5) * (1.5 / 255.0);

  fragColor = vec4(c, 1.0);
}`;
