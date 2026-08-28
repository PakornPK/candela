// CPU-side model for the Vignette op (vignette.wgsl), mirroring LrC's
// Post-Crop Vignetting sliders. Pure + unit-tested: the GPU shader reads the
// packed uniform and computes the same falloff, but the direction logic (which
// way each slider moves the corners) is verifiable here without a browser.

export interface VignetteParams {
  amount: number; // -100..100, 0 neutral; negative darkens corners, positive lightens
  midpoint: number; // 0..100, default 50; where the falloff ramp begins (higher = tighter to the corners)
  roundness: number; // -100..100; negative -> rectangular (edges darken), positive -> circular (corners only)
  feather: number; // 0..100, default 50; softness of the falloff edge
  highlights: number; // 0..100; protects bright pixels from the vignette (both sides)
}

// Only `amount` matters -- with amount 0 the falloff multiplies by exactly 1
// regardless of the other sliders, so a pass is only worth emitting when it's
// non-zero (same rule as presence).
export function isNeutralVignette(p: VignetteParams): boolean {
  return p.amount === 0;
}

// Layout must match the `Vignette` struct in vignette.wgsl (5 f32s + the crop
// mask rect x/y/w/h + 1 pad). region = the crop mask rect (from crop.ts),
// [0,0,1,1] = no crop -- the vignette spans the image inside the crop, like
// LrC's Post-Crop Vignetting.
export function packVignette(p: VignetteParams, region: [number, number, number, number] = [0, 0, 1, 1]): Float32Array {
  return new Float32Array([p.amount, p.midpoint, p.roundness, p.feather, p.highlights, region[0], region[1], region[2], region[3], 0]);
}

export function smoothstep01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

// The multiplicative factor a pixel at normalized radius `r` (0 center .. 1
// corner) gets, ignoring roundness/highlights (they don't change the CENTER-
// vs-EDGE direction this pins). Mirrors vignette.wgsl exactly: a ramp that
// starts at the midpoint, spans (1-midpoint)*feather of the radius, and
// multiplies by 1 + 0.85*amount at full strength.
export function vignetteFactor(r: number, amount: number, midpoint: number, feather: number): number {
  const edge = Math.min(1, Math.max(0, midpoint / 100));
  const f = Math.min(1, Math.max(0, feather / 100));
  const width = Math.max((1 - edge) * (0.05 + 0.95 * f), 1e-3);
  const amt = Math.min(1, Math.max(-1, amount / 100));
  return 1 + 0.85 * amt * smoothstep01((r - edge) / width);
}

// Same factor with LrC's Highlights protection: bright pixels (linear luma
// past ~0.55) blend toward no-op, scaled by the highlights slider -- so a
// lighten OR darken vignette leaves bright areas mostly alone.
export function vignetteFactorProtected(
  r: number,
  amount: number,
  midpoint: number,
  feather: number,
  lum: number,
  highlights: number,
): number {
  const base = vignetteFactor(r, amount, midpoint, feather);
  const protect = smoothstep01((lum - 0.55) / 0.4) * Math.min(1, Math.max(0, highlights / 100));
  return base + (1 - base) * protect; // mix(base, 1, protect)
}
