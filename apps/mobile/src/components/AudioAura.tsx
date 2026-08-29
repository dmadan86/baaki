/**
 * The listening aura — an undulating energy field that replaces the old SVG voice
 * wave while the mic is open. It is a GPU turbulence shader: 36 layered
 * iterations of a domain-warped SDF, accumulated into a soft glowing field that
 * answers the live voice.
 *
 * The shader is a faithful SkSL port of LiveKit's `AgentAudioVisualizerAura`
 * (originally built for Unicorn Studio, Polyform Non-Resale License), adapted from
 * ShaderToy/WebGL conventions to Skia's `half4 main(vec2)` runtime effect. We have
 * no LiveKit "agent" here — this is a plain speech capture — so instead of agent
 * states (listening / thinking / speaking) the field is driven by one input: the
 * recogniser's live loudness `level` (0…1). Louder voice grows and brightens the
 * field; silence lets it idle. Only mounted while listening, so the frame loop is
 * torn down the moment the mic closes.
 *
 * Needs the native Skia module — mounted only from `VoiceCapture`, which already
 * lives behind the same lazy-native guard the rest of the voice stack uses.
 */

import { useMemo } from 'react';
import { Canvas, Fill, Shader, Skia, useClock } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { Theme } from '@waves/ui';

/** Fixed square drawing box for the field, centred by the status area. */
const AURA = 260;

/**
 * The aura's base colour. Deliberately NOT the brand violet (`#6C4EE3`): the
 * shader's alpha and brightness are luma-driven (`alpha = luma(color) * uMix`),
 * and violet is green-poor, so it renders faint and washed — the opposite of the
 * vivid LiveKit reference. A luma-rich cyan-blue keeps the cool, on-brand cast
 * while giving the field the punch and bright cores that make it read as real
 * energy. The `colorShift` uniform then sweeps the hue across iterations for
 * variety. Overridable via the `color` prop.
 */
const AURA_COLOR = '#1FD5F9';

/** Fallback triplet if a passed colour cannot be parsed — the aura cyan itself. */
const DEFAULT_RGB: readonly [number, number, number] = [0x1f / 255, 0xd5 / 255, 0xf9 / 255];

/** `#rrggbb` → linear 0…1 triplet for the `uColor` uniform. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
  if (!m) return [...DEFAULT_RGB];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * The turbulence field. Ported near-verbatim from the GLSL original; the only
 * structural change is the ShaderToy `mainImage(out vec4, in vec2)` entry becoming
 * Skia's `half4 main(vec2)`. Every uniform the JS wrapper set is preserved so the
 * look matches the reference.
 */
const source = Skia.RuntimeEffect.Make(`
uniform float2 iResolution;
uniform float  iTime;
uniform float  uSpeed;
uniform float  uBlur;
uniform float  uScale;
uniform float  uShape;
uniform float  uFrequency;
uniform float  uAmplitude;
uniform float  uBloom;
uniform float  uMix;
uniform float  uSpacing;
uniform float  uColorShift;
uniform float  uVariance;
uniform float  uSmoothing;
uniform float  uMode;
uniform float3 uColor;

const float TAU = 6.283185;
const float ITERATIONS = 36.0;

vec2 randFibo(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.xx + p.yx) * p.xy);
}

vec3 Tonemap(vec3 x) {
  x *= 4.0;
  return x / (1.0 + x);
}

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float sdCircle(vec2 st, float r) {
  return length(st) - r;
}

float sdLine(vec2 p, float r) {
  float halfLen = r * 2.0;
  vec2 a = vec2(-halfLen, 0.0);
  vec2 b = vec2(halfLen, 0.0);
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float getSdf(vec2 st) {
  if (uShape == 1.0) return sdCircle(st, uScale);
  else if (uShape == 2.0) return sdLine(st, uScale);
  return sdCircle(st, uScale);
}

vec2 turb(vec2 pos, float t, float it) {
  mat2 rotation = mat2(0.6, -0.25, 0.25, 0.9);
  mat2 layerRotation = mat2(0.6, -0.8, 0.8, 0.6);

  float frequency = mix(2.0, 15.0, uFrequency);
  float amplitude = uAmplitude;
  float frequencyGrowth = 1.4;
  float animTime = t * 0.1 * uSpeed;

  const int LAYERS = 4;
  for (int i = 0; i < LAYERS; i++) {
    vec2 rotatedPos = pos * rotation;
    vec2 wave = sin(frequency * rotatedPos + float(i) * animTime + it);
    pos += (amplitude / frequency) * rotation[0] * wave;
    rotation *= layerRotation;
    amplitude *= mix(1.0, max(wave.x, wave.y), uVariance);
    frequency *= frequencyGrowth;
  }

  return pos;
}

half4 main(vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  vec3 pp = vec3(0.0);
  vec3 bloom = vec3(0.0);
  float t = iTime * 0.5;
  // Zoom the domain out a touch so the whole structure sits inside the canvas with
  // a margin, instead of its lobes reaching the border and hard-cropping.
  vec2 pos = (uv - 0.5) * 1.18;

  // Radial falloff to transparency, so the field melts into the background with no
  // visible square box or clipped edge. 1 in the centre, 0 by the border (corners,
  // at radius ~0.707, are fully clear).
  float edge = 1.0 - smoothstep(0.30, 0.52, length(uv - 0.5));

  vec2 prevPos = turb(pos, t, 0.0 - 1.0 / ITERATIONS);
  float spacing = mix(1.0, TAU, uSpacing);

  for (float i = 1.0; i < ITERATIONS + 1.0; i++) {
    float iter = i / ITERATIONS;
    vec2 st = turb(pos, t, iter * spacing);
    float d = abs(getSdf(st));
    float pd = distance(st, prevPos);
    prevPos = st;
    float dynamicBlur = exp2(pd * 2.0 * 1.4426950408889634) - 1.0;
    float ds = smoothstep(0.0, uBlur * 0.05 + max(dynamicBlur * uSmoothing, 0.001), d);

    vec3 color = uColor;
    if (uColorShift > 0.01) {
      vec3 hsv = rgb2hsv(color);
      hsv.x = fract(hsv.x + (1.0 - iter) * uColorShift * 0.3);
      color = hsv2rgb(hsv);
    }

    float invd = 1.0 / max(d + dynamicBlur, 0.001);
    pp += (ds - 1.0) * color;
    bloom += clamp(invd, 0.0, 250.0) * color;
  }

  pp *= 1.0 / ITERATIONS;

  vec3 color;

  if (uMode < 0.5) {
    bloom = bloom / (bloom + 2e4);
    color = (-pp + bloom * 3.0 * uBloom) * 1.2;
    color += (randFibo(fragCoord).x - 0.5) / 255.0;
    color = Tonemap(color);
    float alpha = luma(color) * uMix;
    return half4(color * uMix * edge, alpha * edge);
  } else {
    color = -pp;
    color += (randFibo(fragCoord).x - 0.5) / 255.0;

    float brightness = length(color);
    vec3 direction = brightness > 0.0 ? color / brightness : color;

    float factor = 2.0;
    float mappedBrightness = (brightness * factor) / (1.0 + brightness * factor);
    color = direction * mappedBrightness;

    float gray = dot(color, vec3(0.2, 0.5, 0.1));
    float saturationBoost = 3.0;
    color = mix(vec3(gray), color, saturationBoost);

    color = clamp(color, 0.0, 1.0);

    float alpha = mappedBrightness * clamp(uMix, 1.0, 2.0);
    return half4(color, alpha * edge);
  }
}`);

