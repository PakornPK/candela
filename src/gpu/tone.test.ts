import { describe, it, expect } from 'vitest';
import {
  buildParametricToneLut,
  buildToneCurveLut,
  buildToneLut,
  isNeutralTone,
  LOG_MAX,
  LOG_MIN,
  logToNorm,
  parametricControlPoints,
  TONE_LUT_SIZE,
  type ToneParams,
} from './tone';

const NEUTRAL: ToneParams = { contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };

function sample(lut: Float32Array, x: number): number {
  const pos = x * (TONE_LUT_SIZE - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, TONE_LUT_SIZE - 1);
  return lut[i0] + (pos - i0) * (lut[i1] - lut[i0]);
}

describe('isNeutralTone', () => {
  it('is true only when every parameter is exactly 0', () => {
    expect(isNeutralTone(NEUTRAL)).toBe(true);
    expect(isNeutralTone({ ...NEUTRAL, contrast: 1 })).toBe(false);
    expect(isNeutralTone({ ...NEUTRAL, blacks: -1 })).toBe(false);
  });
});

describe('buildToneLut', () => {
  it('is the identity when every parameter is neutral', () => {
    const lut = buildToneLut(NEUTRAL);
    expect(lut.length).toBe(TONE_LUT_SIZE);
    for (let i = 0; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeCloseTo(i / (TONE_LUT_SIZE - 1), 4);
    }
  });

  it('is monotonic for a typical combined adjustment (no tone inversion)', () => {
    const lut = buildToneLut({ contrast: 30, highlights: -40, shadows: 25, whites: 10, blacks: -15 });
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it('contrast > 0 separates tones about mid-gray (LrC pivot), holding 0.18 linear', () => {
    const lut = buildToneLut({ ...NEUTRAL, contrast: 50 });
    expect(sample(lut, 0.25)).toBeLessThan(0.25);
    expect(sample(lut, 0.75)).toBeGreaterThan(0.75);
    // The pivot is mid-gray (0.18 linear), not the domain midpoint.
    expect(sample(lut, logToNorm(0.18))).toBeCloseTo(logToNorm(0.18), 3);
  });

  it('shadows > 0 lifts the toe', () => {
    const lut = buildToneLut({ ...NEUTRAL, shadows: 60 });
    expect(sample(lut, 0.2)).toBeGreaterThan(0.2);
  });

  it('blacks < 0 lifts the output floor (LrC: Blacks - = lift)', () => {
    const lut = buildToneLut({ ...NEUTRAL, blacks: -50 });
    expect(lut[0]).toBeGreaterThan(0);
  });

  it('blacks > 0 crushes the bottom toward black (LrC: Blacks + = punch)', () => {
    const lut = buildToneLut({ ...NEUTRAL, blacks: 50 });
    // Deep shadow (log ~ -7 EV) darkens; Blacks runs opposite to Shadows.
    expect(sample(lut, 0.15)).toBeLessThan(0.15);
  });

  it('whites > 0 brightens the top toward clipping (LrC: Whites + = brighter)', () => {
    const lut = buildToneLut({ ...NEUTRAL, whites: 60 });
    expect(sample(lut, 0.9)).toBeGreaterThan(0.9);
    expect(lut[TONE_LUT_SIZE - 1]).toBeGreaterThanOrEqual(1.0 - 1e-6); // top clips to white
  });

  it('whites < 0 darkens the top (recover), not clip-to-white -- LrC direction', () => {
    const lut = buildToneLut({ ...NEUTRAL, whites: -60 });
    expect(sample(lut, 0.9)).toBeLessThan(0.9);
  });

  it('highlights > 0 brightens the top -- LrC direction (top-roll, no hard clip)', () => {
    const lut = buildToneLut({ ...NEUTRAL, highlights: 60 });
    expect(sample(lut, 0.85)).toBeGreaterThan(0.85);
    // The visible highlight zone (0.8 = ~+1 EV) now lifts clearly -- the old
    // additive delta left it near-untouched and pinned the near-white end at
    // 1.0, which read as "Highlights + does nothing".
    expect(sample(lut, 0.8)).toBeGreaterThan(0.83);
    expect(sample(lut, 1.0)).toBeGreaterThanOrEqual(1.0 - 1e-6); // top stays white
    // +100 ROLLS toward white instead of hard-clipping the near-white zone.
    const max = buildToneLut({ ...NEUTRAL, highlights: 100 });
    expect(sample(max, 0.9)).toBeLessThan(0.96);
  });

  it('highlights < 0 darkens the top (recovers blown highlights) -- LrC direction', () => {
    const lut = buildToneLut({ ...NEUTRAL, highlights: -60 });
    expect(sample(lut, 0.85)).toBeLessThan(0.85);
    // Brighten (+) is the lighter one; recover (-) the darker one.
    const recover = buildToneLut({ ...NEUTRAL, highlights: -60 });
    const brighten = buildToneLut({ ...NEUTRAL, highlights: 60 });
    expect(sample(recover, 0.85)).toBeLessThan(sample(brighten, 0.85));
  });
});

describe('log domain (matches tone.wgsl)', () => {
  it('maps the domain endpoints to 0 and 1', () => {
    expect(logToNorm(2 ** LOG_MIN)).toBe(0);
    expect(logToNorm(2 ** LOG_MAX)).toBe(1);
  });

  it('maps unit luminance to the middle-upper domain', () => {
    // log2(1)=0 -> (0 - -12)/16 = 0.75. Bright-but-not-blown highlights sit
    // here; the top quarter of the LUT is super-bright (> 1.0 linear).
    expect(logToNorm(1)).toBeCloseTo(0.75, 6);
  });

  it('clamps outside the domain', () => {
    expect(logToNorm(1e-9)).toBe(0); // below 2^-12
    expect(logToNorm(1e6)).toBe(1); // above 2^4
  });
});

describe('buildToneCurveLut', () => {
  it('rejects flat lists that are not [x,y] pairs', () => {
    expect(() => buildToneCurveLut([])).toThrow();
    expect(() => buildToneCurveLut([0, 0, 1])).toThrow();
  });

  it('a linear (0,0)-(1,1) curve is the identity', () => {
    const lut = buildToneCurveLut([0, 0, 1, 1]);
    for (let i = 0; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeCloseTo(i / (TONE_LUT_SIZE - 1), 4);
    }
  });

  it('is non-decreasing for a monotone S-shaped control set (no inversion)', () => {
    const lut = buildToneCurveLut([0, 0, 0.25, 0.15, 0.5, 0.5, 0.75, 0.85, 1, 1]);
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
    // Passes through the (0.25, 0.15) and (0.75, 0.85) control points.
    expect(sample(lut, 0.25)).toBeCloseTo(0.15, 2);
    expect(sample(lut, 0.75)).toBeCloseTo(0.85, 2);
  });

  it('sorts unsorted input', () => {
    const scrambled = buildToneCurveLut([0.8, 0.9, 0.2, 0.1]);
    const sorted = buildToneCurveLut([0.2, 0.1, 0.8, 0.9]);
    expect(Array.from(scrambled)).toEqual(Array.from(sorted));
  });

  it('clamps x to [0,1] and values outside the curve range clamp to the ends', () => {
    // (0.8,0.9), (0.2,0.1), (1.2→1, 0.9) -- x overshoot clamps to 1.
    const lut = buildToneCurveLut([0.8, 0.9, 0.2, 0.1, 1.2, 0.9]);
    expect(sample(lut, 0.0)).toBeCloseTo(0.1, 3); // below first x -> first point's y
    expect(sample(lut, 1.0)).toBeCloseTo(0.9, 3); // last point is (1, 0.9)
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it('an x-overshooting curve still yields a bounded LUT (no NaN/banding)', () => {
    const lut = buildToneCurveLut([0, 0, 0.5, 1.5, 1, 1]); // y > 1 mid-curve
    for (const v of lut) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildParametricToneLut (LrC Region curve)', () => {
  it('all-zero params are the exact identity (PCHIP through the diagonal)', () => {
    const lut = buildParametricToneLut(0, 0, 0, 0);
    for (let i = 0; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeCloseTo(i / (TONE_LUT_SIZE - 1), 4);
    }
  });

  it('parametricControlPoints is the diagonal when every slider is neutral', () => {
    expect(parametricControlPoints(0, 0, 0, 0)).toEqual([0, 0, 0.12, 0.12, 0.4, 0.4, 0.6, 0.6, 0.88, 0.88, 1, 1]);
  });

  it('is non-decreasing for a combined adjustment (no tone inversion)', () => {
    const lut = buildParametricToneLut(30, -20, 25, 40);
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it('shadows + lifts the toe', () => {
    const lut = buildParametricToneLut(0, 0, 0, 60);
    // The shadows anchor (0.12, 0.192) rises above the diagonal.
    expect(sample(lut, 0.12)).toBeGreaterThan(0.12);
  });

  it('highlights + brightens, highlights - recovers (LrC region direction)', () => {
    const brighten = buildParametricToneLut(60, 0, 0, 0);
    const recover = buildParametricToneLut(-60, 0, 0, 0);
    // The highlights anchor (0.862, 0.952) rises above the diagonal on +;
    // negative highlights pull the top down (recover = darker).
    expect(sample(brighten, 0.862)).toBeGreaterThan(0.862);
    expect(sample(recover, 0.898)).toBeLessThan(0.898);
    expect(sample(brighten, 0.862)).toBeGreaterThan(sample(recover, 0.862));
  });

  it('darks + and lights + each brighten their region (slider right = lighter)', () => {
    const dark = buildParametricToneLut(0, 0, 60, 0);
    // Darks anchor (0.37, 0.472) above the diagonal.
    expect(sample(dark, 0.37)).toBeGreaterThan(0.37);
    const bright = buildParametricToneLut(0, 60, 0, 0);
    // Lights anchor (0.63, 0.672) above the diagonal.
    expect(sample(bright, 0.63)).toBeGreaterThan(0.63);
  });
});
