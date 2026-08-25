import { describe, it, expect } from 'vitest';
import { isNeutralPresence, packPresence, chromaBoost } from './presence';
import { OP_RENDERERS, presentOpIndices } from './ops';

const NEUTRAL = { texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 } as const;

describe('isNeutralPresence', () => {
  it('is true only when every parameter is zero', () => {
    expect(isNeutralPresence(NEUTRAL)).toBe(true);
    expect(isNeutralPresence({ ...NEUTRAL, texture: 20 })).toBe(false);
    expect(isNeutralPresence({ ...NEUTRAL, clarity: -10 })).toBe(false);
    expect(isNeutralPresence({ ...NEUTRAL, dehaze: 30 })).toBe(false);
    expect(isNeutralPresence({ ...NEUTRAL, vibrance: -40 })).toBe(false);
    expect(isNeutralPresence({ ...NEUTRAL, saturation: 50 })).toBe(false);
  });
});

describe('packPresence', () => {
  it('packs 5 params + 3 pad zeros, matching the WGSL struct', () => {
    const packed = packPresence({ texture: 10, clarity: -20, dehaze: 30, vibrance: -40, saturation: 50 });
    expect(Array.from(packed)).toEqual([10, -20, 30, -40, 50, 0, 0, 0]);
  });

  it('packs all zeros for a neutral presence', () => {
    expect(Array.from(packPresence(NEUTRAL))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('chromaBoost', () => {
  it('is 1 when both chroma params are neutral', () => {
    expect(chromaBoost(0, 0, 0.5)).toBe(1);
  });

  it('saturation scales all saturation levels equally', () => {
    expect(chromaBoost(100, 0, 0.1)).toBeCloseTo(chromaBoost(100, 0, 0.9), 6);
    expect(chromaBoost(100, 0, 0.5)).toBeCloseTo(2, 6);
  });

  it('vibrance boosts low-saturation pixels more than high-saturation ones', () => {
    const low = chromaBoost(0, 100, 0.1);
    const high = chromaBoost(0, 100, 0.9);
    expect(low).toBeGreaterThan(high);
    expect(low).toBeCloseTo(2.17, 6); // 1 + 1.3 * (1 - 0.1)
    expect(high).toBeCloseTo(1.13, 6); // 1 + 1.3 * (1 - 0.9)
  });

  it('negative saturation desaturates', () => {
    expect(chromaBoost(-100, 0, 0.5)).toBeCloseTo(0, 6);
  });

  it('clamps at 0 so a strong negative vibrance cannot invert hues', () => {
    // 1 * (1 - 1.3 * (1 - 0)) = -0.3 -> clamped to 0 (fully desaturated),
    // never a negative chroma scale that flips red to cyan.
    expect(chromaBoost(0, -100, 0)).toBe(0);
    expect(chromaBoost(0, -100, 1)).toBe(1); // already-saturated pixel untouched
  });
});

describe('presence registry entry', () => {
  it('is registered last and packs via packPresence', () => {
    expect(OP_RENDERERS[5].kind).toBe('presence');
    expect(Array.from(OP_RENDERERS[5].packParams([{ kind: 'presence', ...NEUTRAL, clarity: 25 }]))).toEqual([
      0, 25, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from(OP_RENDERERS[5].packParams([]))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Mandatory whiteBalance + profile passes always precede it.
    expect(presentOpIndices([{ kind: 'presence', ...NEUTRAL, texture: 1 }])).toEqual([0, 1, 5]);
  });
});
