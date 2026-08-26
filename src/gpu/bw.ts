// CPU-side model for the `bw` op (LrC treatment -> Black & White). Pure and
// unit-tested: the GPU shader (bw.wgsl) only looks up, all the math lives here.
//
// Two independent adjustments:
//   1. 8-band hue MIX (Red/Orange/Yellow/Green/Aqua/Blue/Purple/Magenta, each
//      -100..100). A hue keeps its normal luminance at 0, gets lighter/darker
//      as the band's weight moves. The response is
//          L0 = luma(rgb) * (1 + w/100 * saturation)
//      so a weight of 0 is a plain desaturation (exact luma), neutral colors
//      (sat=0) are never touched, and a pure-hue pixel is scaled by its band's
//      weight. `bandWeight` interpolates piecewise-linearly between the 8 band
//      centers, wrapping magenta->red.
//   2. A MONO TONE curve (ACROS / Tri-X 400 / Double-X / Leica Monochrom),
//      authored as display-referred [x,y] control points and baked into the
//      same log2-luminance LUT the tone ops use (tone.ts's LOG_MIN/LOG_MAX), so
//      the shader is a carbon copy of tonecurve.wgsl. 'none' is an exact
//      identity LUT.
//
// The op lives AFTER `tone` in the registry: the stock's per-channel H-D tone
// shapes the pre-conversion color (its luminance survives into B&W), then this
// pass drops the chroma and applies the mono tone. toneCurve/presence/vignette
// run on the gray image after it.
// ponytail: mono-tone control points are rough calibrations from memory --
// tune against real film scans / LrC B&W presets when one is on screen.

import { srgbToLinear } from './film';
import { TONE_LUT_SIZE, logToNorm, buildToneCurveLut, LUMA_WEIGHTS } from './tone';
import type { BwMix, BwToneId } from '../catalog/types';

// Hue-band centers (degrees) in RGB order: Red, Orange, Yellow, Green, Aqua,
// Blue, Purple, Magenta. Not uniform (the red->yellow wedge is dense in skin
// tones, green->aqua sparse) -- piecewise-linear handles that fine.
export const BW_BAND_CENTERS = [0, 30, 60, 90, 180, 240, 270, 300] as const;

export interface BwParams {
  mix: BwMix;
  tone: BwToneId;
}

export const BW_TONE_IDS: readonly BwToneId[] = ['none', 'acros', 'tx400', 'doublex', 'leica'];

// Physical camera-filter presets (LrC's B&W Filter): each just seeds the 8 mix
// sliders, so the sliders stay editable afterwards.
export type BwFilterId = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue';
export const BW_FILTERS: Record<BwFilterId, BwMix> = {
  none: [0, 0, 0, 0, 0, 0, 0, 0],
  red: [100, 60, 10, 0, 0, 0, 0, 20],
  orange: [40, 100, 40, 0, 0, 0, 0, 10],
  yellow: [0, 40, 100, 50, 0, 0, 0, 0],
  green: [0, 0, 50, 100, 40, 0, 0, 0],
  blue: [0, 0, 0, 0, 60, 100, 50, 0],
};

// Display-referred [x,y] tone responses, x/y in [0,1] display values. Baked to
// the log domain by buildBwToneLut. Distinct tonal fingerprints:
//   ACROS  -- smooth, gently lifted blacks, soft shoulder (low-key friendly)
//   Tri-X  -- the classic contrasty B&W neg (hard shadow compression, rolloff)
//   DoubleX -- Tri-X-like but deeper blacks and a heavier shoulder
//   Leica  -- Monochrom CCD: clean deep blacks, punchy mids, restrained highs
export const BW_TONES: Record<BwToneId, { name: string; points: number[] }> = {
  none: { name: 'None', points: [0, 0, 1, 1] },
  acros: { name: 'ACROS', points: [0, 0.012, 0.25, 0.27, 0.5, 0.51, 0.75, 0.75, 1, 0.97] },
  tx400: { name: 'Tri-X 400', points: [0, 0.015, 0.25, 0.29, 0.5, 0.55, 0.75, 0.78, 1, 0.955] },
  doublex: { name: 'Double-X', points: [0, 0.008, 0.25, 0.27, 0.5, 0.545, 0.75, 0.78, 1, 0.93] },
  leica: { name: 'Leica Monochrom', points: [0, 0.004, 0.25, 0.28, 0.5, 0.55, 0.75, 0.79, 1, 0.94] },
};

export function isNeutralBw(p: BwParams): boolean {
  return p.mix.every((v) => v === 0) && p.tone === 'none';
}

// Standard hue in degrees [0,360). Returns 0 for neutral (gray) pixels.
export function hueDeg(rgb: [number, number, number]): number {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 1e-6) return 0;
  let h: number;
  if (mx === r) {
    h = ((g - b) / d) % 6;
    if (h < 0) h += 6;
  } else if (mx === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return h * 60;
}

// Piecewise-linear mix weight at hue h, wrapping the magenta->red gap.
export function bandWeight(hDeg: number, mix: BwMix): number {
  const h = ((hDeg % 360) + 360) % 360;
  for (let i = 0; i < 8; i++) {
    const a = BW_BAND_CENTERS[i];
    const b = i === 7 ? 360 : BW_BAND_CENTERS[i + 1];
    if (h >= a && h < b) {
      const t = (h - a) / Math.max(b - a, 1e-4);
      return mix[i] + (mix[(i + 1) % 8] - mix[i]) * t;
    }
  }
  return mix[0]; // h === 360
}

// The B&W luminance (CPU mirror of bw.wgsl): luma scaled by the band weight and
// the pixel's saturation, so neutral mix = exact luma and neutral pixels are
// never touched by any mix.
export function bwLuminance(rgb: [number, number, number], mix: BwMix): number {
  const [r, g, b] = rgb;
  const lum = LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const w = bandWeight(hueDeg(rgb), mix);
  return Math.max(lum * (1 + (w / 100) * sat), 0);
}

// Bake a mono tone into the log2-luminance domain. Each display-referred point
// (x,y) -> (logToNorm(srgbToLinear(x)), logToNorm(srgbToLinear(y))): the input
// side finds where that display value sits in the log domain, the output side
// is the log-domain output the shader will exp2 back to linear. Points above
// display white (log-norm x > 0.75) clamp to the curve's top -- speculars roll
// into the shoulder, which is the film behavior wanted. 'none' must be EXACT
// identity (samplePchip clamps past the top control point, so a bare
// [0,0,0.75,0.75] bake would crush HDR highlights).
export function buildBwToneLut(tone: BwToneId): Float32Array {
  if (tone === 'none') {
    const lut = new Float32Array(TONE_LUT_SIZE);
    for (let i = 0; i < TONE_LUT_SIZE; i++) lut[i] = i / (TONE_LUT_SIZE - 1);
    return lut;
  }
  const pts = BW_TONES[tone].points;
  const logPts: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    logPts.push(logToNorm(srgbToLinear(pts[i])), logToNorm(srgbToLinear(pts[i + 1])));
  }
  return buildToneCurveLut(logPts);
}

// Uniform layout for bw.wgsl: mix (8 f32) + tone id (4 f32) + LUT (512 f32) =
// 524 f32 = 2096 B, a multiple of 16.
export function packBw(p: BwParams): Float32Array {
  const lut = buildBwToneLut(p.tone);
  const out = new Float32Array(8 + 4 + TONE_LUT_SIZE);
  out.set(p.mix, 0);
  out[8] = BW_TONE_IDS.indexOf(p.tone);
  out.set(lut, 12);
  return out;
}