export interface AudioAuraProps {
  /** Only render while the mic is open. */
  active: boolean;
  /** Live input loudness, 0…1, eased from the recogniser's volume events. */
  level: SharedValue<number>;
  theme: Theme;
  /**
   * Base `#rrggbb` colour of the field. Defaults to the luma-rich aura cyan rather
   * than the brand violet — see `AURA_COLOR`.
   */
  color?: string;
}

/**
 * The live energy field under the status while listening. One shared clock and the
 * live `level` drive every uniform on the UI thread; the shader compiles once at
 * module load. The whole thing collapses to nothing if the device's Skia build is
 * missing the runtime-effect (an old GPU) — `source` is null and we render blank
 * rather than crash.
 */
export function AudioAura({ active, level, theme, color = AURA_COLOR }: AudioAuraProps) {
  const clock = useClock();
  const rgb = useMemo(() => hexToRgb(color), [color]);
  const mode = theme.scheme === 'dark' ? 0.0 : 1.0;

  const uniforms = useDerivedValue(() => {
    const l = level.value;
    const time = clock.value / 1000;
    // Autonomous life, so the field breathes even in silence rather than sitting
    // dead. The reference pulsed brightness on a mirror loop from its agent state;
    // we have only a mic level, so a slow sine keeps it alive and loudness stacks
    // on top. Two rates — a slow swell and a faster shimmer — so the motion never
    // reads as one mechanical throb.
    const breath = 0.5 + 0.5 * Math.sin(time * 2.3);
    const shimmer = 0.5 + 0.5 * Math.sin(time * 5.2 + 1.3);
    return {
      iResolution: [AURA, AURA],
      iTime: time,
      // Quiet mic still drifts and shimmers; a loud voice speeds, grows and
      // brightens the field. Ranges widened well past the first cut so the aura
      // visibly answers the voice instead of barely moving.
      uSpeed: 30 + 55 * l + 6 * shimmer,
      uBlur: 0.2,
      uScale: 0.2 + 0.2 * l + 0.04 * breath,
      uShape: 1.0,
      uFrequency: 0.7 + 0.6 * l,
      uAmplitude: 0.95,
      // A touch of bloom the reference left off — here it earns the extra glow that
      // reads as energy rather than a flat ribbon. Dark mode only (light ignores it).
      uBloom: 0.18,
      // Brightness is the main "alive" signal: a bright floor, a strong voice push,
      // and the breathing swell layered in. Peaks around 2.9, near the reference's
      // speaking/thinking pulse.
      uMix: 1.5 + 0.9 * l + 0.55 * breath,
      uSpacing: 0.5,
      uColorShift: 0.35,
      uVariance: 0.12,
      uSmoothing: 1.0,
      uMode: mode,
      uColor: rgb,
    };
  });

  if (!active || !source) return null;

  return (
    <Canvas style={{ width: AURA, height: AURA }}>
      <Fill>
        <Shader source={source} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}
