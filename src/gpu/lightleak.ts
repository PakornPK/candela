// CPU-side model for the Lightleak op (lightleak.wgsl). Pure + unit-tested:
// the GPU shader computes the leak per-pixel, this file is the same math so
// the direction logic (which way amount/hue move the image) is verifiable
// without a browser.
//
// Analog film light leak: light that reached the film during load/rewind,
// ADDING a band of color along one frame edge -- strongest at the edge, fading
// inward with soft streaks. Light leaks are extra exposure, so the effect adds
// to LINEAR RGB (not the luma-ratio of grain). Per-photo seed picks the edge +
// streak pattern; `hue` slides warm (classic orange) to cool (cyan).
//
// ponytail: a smooth banded falloff approximates real leaks (which scatter and
// bloom); no bloom/blur pass -- recalibrate against real leaks if the user
// flags the look. Seed is shared with grain (same film roll character).

import { hash01, seedU32 } from './grain';

export interface LightleakParams {
  amount: number; // 0..100, 0 off
  hue: number; // 0..100, 0 warm (orange) .. 100 cool (cyan)
}

export const LIGHTLEAK_DEFAULTS: LightleakParams = { amount: 0, hue: 0 };

// Only `amount` matters -- at 0 the leak adds exactly zero light, so a pass is
// only worth emitting when it's non-zero (same rule as presence/grain).
export function isNeutralLightleak(p: LightleakParams): boolean {
  return p.amount === 0;
}

// Layout must match the `Lightleak` struct in lightleak.wgsl (3 f32s + 5 pad).
export function packLightleak(p: LightleakParams, seed: number): Float32Array {
  return new Float32Array([p.amount, p.hue, seed, 0, 0, 0, 0, 0]);
}

// How far into the frame the leak reaches (fraction of the frame, from the
// leak edge). Kept in sync with lightleak.wgsl.
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

// The coordinate running ALONG the leak edge (0..1), used to key the streaks.
export function alongEdge(edge: number, nx: number, ny: number): number {
  switch (edge) {
    case 0: return nx;
    case 1: return ny;
    case 2: return 1 - nx;
    default: return 1 - ny;
  }
}

// Leak base colors, warm -> cool, in linear RGB.
const WARM: [number, number, number] = [1.0, 0.55, 0.2];
const COOL: [number, number, number] = [0.1, 0.55, 1.0];

export function leakColor(hue: number): [number, number, number] {
  const t = clamp01(hue / 100);
  return [mix01(WARM[0], COOL[0], t), mix01(WARM[1], COOL[1], t), mix01(WARM[2], COOL[2], t)];
}

// The additive linear-RGB light the leak contributes at a normalized pixel
// (nx, ny) in [0,1]^2. `seedU` is the u32 hash key (see grain.seedU32).
export function leakAdd(nx: number, ny: number, p: LightleakParams, seedU: number): [number, number, number] {
  if (p.amount === 0) return [0, 0, 0];
  const edge = seedU % 4;
  const d = edgeDistance(edge, nx, ny);
  const falloff = 1 - smoothstep01(d / LEAK_WIDTH);
  const band = Math.floor(alongEdge(edge, nx, ny) * 24);
  const streak = 0.35 + 0.65 * hash01(band, 0, seedU);
  const gain = clamp01(p.amount / 100) * 0.5 * falloff * streak;
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
