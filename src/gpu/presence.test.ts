import { describe, it, expect } from 'vitest';
import { isNeutralPresence, packPresence, chromaBoost, clarityLogLuma, clarityGate, CLARITY_MID_LOG } from './presence';
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

describe('clarityLogLuma (CPU mirror of presence.wgsl)', () => {
  it('REPRO fixed: +100 on a midtone edge roughly doubles local log-contrast (halo is a feature)', () => {
    // The old HALO=0.06 clamp capped +100 at ~6% brightness -- the pinned repro
    // for "clarity ไม่มีอะไรเปลี่ยนเลย". Research: LrC +100 roughly DOUBLES
    // midtone local log-contrast and its halos are a feature. The midtone gate
    // lets the boost through at ~full strength at mid-gray: a pixel 0.2 log2
    // above its neighborhood mean lands ~0.5 above it (deviation 0.2 -> ~0.5,
    // i.e. 2.5x = "roughly doubled") and the bright side is > 20% brighter.
    const mid = CLARITY_MID_LOG;
    const out = clarityLogLuma(mid + 0.2, mid, 1.0);
    // The mirror is exact: response = strength * amount * deviation * gate.
    expect(out - (mid + 0.2)).toBeCloseTo(1.5 * 0.2 * clarityGate(mid + 0.2), 10);
    expect(out - mid).toBeCloseTo(0.5, 1); // ~0.5 log2 above the mean (was ~0.26 with the clamp)
    expect(2 ** (out - (mid + 0.2))).toBeGreaterThan(1.2); // clearly visible lift
  });

  it('gates clarity off at the extremes -- LrC halo management (no bloom in shadows/highlights)', () => {
    // 6 EV below/above mid-gray the gate has rolled to ~1.5e-4, so a strong
    // clarity moves deep shadows / hot highlights by < 0.2% brightness -- the
    // extremes don't bloom, exactly LrC's halo management.
    const shadowIn = CLARITY_MID_LOG - 6;
    const highlightIn = CLARITY_MID_LOG + 6;
    const shadowOut = clarityLogLuma(shadowIn, CLARITY_MID_LOG, 1.0);
    const highlightOut = clarityLogLuma(highlightIn, CLARITY_MID_LOG, 1.0);
    expect(2 ** (shadowOut - shadowIn)).toBeGreaterThan(0.998);
    expect(2 ** (shadowOut - shadowIn)).toBeLessThan(1.002);
    expect(2 ** (highlightOut - highlightIn)).toBeGreaterThan(0.998);
    expect(2 ** (highlightOut - highlightIn)).toBeLessThan(1.002);
  });

  it('negative clarity smooths: flattens contrast without inverting the edge', () => {
    // -100 at mid-gray: the dark side lifts toward the mean, the bright side
    // pulls down toward it -- contrast reduced, never flipped.
    const mid = CLARITY_MID_LOG;
    const dark = clarityLogLuma(mid - 0.2, mid, -1.0);
    const bright = clarityLogLuma(mid + 0.2, mid, -1.0);
    expect(dark).toBeGreaterThan(mid - 0.2);
    expect(bright).toBeLessThan(mid + 0.2);
    expect(bright - dark).toBeLessThan(0.4);
  });
});

describe('presence registry entry', () => {
  it('is registered before vignette and packs via packPresence', () => {
    expect(OP_RENDERERS[6].kind).toBe('presence');
    expect(Array.from(OP_RENDERERS[6].packParams([{ kind: 'presence', ...NEUTRAL, clarity: 25 }]))).toEqual([
      0, 25, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from(OP_RENDERERS[6].packParams([]))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Mandatory whiteBalance + profile + tone passes always precede it.
    expect(presentOpIndices([{ kind: 'presence', ...NEUTRAL, texture: 1 }])).toEqual([0, 1, 3, 6]);
  });
});
