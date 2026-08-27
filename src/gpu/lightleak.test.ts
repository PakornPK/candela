import { describe, it, expect } from 'vitest';
import {
  isNeutralLightleak,
  leakAdd,
  leakColor,
  packLightleak,
  edgeDistance,
  type LightleakParams,
} from './lightleak';
import { seedU32 } from './grain';

const ON = { amount: 80, hue: 0 } satisfies LightleakParams;
const OFF = { amount: 0, hue: 0 } satisfies LightleakParams;

describe('lightleak', () => {
  it('is neutral at amount 0: adds exactly zero light', () => {
    expect(isNeutralLightleak(OFF)).toBe(true);
    expect(isNeutralLightleak({ ...OFF, amount: 1 })).toBe(false);
    const add = leakAdd(0.1, 0.1, OFF, seedU32(0.5));
    expect(add).toEqual([0, 0, 0]);
  });

  it('is deterministic per seed+coords; different seeds pick different edges', () => {
    const a = leakAdd(0.3, 0.3, ON, seedU32(0.25));
    const b = leakAdd(0.3, 0.3, ON, seedU32(0.25));
    expect(a).toEqual(b);
    // Over a handful of seeds at least two distinct edges appear (seed % 4).
    const edges = new Set([0.1, 0.35, 0.6, 0.85].map((s) => (seedU32(s) % 4).toString()));
    expect(edges.size).toBeGreaterThan(1);
  });

  it('leaks strongest on the chosen edge, fading toward the far side', () => {
    const edge = seedU32(0.5) % 4; // whichever edge this seed picks
    // A pixel just off the edge leaks far more than the far-side pixel.
    const near: [number, number] = edge === 0 ? [0.5, 0.01] : edge === 1 ? [0.99, 0.5] : edge === 2 ? [0.5, 0.99] : [0.01, 0.5];
    const far: [number, number] = edge === 0 ? [0.5, 0.99] : edge === 1 ? [0.01, 0.5] : edge === 2 ? [0.5, 0.01] : [0.99, 0.5];
    const nearSum = leakAdd(...near, ON, seedU32(0.5)).reduce((s, v) => s + v, 0);
    const farSum = leakAdd(...far, ON, seedU32(0.5)).reduce((s, v) => s + v, 0);
    expect(nearSum).toBeGreaterThan(farSum);
    expect(farSum).toBeLessThan(1e-4); // past the leak width it adds ~nothing
  });

  it('is monotonic in amount (more leak = more added light)', () => {
    const weak = leakAdd(0.2, 0.5, { amount: 40, hue: 0 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    const strong = leakAdd(0.2, 0.5, { amount: 100, hue: 0 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(0);
  });

  it('hue slides warm -> cool: hue 0 is orange-dominant, 100 cyan-dominant', () => {
    const warm = leakColor(0);
    const cool = leakColor(100);
    expect(warm[0]).toBeGreaterThan(warm[2]); // orange: r > b
    expect(cool[2]).toBeGreaterThan(cool[0]); // cyan: b > r
  });

  it('edgeDistance is 0 on the chosen edge, 1 on the far side', () => {
    expect(edgeDistance(0, 0.5, 0.0)).toBe(0); // top
    expect(edgeDistance(0, 0.5, 1.0)).toBe(1);
    expect(edgeDistance(1, 1.0, 0.5)).toBe(0); // right
    expect(edgeDistance(1, 0.0, 0.5)).toBe(1);
    expect(edgeDistance(2, 0.5, 1.0)).toBe(0); // bottom
    expect(edgeDistance(3, 0.0, 0.5)).toBe(0); // left
  });

  it('packs 8 f32s (3 values + 5 pad) matching the Lightleak struct', () => {
    const packed = packLightleak({ amount: 60, hue: 40 }, 0.25);
    expect(Array.from(packed)).toEqual([60, 40, 0.25, 0, 0, 0, 0, 0]);
  });
});
