import { describe, it, expect } from 'vitest';
import {
  grainResponse,
  hashU32,
  seedFromPath,
  setGrainSeed,
  gradientNoise,
  isNeutralGrain,
  packGrain,
  type GrainParams,
} from './grain';

const MID = { amount: 100, size: 25, roughness: 50 } satisfies GrainParams;
const OFF = { amount: 0, size: 25, roughness: 50 } satisfies GrainParams;

describe('grain', () => {
  it('is stateless and deterministic: same seed + coords -> same field', () => {
    const a = grainResponse(0.18, MID, 0.123, 3, 7);
    const b = grainResponse(0.18, MID, 0.123, 3, 7);
    expect(a).toBe(b);
    expect(a).not.toBe(0.18); // mid-gray actually moves
    // A different seed (different photo) gives a different value at the same pixel.
    expect(grainResponse(0.18, MID, 0.456, 3, 7)).not.toBe(a);
  });

  it('is neutral at amount 0: output is exactly the input luma', () => {
    expect(isNeutralGrain(OFF)).toBe(true);
    expect(isNeutralGrain({ ...OFF, amount: 1 })).toBe(false);
    for (const lum of [0.01, 0.18, 0.6]) {
      expect(grainResponse(lum, OFF, 0.5, 10, 20)).toBe(lum);
    }
  });

  it('is monotonic in amount (more grain = larger move at mid-gray)', () => {
    const weak = Math.abs(grainResponse(0.18, { ...MID, amount: 50 }, 0.5, 10, 20) - 0.18);
    const strong = Math.abs(grainResponse(0.18, MID, 0.5, 10, 20) - 0.18);
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(0);
  });

  it('damps toward black and white -- grain is strongest mid-gray', () => {
    // At each of a few pixels the mid-gray move must beat the extreme moves.
    for (const [x, y] of [[3, 3], [11, 5], [20, 14]] as const) {
      const mid = Math.abs(grainResponse(0.18, MID, 0.3, x, y) - 0.18);
      const black = Math.abs(grainResponse(0.02, MID, 0.3, x, y) - 0.02);
      const white = Math.abs(grainResponse(0.9, MID, 0.3, x, y) - 0.9);
      expect(mid).toBeGreaterThan(black);
      expect(mid).toBeGreaterThan(white);
    }
  });

  it('is a multiplicative density mask — a single grain particle never brightens a mid-tone >25%', () => {
    // Film sim + grain glows (메듦 glowing specks): the old additive display-space
    // model could push one pixel to +59% (1σ) / +139% (2σ) linear at mid-gray
    // (d=0.5, damp=1.0). Film grain modulates density (log-symmetric), so the
    // worst single-particle brightening must stay a small multiplier.
    const p = MID; // amount 100, roughness 50
    const lum = 0.214; // d~0.5, damp~1.0 = strongest grain zone
    let worstRatio = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        worstRatio = Math.max(worstRatio, grainResponse(lum, p, 0.5, x, y) / lum);
      }
    }
    expect(worstRatio).toBeLessThan(1.25);
  });

  it('never produces a pure-white speck, even at roughness 100 near highlights', () => {
    // The old model clamped d2 to 1.0 on gaussian-tail pixels at bright tones
    // (d~0.93), leaving isolated white dots on a film-sim look.
    const p = { amount: 100, size: 25, roughness: 100 } satisfies GrainParams;
    const lum = 0.848; // d~0.93, damp~0.26
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        expect(grainResponse(lum, p, 0.5, x, y)).toBeLessThan(1.0);
      }
    }
  });

  it('seeds from the file path: stable per path, distinct between paths', () => {
    expect(seedFromPath('day1/img001.raf')).toBe(seedFromPath('day1/img001.raf'));
    expect(seedFromPath('day1/img001.raf')).not.toBe(seedFromPath('day1/img002.raf'));
    expect(seedFromPath('')).toBeGreaterThanOrEqual(0);
    expect(seedFromPath('x')).toBeLessThan(1);
  });

  it('packs 8 f32s (4 values + 4 pad) matching the Grain struct', () => {
    setGrainSeed(0.25);
    const packed = packGrain({ amount: 60, size: 30, roughness: 80 }, 0.25);
    expect(Array.from(packed)).toEqual([60, 30, 80, 0.25, 0, 0, 0, 0]);
  });

  it('gradient-noise stays in [-1,1] and has no lattice extrema', () => {
    expect(hashU32(0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(hashU32(0, 0, 1)).toBeLessThan(4294967295);
    const N = 256;
    const cell = 6.75; // size=25
    const field = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = gradientNoise(x / cell, y / cell, 7) * 1.5;
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        field[y * N + x] = v;
      }
    }
    // Lattice signature: value-noise pins every local max to a cell corner.
    // Gradient noise must NOT -- most maxima land off-grid.
    let cornerMax = 0;
    let offMax = 0;
    for (let y = 2; y < N - 2; y++) {
      for (let x = 2; x < N - 2; x++) {
        const c = field[y * N + x];
        const isMax = c >= field[y * N + x - 1] && c >= field[y * N + x + 1] &&
          c >= field[(y - 1) * N + x] && c >= field[(y + 1) * N + x];
        if (!isMax) continue;
        const fx = x / cell;
        const fy = y / cell;
        const dx = Math.min(fx - Math.floor(fx), Math.ceil(fx) - fx);
        const dy = Math.min(fy - Math.floor(fy), Math.ceil(fy) - fy);
        if (Math.max(dx, dy) < 0.15) cornerMax++;
        else offMax++;
      }
    }
    expect(offMax).toBeGreaterThan(cornerMax * 10); // value noise: cornerMax >> offMax
  });
});
