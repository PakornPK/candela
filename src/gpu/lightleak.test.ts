import { describe, it, expect } from 'vitest';
import {
  isNeutralLightleak,
  leakAdd,
  leakColor,
  leakFade,
  leakWeights,
  packLightleak,
  edgeDistance,
  type LightleakParams,
} from './lightleak';
import { seedU32 } from './grain';

const ON = { amount: 80, hue: 0, fade: 0, pattern: -1 } satisfies LightleakParams;
const OFF = { amount: 0, hue: 0, fade: 0, pattern: -1 } satisfies LightleakParams;

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
    expect(farSum).toBeLessThan(1e-4); // past the texture width it adds ~nothing
  });

  it('is monotonic in amount (more leak = more added light)', () => {
    const weak = leakAdd(0.2, 0.5, { amount: 40, hue: 0, fade: 0, pattern: -1 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    const strong = leakAdd(0.2, 0.5, { amount: 100, hue: 0, fade: 0, pattern: -1 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(0);
  });

  it('hue slides warm -> cool: hue 0 is orange-dominant, 100 cyan-dominant', () => {
    const warm = leakColor(0);
    const cool = leakColor(100);
    expect(warm[0]).toBeGreaterThan(warm[2]); // orange: r > b
    expect(cool[2]).toBeGreaterThan(cool[0]); // cyan: b > r
  });

  it('leakWeights picks a single texture at the extremes, blends mid hues', () => {
    expect(leakWeights(0)).toEqual([1, 0, 0]); // warm tex0
    expect(leakWeights(100)).toEqual([0, 0, 1]); // cool tex2
    const mid = leakWeights(50);
    expect(mid[1]).toBeCloseTo(1, 6); // mid tex1
    expect(mid[0]).toBeCloseTo(0, 6);
    expect(mid[2]).toBeCloseTo(0, 6);
    const mix = leakWeights(25); // half warm, half mid
    expect(mix[0]).toBeCloseTo(0.5, 6);
    expect(mix[1]).toBeCloseTo(0.5, 6);
    expect(mix[2]).toBeCloseTo(0, 6);
    for (const h of [0, 25, 50, 75, 100]) {
      const s = leakWeights(h).reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo(1, 6); // weights always sum to 1
    }
  });

  it('fade scales a distance envelope: 0 = full texture, 100 = dies by LEAK_WIDTH', () => {
    // fade 0 -> envelope is 1 everywhere (the texture's own falloff governs).
    expect(leakFade(0, 0.0)).toBe(1);
    expect(leakFade(0, 0.6)).toBe(1);
    // fade 100 -> envelope hits ~0 by LEAK_WIDTH (0.35).
    expect(leakFade(100, 0.0)).toBe(1);
    expect(leakFade(100, 0.1)).toBeGreaterThan(leakFade(100, 0.3));
    expect(leakFade(100, 0.36)).toBeLessThan(1e-4);
    // More fade = less leak at the same mid distance.
    expect(leakFade(100, 0.2)).toBeLessThan(leakFade(0, 0.2));
  });

  it('fade reduces the added light at mid distance without touching the edge', () => {
    const edge = seedU32(0.5) % 4;
    const mid: [number, number] = edge === 0 ? [0.5, 0.2] : edge === 1 ? [0.8, 0.5] : edge === 2 ? [0.5, 0.8] : [0.2, 0.5];
    const soft = leakAdd(...mid, { amount: 80, hue: 0, fade: 100, pattern: -1 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    const full = leakAdd(...mid, { amount: 80, hue: 0, fade: 0, pattern: -1 }, seedU32(0.5)).reduce((s, v) => s + v, 0);
    expect(full).toBeGreaterThan(soft);
    expect(full).toBeGreaterThan(0);
  });

  it('edgeDistance is 0 on the chosen edge, 1 on the far side', () => {
    expect(edgeDistance(0, 0.5, 0.0)).toBe(0); // top
    expect(edgeDistance(0, 0.5, 1.0)).toBe(1);
    expect(edgeDistance(1, 1.0, 0.5)).toBe(0); // right
    expect(edgeDistance(1, 0.0, 0.5)).toBe(1);
    expect(edgeDistance(2, 0.5, 1.0)).toBe(0); // bottom
    expect(edgeDistance(3, 0.0, 0.5)).toBe(0); // left
  });

  it('packs 8 f32s matching the Lightleak struct; pattern maps to mode+sel', () => {
    // auto (-1) -> patternMode 0 (seed picks the set) -- same layout as before.
    const auto = packLightleak({ amount: 60, hue: 40, fade: 30, pattern: -1 }, 0.25);
    expect(Array.from(auto)).toEqual([60, 40, 30, 0.25, 0, 0, 0, 0]);
    // fixed set -> patternMode 1, patternSel 0..3 (Set A..D), clamped to 0..3.
    const setA = packLightleak({ amount: 60, hue: 40, fade: 30, pattern: 0 }, 0.25);
    expect(Array.from(setA)).toEqual([60, 40, 30, 0.25, 1, 0, 0, 0]);
    const setB = packLightleak({ amount: 60, hue: 40, fade: 30, pattern: 1 }, 0.25);
    expect(Array.from(setB)).toEqual([60, 40, 30, 0.25, 1, 1, 0, 0]);
    const setC = packLightleak({ amount: 60, hue: 40, fade: 30, pattern: 2 }, 0.25);
    expect(Array.from(setC)).toEqual([60, 40, 30, 0.25, 1, 2, 0, 0]);
    const setD = packLightleak({ amount: 60, hue: 40, fade: 30, pattern: 3 }, 0.25);
    expect(Array.from(setD)).toEqual([60, 40, 30, 0.25, 1, 3, 0, 0]);
    // out-of-range pattern clamps into 0..3 rather than leaking into the pads.
    expect(Array.from(packLightleak({ amount: 1, hue: 0, fade: 0, pattern: 9 }, 0.25))[5]).toBe(3);
    expect(Array.from(packLightleak({ amount: 1, hue: 0, fade: 0, pattern: -5 }, 0.25))[5]).toBe(0);
  });
});
