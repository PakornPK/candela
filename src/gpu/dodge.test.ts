import { describe, expect, it } from 'vitest';
import {
  DODGE_MASK_MAX,
  isNeutralDodgeBurn,
  maskDims,
  maskHasPaint,
  maskToBytes,
  maskToOp,
  opToMask,
  packDodgeBurn,
  paintStroke,
} from './dodge';

describe('maskDims', () => {
  it('caps the longest edge at 1024 keeping aspect', () => {
    expect(maskDims(6000, 4000)).toEqual([1024, Math.round(4000 * (1024 / 6000))]);
    expect(maskDims(4000, 6000)).toEqual([Math.round(4000 * (1024 / 6000)), 1024]);
  });

  it('passes through sub-cap images', () => {
    expect(maskDims(800, 600)).toEqual([800, 600]);
  });

  it('never returns zero', () => {
    expect(maskDims(1, 1)).toEqual([1, 1]);
    expect(maskDims(6000, 1)[0]).toBeGreaterThan(0);
    expect(maskDims(6000, 1)[0]).toBeLessThanOrEqual(DODGE_MASK_MAX);
  });
});

describe('paintStroke', () => {
  it('accumulates positive density for dodge', () => {
    const m = new Float32Array(100);
    paintStroke(m, 10, 10, 2, 5, 2, 5, 2, 0.5, 1);
    expect(m[5 * 10 + 2]).toBeGreaterThan(0); // stroke center
    expect(m[0]).toBe(0); // untouched corner stays neutral
  });

  it('accumulates negative density for burn', () => {
    const m = new Float32Array(100);
    paintStroke(m, 10, 10, 2, 5, 2, 5, 2, 0.5, -1);
    expect(m[5 * 10 + 2]).toBeLessThan(0);
  });

  it('clamps at +-1', () => {
    const m = new Float32Array(100);
    paintStroke(m, 10, 10, 2, 5, 2, 5, 2, 2, 1); // opacity 2x clamps
    expect(m[5 * 10 + 2]).toBe(1);
    paintStroke(m, 10, 10, 2, 5, 2, 5, 2, 2, -1);
    expect(m[5 * 10 + 2]).toBeLessThan(1); // burn over dodge cancels
  });

  it('interpolates a continuous band across a drag', () => {
    const m = new Float32Array(100);
    paintStroke(m, 10, 10, 0, 5, 9, 5, 1.5, 0.4, 1);
    expect(m[5 * 10 + 4]).toBeGreaterThan(0); // mid-drag stamped
    expect(m[5 * 10 + 9]).toBeGreaterThan(0); // end stamped
  });
});

describe('mask byte/op encodings', () => {
  it('maskToBytes maps 0->128, +1->255, -1->1', () => {
    // Math.round rounds .5 toward +inf, so -0.5 -> 128 + (-63) = 65 (asymmetric
    // by one at exact half-steps -- irrelevant for arbitrary float densities).
    const bytes = maskToBytes(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(bytes)).toEqual([128, 255, 1, 192, 65]);
  });

  it('maskToOp/opToMask round-trips within 1/127', () => {
    const m = new Float32Array([0, 1, -1, 0.3, -0.7, 0.999]);
    const back = opToMask({ mask: maskToOp(m), maskW: 6, maskH: 1 });
    for (let i = 0; i < m.length; i++) expect(back[i]).toBeCloseTo(m[i], 1);
  });
});

describe('packDodgeBurn', () => {
  it('amount 100 -> ev 4', () => {
    expect(packDodgeBurn({ amount: 100, size: 20, opacity: 50 })[0]).toBe(4);
  });
  it('amount 25 -> ev 1, amount 0 -> ev 0', () => {
    expect(packDodgeBurn({ amount: 25, size: 20, opacity: 50 })[0]).toBe(1);
    expect(packDodgeBurn({ amount: 0, size: 20, opacity: 50 })[0]).toBe(0);
  });
});

describe('guards', () => {
  it('isNeutralDodgeBurn', () => {
    expect(isNeutralDodgeBurn({ amount: 0, size: 20, opacity: 50 })).toBe(true);
    expect(isNeutralDodgeBurn({ amount: 30, size: 20, opacity: 50 })).toBe(false);
  });
  it('maskHasPaint only counts nonzero density', () => {
    expect(maskHasPaint(new Float32Array(4))).toBe(false);
    expect(maskHasPaint(new Float32Array([0, 0, 0.001, 0]))).toBe(true);
  });
});
