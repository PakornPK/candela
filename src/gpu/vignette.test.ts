import { describe, it, expect } from 'vitest';
import {
  isNeutralVignette,
  packVignette,
  vignetteFactor,
  vignetteFactorProtected,
} from './vignette';

describe('isNeutralVignette', () => {
  it('is neutral only when amount is 0 (the other sliders do nothing alone)', () => {
    expect(isNeutralVignette({ amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0 })).toBe(true);
    expect(isNeutralVignette({ amount: 0, midpoint: 20, roundness: -80, feather: 0, highlights: 100 })).toBe(true);
    expect(isNeutralVignette({ amount: -50, midpoint: 50, roundness: 0, feather: 50, highlights: 0 })).toBe(false);
  });
});

describe('packVignette', () => {
  it('packs 8 floats in the shader struct layout (5 values + cropFrac X/Y + pad)', () => {
    const packed = packVignette({ amount: -60, midpoint: 40, roundness: 20, feather: 30, highlights: 10 });
    expect(packed.length).toBe(8);
    expect(Array.from(packed)).toEqual([-60, 40, 20, 30, 10, 1, 1, 0]);
    // The cropFrac (from the crop op) spans the vignette across the cropped
    // image -- LrC's Post-Crop Vignetting.
    const cropped = packVignette({ amount: -60, midpoint: 40, roundness: 20, feather: 30, highlights: 10 }, [0.667, 1]);
    expect(Array.from(cropped.subarray(0, 5))).toEqual([-60, 40, 20, 30, 10]);
    expect(cropped[5]).toBeCloseTo(0.667, 3); // f32 round-trip of a fraction
    expect(cropped[6]).toBe(1);
    expect(cropped[7]).toBe(0);
  });
});

describe('vignetteFactor (the radial falloff)', () => {
  it('is exactly 1 at the center and when amount is 0', () => {
    expect(vignetteFactor(0, -100, 50, 50)).toBe(1);
    expect(vignetteFactor(1, 0, 50, 50)).toBe(1);
  });

  it('darkens corners for negative amount, lightens for positive', () => {
    expect(vignetteFactor(1, -100, 50, 50)).toBeLessThan(1);
    expect(vignetteFactor(1, -100, 50, 50)).toBeGreaterThan(0); // not fully black
    expect(vignetteFactor(1, 100, 50, 50)).toBeGreaterThan(1);
  });

  it('is monotone in radius -- the effect only grows toward the edge', () => {
    for (const amount of [-100, -40, 40, 100]) {
      let prev = vignetteFactor(0, amount, 50, 50);
      for (let i = 1; i <= 20; i++) {
        const f = vignetteFactor(i / 20, amount, 50, 50);
        if (amount < 0) expect(f).toBeLessThanOrEqual(prev + 1e-9);
        else expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = f;
      }
    }
  });

  it('midpoint pushes the falloff toward the corners (0 reaches in, 100 hugs the edge)', () => {
    expect(vignetteFactor(0.3, -100, 0, 50)).toBeLessThan(1); // reaches the center region
    expect(vignetteFactor(0.3, -100, 100, 50)).toBe(1); // ramp only at the very corner
  });

  it('feather 0 is a hard edge, feather 100 a gradual ramp', () => {
    // At r=0.6 with midpoint 50, the hard ramp has already hit full strength
    // while the soft ramp is mid-transition -- so hard darkens more there.
    expect(vignetteFactor(0.6, -100, 50, 0)).toBeLessThan(vignetteFactor(0.6, -100, 50, 100));
  });
});

describe('vignetteFactorProtected (LrC Highlights)', () => {
  it('leaves dark pixels untouched by the protection', () => {
    const unprotected = vignetteFactor(1, 100, 50, 50);
    expect(vignetteFactorProtected(1, 100, 50, 50, 0.1, 100)).toBeCloseTo(unprotected, 10);
  });

  it('blends bright pixels toward no-op as highlights rises', () => {
    const brightProtected = vignetteFactorProtected(1, 100, 50, 50, 0.9, 100);
    const brightUnprotected = vignetteFactorProtected(1, 100, 50, 50, 0.9, 0);
    expect(Math.abs(brightProtected - 1)).toBeLessThan(Math.abs(brightUnprotected - 1));
  });
});
