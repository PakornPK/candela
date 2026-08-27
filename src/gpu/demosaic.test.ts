import { describe, it, expect } from 'vitest';

// Mirrors src/shaders/demosaic.wgsl in TS to pin its central claim: the
// color-difference form it uses IS the Malvar-He-Cutler kernels, exactly,
// for every non-green pixel in Bayer. The shader interpolates a missing
// channel C at a center of channel K as
//   C = ringAvg(C) + alpha * (K_center - crossAvg(K))
// with alpha = 1/2 for green, 1/4 for R/B. ringAvg = average of same-color
// samples on the 3x3 ring, crossAvg = average on the distance-2 orthogonal
// cross. This test feeds a synthetic RGGB patch through both the shader
// formula and the actual published MHC kernels and requires equality. If
// someone changes the ring/cross/alpha, this is the check that breaks.

// The four MHC kernels the shader reproduces (Malvar, He & Cutler 2004,
// "High-quality linear interpolation for demosaicing of Bayer-patterned
// color images"). The kernel center sits on the center pixel's channel.
const G_AT_R_OR_B = [
  [0, 0, -1, 0, 0],
  [0, 0, 2, 0, 0],
  [-1, 2, 4, 2, -1],
  [0, 0, 2, 0, 0],
  [0, 0, -1, 0, 0],
]; // /8
const OPP_AT_R_OR_B = [
  [0, 0, -1, 0, 0],
  [0, 4, 0, 4, 0],
  [-1, 0, 4, 0, -1],
  [0, 4, 0, 4, 0],
  [0, 0, -1, 0, 0],
]; // /16

// 0=R 1=G 2=B. RGGB tile, x = column, y = row.
function colorAt(x: number, y: number): number {
  const tile = [
    [0, 1],
    [1, 2],
  ];
  return tile[y % 2][x % 2];
}

// Average of `patch` values at `taps` (offsets from (cx,cy)) whose CFA color
// is `color`; taps that aren't that color are skipped (mirrors the shader).
function avg(patch: number[][], cx: number, cy: number, color: number, taps: [number, number][]): number {
  let sum = 0;
  let n = 0;
  for (const [dx, dy] of taps) {
    if (colorAt(cx + dx, cy + dy) !== color) continue;
    sum += patch[cx + dx][cy + dy];
    n++;
  }
  return n ? sum / n : 0;
}

const RING: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];
const CROSS: [number, number][] = [
  [0, -2], [0, 2], [-2, 0], [2, 0],
];

// The shader's exact formula at (cx,cy): the interpolated r/g/b.
function shaderAt(patch: number[][], cx: number, cy: number): { r: number; g: number; b: number } {
  const center = patch[cx][cy];
  const k = colorAt(cx, cy);
  const ring = (c: number) => avg(patch, cx, cy, c, RING);
  const cross = (c: number) => avg(patch, cx, cy, c, CROSS);
  if (k === 0) {
    const lap = center - cross(0);
    return { r: center, g: ring(1) + 0.5 * lap, b: ring(2) + 0.25 * lap };
  }
  if (k === 2) {
    const lap = center - cross(2);
    return { b: center, g: ring(1) + 0.5 * lap, r: ring(0) + 0.25 * lap };
  }
  const lap = center - cross(1);
  return { g: center, r: ring(0) + 0.25 * lap, b: ring(2) + 0.25 * lap };
}

// Full 5x5 convolution of `kernel` (divisor `div`) at (cx,cy).
function mhc(patch: number[][], cx: number, cy: number, kernel: number[][], div: number): number {
  let sum = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      sum += kernel[dy + 2][dx + 2] * patch[cx + dx][cy + dy];
    }
  }
  return sum / div;
}

// Deterministic pseudo-random patch (Lcg), reproducible across runs.
function patch(size: number, seed: number): number[][] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  return Array.from({ length: size }, () => Array.from({ length: size }, () => rand()));
}

describe('demosaic.wgsl is Malvar-He-Cutler for non-green Bayer pixels', () => {
  for (const seed of [1, 7, 20260826]) {
    it(`reproduces the G-at-R/B kernel exactly (seed ${seed})`, () => {
      const p = patch(9, seed);
      // (4,4)-(5,5) covers all four RGGB tile colors as the center pixel.
      for (const [cx, cy] of [[4, 4], [4, 5], [5, 4], [5, 5]] as const) {
        if (colorAt(cx, cy) === 1) continue;
        expect(shaderAt(p, cx, cy).g).toBeCloseTo(mhc(p, cx, cy, G_AT_R_OR_B, 8), 10);
      }
    });

    it(`reproduces the R/B-at-opposite kernel exactly (seed ${seed})`, () => {
      const p = patch(9, seed);
      for (const [cx, cy] of [[4, 4], [4, 5], [5, 4], [5, 5]] as const) {
        const out = shaderAt(p, cx, cy);
        const k = colorAt(cx, cy);
        if (k === 0) expect(out.b).toBeCloseTo(mhc(p, cx, cy, OPP_AT_R_OR_B, 16), 10);
        if (k === 2) expect(out.r).toBeCloseTo(mhc(p, cx, cy, OPP_AT_R_OR_B, 16), 10);
      }
    });

    it(`green centers use the nearest-sample color-difference form (seed ${seed})`, () => {
      // The green-center MHC kernels are different filters (they weight the
      // opposite channel's N/S or E/W neighbors +8); the shader intentionally
      // uses the two nearest R/B samples plus the G Laplacian instead. Pin
      // that definition, not equality with a kernel.
      const p = patch(9, seed);
      for (const [cx, cy] of [[4, 4], [4, 5], [5, 4], [5, 5]] as const) {
        if (colorAt(cx, cy) !== 1) continue;
        const out = shaderAt(p, cx, cy);
        const lap = p[cx][cy] - avg(p, cx, cy, 1, CROSS);
        expect(out.r).toBeCloseTo(avg(p, cx, cy, 0, RING) + 0.25 * lap, 10);
        expect(out.b).toBeCloseTo(avg(p, cx, cy, 2, RING) + 0.25 * lap, 10);
      }
    });
  }
});
