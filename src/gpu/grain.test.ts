import { describe, it, expect } from 'vitest';
import {
  grainResponse,
  hashU32,
  seedFromPath,
  setGrainSeed,
  valueNoise,
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

  it('hash/value-noise stay in the right ranges', () => {
    expect(hashU32(0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(hashU32(0, 0, 1)).toBeLessThan(4294967295);
    for (let i = 0; i < 50; i++) {
      const n = valueNoise(i * 0.37, i * 0.71, 7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});
