// CPU-side model for the Lightleak op (lightleak.wgsl). Pure + unit-tested:
// the GPU shader computes the leak per-pixel, this file is the same math so
// the direction logic (which way amount/hue/fade move the image) is verifiable
// without a browser.
//
// Analog film light leak: light that reached the film during load/rewind,
// ADDING a band of color along one frame edge -- strongest at the edge, fading
// inward. Light leaks are extra exposure, so the effect adds to LINEAR RGB
// (not the luma-ratio of grain). Per-photo seed picks the edge AND the pattern
// set in Auto; `pattern` picks a set directly; `hue` blends the set's three
// vendored leak textures' weights (warm/mid/cool); `fade` scales a distance
// envelope on top of the textures' own falloff.
//
// ponytail: the shader samples six vendored textures (public/leaks/*.png)
// which the CPU can't -- this mirror models their density with a fixed
// envelope + representative colors, enough to unit-test the op's directions.
// The pixels themselves are the render+scan harness's proof.

import { seedU32 } from './grain';

export interface LightleakParams {
  amount: number; // 0..100, 0 off
  hue: number; // 0..100, 0 warm (orange) .. 100 cool (cyan)
  fade: number; // 0..100, 0 = texture falloff, 100 = hard stop by LEAK_WIDTH
  pattern: number; // -1 auto (seed picks the set), 0 Set A, 1 Set B
}

export const LIGHTLEAK_DEFAULTS: LightleakParams = { amount: 0, hue: 0, fade: 0, pattern: -1 };

// Only `amount` matters -- at 0 the leak adds exactly zero light, so a pass is
// only worth emitting when it's non-zero (same rule as presence/grain).
export function isNeutralLightleak(p: LightleakParams): boolean {
  return p.amount === 0;
}

// Layout must match the `Lightleak` struct in lightleak.wgsl (8 f32s):
// amount, hue, fade, seed, patternMode (0 auto / 1 fixed), patternSel (0/1).
export function packLightleak(p: LightleakParams, seed: number): Float32Array {
  const mode = p.pattern === -1 ? 0 : 1;
  const sel = p.pattern === 1 ? 1 : 0;
  return new Float32Array([p.amount, p.hue, p.fade, seed, mode, sel, 0, 0]);
}

// How far the `fade` envelope reaches into the frame (fraction, from the leak
// edge). Kept in sync with lightleak.wgsl.
export const LEAK_WIDTH = 0.35;

// Distance from the leak edge across the frame: 0 on the edge, 1 at the far
// side. edge 0=top, 1=right, 2=bottom, 3=left (seedU % 4).
export function edgeDistance(edge: number, nx: number, ny: number): number {
  switch (edge) {
    case 0: return ny;
    case 1: return 1 - nx;
    case 2: return 1 - ny;
    default: return nx;
  }
}

// Hue -> per-texture blend weights (triangular, sums to 1). hue 0 -> tex0
// (warm), 50 -> tex1 (mid), 100 -> tex2 (cool). Mirror of the shader.
export function leakWeights(hue: number): [number, number, number] {
  const h = clamp01(hue / 100) * 2; // 0..2
  const w0 = clamp01(1 - h);
  const w1 = Math.max(0, 1 - Math.abs(h - 1));
  const w2 = clamp01(h - 1);
  const s = w0 + w1 + w2;
  return [w0 / s, w1 / s, w2 / s];
}

// The `fade` distance envelope: 1 everywhere at fade 0, -> 1 - smoothstep to 0
// by LEAK_WIDTH at fade 100.
export function leakFade(fade: number, d: number): number {
  const f = clamp01(fade / 100);
  return mix01(1, 1 - smoothstep01(d / LEAK_WIDTH), f);
}

// Representative linear colors of the three vendored leak textures (the
// hue-blend anchors; tex0 warm, tex1 mid amber, tex2 cool -- matches the
// generated assets' base colors).
const WARM: [number, number, number] = [1.0, 0.52, 0.22];
const MID: [number, number, number] = [0.92, 0.68, 0.44];
const COOL: [number, number, number] = [0.2, 0.58, 1.0];

export function leakColor(hue: number): [number, number, number] {
  const [w0, w1, w2] = leakWeights(hue);
  return [
    WARM[0] * w0 + MID[0] * w1 + COOL[0] * w2,
    WARM[1] * w0 + MID[1] * w1 + COOL[1] * w2,
    WARM[2] * w0 + MID[2] * w1 + COOL[2] * w2,
  ];
}

// Model of the generated textures' own density falloff (they reach ~0 by
// ~75% of the texture). The CPU mirror can't sample the GPU textures, so this
// envelope approximates them for the direction tests below.
const TEX_FALLOFF = 0.75;

// The additive linear-RGB light the leak contributes at a normalized pixel
// (nx, ny) in [0,1]^2. `seedU` is the u32 hash key (see grain.seedU32).
export function leakAdd(nx: number, ny: number, p: LightleakParams, seedU: number): [number, number, number] {
  if (p.amount === 0) return [0, 0, 0];
  const edge = seedU % 4;
  const d = edgeDistance(edge, nx, ny);
  const texEnv = 1 - smoothstep01(d / TEX_FALLOFF);
  const gain = clamp01(p.amount / 100) * texEnv * leakFade(p.fade, d);
  const [r, g, b] = leakColor(p.hue);
  return [r * gain, g * gain, b * gain];
}

// The full response for one channel: LINEAR in -> LINEAR out (additive leak).
export function leakResponse(lin: number, channel: number, nx: number, ny: number, p: LightleakParams, seed: number): number {
  const [r, g, b] = leakAdd(nx, ny, p, seedU32(seed));
  const add = [r, g, b][channel];
  return lin + add;
}

function mix01(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
