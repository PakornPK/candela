import type { WbGains } from '../catalog/types';

export function evToGain(ev: number): number {
  return Math.pow(2, ev);
}

export interface WhiteBalanceGains {
  rGain: number;
  gGain: number;
  bGain: number;
}

// wbShift in [-1, 1]: positive shifts warmer (boost red, cut blue).
// tint in [-150, 150] (LrC's range): positive shifts magenta (cut green),
// negative shifts green (boost green) -- the green/magenta axis orthogonal to
// the blue/yellow Kelvin axis.
export function wbShiftToGains(wbShift: number, tint = 0): WhiteBalanceGains {
  // Exponential gains: ±1 shift = ±1 stop (2x / 0.5x). The old linear gains
  // (1 ± 0.5c) capped at 1.5x / 0.67x -- the "extremes too weak" complaint.
  // 2^c is always positive, so no gain can go negative (the previous clamp
  // existed to stop 1 + 0.5c dipping below 0).
  const c = Math.max(-1, Math.min(1, wbShift));
  // tint exponent 2: +150 cuts green to 2^-2 = 0.25 (strong magenta), +30 ->
  // 2^-0.4 = 0.76 -- a small move is already visible, matching LrC's
  // "นิดเดียวก็เข้ม" response.
  const t = Math.max(-1, Math.min(1, tint / 150));
  return {
    rGain: Math.pow(2, c),
    gGain: Math.pow(2, -t * 2),
    bGain: Math.pow(2, -c),
  };
}

// Layout must match the `Cfa` uniform struct in demosaic.wgsl:
// struct Cfa { pattern: array<vec4<u32>, 9> } -- 9 vec4s x 4 components =
// 36 colors, ONE color per component (color at CFA position i is
// pattern[i/4][i%4]). Each component must be a single color code (0=R 1=G
// 2=B), not a bit-packed group -- a previous 4-colors-per-u32 packing made
// the shader read packed groups, misclassified every pixel, and rendered
// every image dark red/black.
export function packCfa6(cfa6: Uint8Array): Uint32Array {
  if (cfa6.length !== 36) {
    throw new Error(`Expected 36 CFA entries, got ${cfa6.length}`);
  }
  // One u32 per CFA position fills all 144 bytes of the 9xvec4 uniform
  // buffer (36 u32s), so no component ever relies on zero padding.
  return Uint32Array.from(cfa6, (c) => c);
}

// Camera -> linear sRGB 3x3 (row-major, 9 floats) padded to 3 vec4s, matching
// the `ColorMat` struct in cameraColor.wgsl (one vec4 per output row, .w pad).
export function packColorMatrix(m: Float32Array): Float32Array {
  if (m.length !== 9) {
    throw new Error(`Expected 9 matrix entries, got ${m.length}`);
  }
  return new Float32Array([
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
  ]);
}

export const WB_NEUTRAL_KELVIN = 5500;
export const WB_MIN_KELVIN = 2000;
export const WB_MAX_KELVIN = 50000;

// UI-facing conversion only: the WB slider is displayed in Kelvin (2000..50000,
// LrC's full range), but the gain math above (wbShiftToGains) and the GPU
// uniform layout stay in their existing [-1, 1] shift space. MIRED-linear:
// mired = 1e6/K is the perceptually uniform temperature scale, so shift is
// linear in mired and each equal slider step is an equal warmth step. This is
// the fix for "temp slider is clustered": on a linear-Kelvin track the whole
// cool half of the response (2000..5500K) sat in the left ~7% of the width.
// Both ends still reach ±1 (full shift). 5500K -> 0. Not a physically
// accurate color-temperature model.
export function kelvinToShift(kelvin: number): number {
  const m = 1e6 / kelvin;
  const mN = 1e6 / WB_NEUTRAL_KELVIN;
  if (m > mN) return -(m - mN) / (1e6 / WB_MIN_KELVIN - mN); // cool: 5500..2000K -> 0..-1
  if (m < mN) return (mN - m) / (mN - 1e6 / WB_MAX_KELVIN); // warm: 5500..50000K -> 0..+1
  return 0; // exact neutral (m == mN): avoid the cool branch's -0
}

// Inverse of kelvinToShift. Used for the WB slider readout when an edit
// carries exact As-Shot gains -- the slider is still a kelvin track. Clamps
// like the forward direction (which is bounded to [-1, 1] by the Kelvin
// range), so an out-of-range shift reads as the corresponding end.
export function shiftToKelvin(c: number): number {
  const s = Math.max(-1, Math.min(1, c));
  const mN = 1e6 / WB_NEUTRAL_KELVIN;
  if (s < 0) return 1e6 / (mN + -s * (1e6 / WB_MIN_KELVIN - mN));
  if (s > 0) return 1e6 / (mN - s * (mN - 1e6 / WB_MAX_KELVIN));
  return WB_NEUTRAL_KELVIN;
}

// As-Shot gains -> kelvin/tint readout only (the render keeps the exact gains
// until the user drags). Temp axis is the R/B ratio: wbShiftToGains maps
// shift c to rGain=2^c, bGain=2^-c, so the shift matching a (r,b) pair is the
// midpoint of the two log gains. Tint is the green residual -- a pure
// temperature keeps rGain*bGain=1, so a product >1 means both R and B need
// green cut (magenta cast, +tint) and <1 is a green boost (-tint). Both
// clamped to the slider ranges.
export function gainsToKelvin(g: WbGains): number {
  const c = Math.max(-1, Math.min(1, 0.5 * (Math.log2(Math.max(g.r, 1e-6)) - Math.log2(Math.max(g.b, 1e-6)))));
  return shiftToKelvin(c);
}

export function gainsToTint(g: WbGains): number {
  const p = Math.log2(Math.max(g.r, 1e-6)) + Math.log2(Math.max(g.b, 1e-6));
  return Math.max(-150, Math.min(150, 37.5 * p));
}
