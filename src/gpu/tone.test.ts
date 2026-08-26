import { describe, it, expect } from 'vitest';
import {
  buildParametricToneLut,
  buildToneCurveLut,
  buildToneLut,
  buildToneLuts,
  cameraOutput,
  fitRegionParams,
  isNeutralTone,
  LOG_MAX,
  LOG_MIN,
  logToNorm,
  LUMA_WEIGHTS,
  parametricControlPoints,
  sampleAcrCurve,
  sampleToneLut,
  toneBaselinePass,
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
  it('renders the ACR baseline curve when every parameter is neutral (LrC default look)', () => {
    const lut = buildToneLut(NEUTRAL);
    expect(lut.length).toBe(TONE_LUT_SIZE);
    // The ACR default curve is monotone (no tone inversion).
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
    // NOT identity: mid-gray (0.18 linear) is lifted through the baseline
    // curve (+1.11 EV) -- the exact "darker than LrC" gap. This is the pinned
    // repro: neutral tone must render LrC's baseline look, not linear.
    expect(sample(lut, logToNorm(0.18))).toBeCloseTo(logToNorm(sampleAcrCurve(0.18)), 3);
    expect(sample(lut, logToNorm(0.18))).toBeGreaterThan(logToNorm(0.18));
    // Super-white rolls to white: the curve's top input clamps to 1.0 (log-norm
    // 0.75), so the LUT caps at the white cap -- no hard 1.0 clip at the top.
    expect(lut[TONE_LUT_SIZE - 1]).toBeCloseTo(logToNorm(1), 4);
  });

  it('is monotonic for a typical combined adjustment (no tone inversion)', () => {
    const lut = buildToneLut({ contrast: 30, highlights: -40, shadows: 25, whites: 10, blacks: -15 });
    for (let i = 1; i < TONE_LUT_SIZE; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it('contrast > 0 separates tones about the baseline-lifted mid-gray (LrC pivot)', () => {
    const lut = buildToneLut({ ...NEUTRAL, contrast: 50 });
    expect(sample(lut, 0.25)).toBeLessThan(0.25);
    expect(sample(lut, 0.75)).toBeGreaterThan(0.75);
    // The pivot is the BASELINE-LIFTED mid-gray (0.18 linear through the ACR
    // default curve), not the raw domain midpoint -- LrC anchors contrast at
    // where mid-gray now renders.
    expect(sample(lut, logToNorm(0.18))).toBeCloseTo(logToNorm(sampleAcrCurve(0.18)), 3);
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

  it('whites > 0 brightens the top above the baseline cap (LrC: Whites + = brighter)', () => {
    const lut = buildToneLut({ ...NEUTRAL, whites: 60 });
    const base = buildToneLut(NEUTRAL);
    // A bright zone (x=0.9 -> linear ~5, super-white): the baseline already
    // rolls it to the white cap, and whites lifts it above that cap.
    expect(sample(lut, 0.9)).toBeGreaterThan(sample(base, 0.9));
  });

  it('whites < 0 darkens the top (recover), not clip-to-white -- LrC direction', () => {
    const lut = buildToneLut({ ...NEUTRAL, whites: -60 });
    expect(sample(lut, 0.9)).toBeLessThan(0.9);
  });

  it('highlights > 0 brightens the top -- LrC direction (top-roll, no hard clip)', () => {
    const lut = buildToneLut({ ...NEUTRAL, highlights: 60 });
    const base = buildToneLut(NEUTRAL);
    // The visible highlight zone (0.8-0.85, ~+1 EV) lifts clearly above the
    // baseline rolloff -- the old additive delta left it near-untouched, which
    // read as "Highlights + does nothing".
    expect(sample(lut, 0.8)).toBeGreaterThan(sample(base, 0.8));
    expect(sample(lut, 0.85)).toBeGreaterThan(sample(base, 0.85));
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

describe('buildToneLuts (3 per-channel LUTs -- the CAMERA look default)', () => {
  const cam = () => buildToneLuts(NEUTRAL);

  it('returns three 512-entry LUTs, each monotone', () => {
    const luts = cam();
    expect(luts.length).toBe(TONE_LUT_SIZE * 3);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(luts[ch * TONE_LUT_SIZE + i]).toBeGreaterThanOrEqual(luts[ch * TONE_LUT_SIZE + i - 1]);
      }
    }
  });

  it('applies ONE shared curve to all three channels -- no per-channel cast (the ฟ้าส้ม fix)', () => {
    const luts = cam();
    // The fit's per-channel B shadow lift was scene color (tungsten), not
    // camera tone -- baking it cast every file blue-orange. The camera look is
    // a single neutral luma curve, identical in R/G/B.
    for (let i = 0; i < TONE_LUT_SIZE; i++) {
      expect(luts[TONE_LUT_SIZE + i]).toBe(luts[i]);
      expect(luts[2 * TONE_LUT_SIZE + i]).toBe(luts[i]);
    }
  });

  it('renders the camera look at neutral: midtones match ACR, the shadow toe lifts above it', () => {
    const luts = cam();
    const std = buildToneLuts(NEUTRAL, 'standard');
    // The fit found the camera JPEG matches the ACR baseline channel-for-channel
    // in midtones/highlights (m ~= 1.0) -- the camera-back brightness IS ACR's
    // +1.11 EV import look. The only divergence is the film-sim black lift.
    for (let ch = 0; ch < 3; ch++) {
      expect(sampleToneLut(luts.subarray(ch * TONE_LUT_SIZE, (ch + 1) * TONE_LUT_SIZE), logToNorm(0.18))).toBeCloseTo(
        logToNorm(sampleAcrCurve(0.18)),
        3,
      );
    }
    // Deep shadow (log-norm x=0.2): the camera lifts above the ACR baseline.
    const camToe = sampleToneLut(luts.subarray(0, TONE_LUT_SIZE), 0.2);
    const stdToe = sampleToneLut(std.subarray(0, TONE_LUT_SIZE), 0.2);
    expect(camToe).toBeGreaterThan(stdToe);
  });

  it('rolls super-white highlights to the white cap, same as the ACR baseline', () => {
    const luts = cam();
    const std = buildToneLuts(NEUTRAL, 'standard');
    const y = sampleToneLut(luts.subarray(0, TONE_LUT_SIZE), 0.8);
    const yStd = sampleToneLut(std.subarray(0, TONE_LUT_SIZE), 0.8);
    // v = 2^(LOG_MIN + 0.8*16) = 1.74 linear; both looks clamp through the ACR
    // curve to white (log-norm 0.75 -> 1.0) -- the camera JPEG's highlights
    // match ACR (fit m ~= 1.0), no extra rolloff.
    expect(y).toBeCloseTo(yStd, 4);
    const out = 2 ** (LOG_MIN + y * (LOG_MAX - LOG_MIN));
    expect(out).toBeCloseTo(1.0, 4);
  });

  it("'standard' reproduces the ACR baseline identically across all three channels", () => {
    const std = buildToneLuts(NEUTRAL, 'standard');
    const base = buildToneLut(NEUTRAL);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < TONE_LUT_SIZE; i++) {
        expect(std[ch * TONE_LUT_SIZE + i]).toBeCloseTo(base[i], 5);
      }
    }
  });

  it('is monotonic for a combined adjustment (no tone inversion)', () => {
    const luts = buildToneLuts({ contrast: 30, highlights: -40, shadows: 25, whites: 10, blacks: -15 });
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(luts[ch * TONE_LUT_SIZE + i]).toBeGreaterThanOrEqual(luts[ch * TONE_LUT_SIZE + i - 1]);
      }
    }
  });
});

describe("buildToneLuts 'film' (Portra 400 -- the per-channel H-D base)", () => {
  const film = () => buildToneLuts(NEUTRAL, 'film');

  it('returns three DIFFERENT monotone LUTs (the film color character)', () => {
    const luts = film();
    expect(luts.length).toBe(TONE_LUT_SIZE * 3);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(luts[ch * TONE_LUT_SIZE + i]).toBeGreaterThanOrEqual(luts[ch * TONE_LUT_SIZE + i - 1]);
      }
    }
    // Per-channel, unlike camera/standard which share ONE curve across all three.
    const anyDiff = (a: Float32Array, b: Float32Array) =>
      Array.from(a).some((v, i) => Math.abs(v - b[i]) > 1e-4);
    expect(anyDiff(luts.subarray(0, TONE_LUT_SIZE), luts.subarray(TONE_LUT_SIZE, 2 * TONE_LUT_SIZE))).toBe(true);
    expect(anyDiff(luts.subarray(TONE_LUT_SIZE, 2 * TONE_LUT_SIZE), luts.subarray(2 * TONE_LUT_SIZE))).toBe(true);
  });

  it('maps mid-gray to the same log-domain position as the camera look (profile-swap is a look, not a re-exposure)', () => {
    const luts = film();
    const cam = buildToneLuts(NEUTRAL); // the camera look
    const yFilm = sampleToneLut(luts.subarray(TONE_LUT_SIZE, 2 * TONE_LUT_SIZE), logToNorm(0.18));
    const yCam = sampleToneLut(cam.subarray(TONE_LUT_SIZE, 2 * TONE_LUT_SIZE), logToNorm(0.18));
    // Both anchors land mid-gray at 0.39 linear (ACR +1.11 EV), log-norm ~0.665.
    expect(yFilm).toBeCloseTo(yCam, 2);
  });

  it('rolls super-white highlights toward the white cap without hard-clipping (the film shoulder)', () => {
    const luts = film();
    // The B channel tops just BELOW the cap: logToNorm(1) = 0.75 is pure white,
    // but the display-referred shoulder saturates near it (×0.862 scan gain) --
    // never a hard clip to 1.0 linear, and never a roll to black.
    const top = luts[TONE_LUT_SIZE * 3 - 1];
    expect(top).toBeGreaterThan(0.7); // saturates well above mid-gray (0.665)
    expect(top).toBeLessThan(logToNorm(1)); // no hard clip at super-white
  });

  it('is monotonic for a combined adjustment (sliders perturb the film base)', () => {
    const luts = buildToneLuts({ contrast: 30, highlights: -40, shadows: 25, whites: 10, blacks: -15 }, 'film');
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(luts[ch * TONE_LUT_SIZE + i]).toBeGreaterThanOrEqual(luts[ch * TONE_LUT_SIZE + i - 1]);
      }
    }
  });
});

describe('cameraOutput (the shared camera tone curve)', () => {
  it('is identity for midtones and highlights -- the camera JPEG matches ACR (fit m ~= 1.0)', () => {
    expect(cameraOutput(0.03)).toBe(0.03);
    expect(cameraOutput(0.18)).toBe(0.18);
    expect(cameraOutput(0.95)).toBe(0.95);
    expect(cameraOutput(1.0)).toBe(1.0);
  });

  it('lifts the shadow toe from the JPEG black floor to identity at o = 0.026, monotone', () => {
    expect(cameraOutput(0)).toBeCloseTo(0.0065, 4); // film-sim black floor
    expect(cameraOutput(0.026)).toBeCloseTo(0.026, 5); // continuous junction
    expect(cameraOutput(0.0065)).toBeGreaterThan(0.0065); // mid-toe lifted above the floor
    let prev = -1;
    for (let i = 0; i <= 260; i++) {
      const v = cameraOutput((i / 260) * 0.026);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('toneBaselinePass (per-channel tone LUT -- the "highlight ติดแดง" fix)', () => {
  const NEUTRAL_LUT = buildToneLut(NEUTRAL);
  const lumaOf = (rgb: [number, number, number]): number =>
    LUMA_WEIGHTS[0] * rgb[0] + LUMA_WEIGHTS[1] * rgb[1] + LUMA_WEIGHTS[2] * rgb[2];

  it('keeps the baseline lift for a neutral mid-gray (brightness unchanged)', () => {
    // 0.18 linear through the per-channel ACR curve = the +1.11 EV lift LrC
    // opens with -- the same luma the luma-only LUT targeted, so brightness is
    // bit-identical to the old path.
    const out = toneBaselinePass([0.18, 0.18, 0.18], NEUTRAL_LUT);
    for (const ch of out) expect(ch).toBeCloseTo(sampleAcrCurve(0.18), 2);
    // By construction out = base * outLum/baseLum, so the output luma equals
    // the LUT's target exactly (the luma-ratio path's output luma).
    const y = sampleToneLut(NEUTRAL_LUT, logToNorm(0.18));
    const target = 2 ** (LOG_MIN + y * (LOG_MAX - LOG_MIN));
    expect(lumaOf(out)).toBeCloseTo(target, 4);
  });

  it('rolls a blown warm highlight to neutral (the pre-fix red cast)', () => {
    // A super-white warm highlight (R>G>B, all > 1.0): the old luma-ratio path
    // scaled all channels together, preserving the cast -- (1.5, 1.2, 1.0)
    // rendered red (~1.20, 0.96, 0.80). Per-channel, each channel clamps to
    // 1.0 through the curve and rolls to white -> neutral, like LrC.
    const out = toneBaselinePass([1.5, 1.2, 1.0], NEUTRAL_LUT);
    expect(out[0]).toBeCloseTo(out[2], 2); // R == B: no red cast
    expect(out[1]).toBeCloseTo(out[2], 2); // G == B
    expect(out[0]).toBeCloseTo(1.0, 2); // the white cap
  });

  it('compresses the hottest channel of a warm non-blown highlight (per-channel)', () => {
    // (0.98, 0.9, 0.85): each channel maps through the LUT at its own log
    // position, so the hottest (R) compresses most and the R:B ratio falls
    // below the input's -- LrC's per-channel desaturation. A luma-ratio path
    // would keep the input's ratios (~1.089 / 1.153) and read redder.
    const out = toneBaselinePass([0.98, 0.9, 0.85], NEUTRAL_LUT);
    expect(out[0] / out[1]).toBeLessThan(0.98 / 0.9);
    expect(out[0] / out[2]).toBeLessThan(0.98 / 0.85);
  });

  it('recover (highlights -) desaturates a warm highlight -- the residual ติดแดง fix', () => {
    // (0.85, 0.68, 0.58) with Highlights -60. Per-channel mapping already
    // desaturates mid warm highlights (the hottest channel compresses toward
    // white most: R:G 1.25 -> ~1.065); the recover pull-down lowers R's log
    // output MORE than G's (R sits higher in the log domain -> larger recover
    // weight), so the recovered warm highlight desaturates FURTHER (R:G ->
    // ~1.037, near-neutral). The old luma-ratio recover scaled all channels
    // equally and kept the warm cast -- the "highlight ทาง - ติดแดง" the user
    // saw after the baseline fix.
    const neutral = toneBaselinePass([0.85, 0.68, 0.58], NEUTRAL_LUT);
    const recover = toneBaselinePass([0.85, 0.68, 0.58], buildToneLut({ ...NEUTRAL, highlights: -60 }));
    expect(neutral[0] / neutral[1]).toBeLessThan(0.85 / 0.68); // baseline desaturates (LrC)
    expect(recover[0] / recover[1]).toBeLessThan(neutral[0] / neutral[1]); // recover desaturates further
  });

  it('respects the parametric LUT on top (highlights + brightens)', () => {
    const lifted = buildToneLut({ ...NEUTRAL, highlights: 60 });
    const base = toneBaselinePass([0.9, 0.9, 0.9], NEUTRAL_LUT);
    const up = toneBaselinePass([0.9, 0.9, 0.9], lifted);
    expect(up[0]).toBeGreaterThan(base[0]);
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
    // The highlights anchor (0.88, 0.952) rises above the diagonal on +;
    // negative highlights pull the top down (recover = darker).
    expect(sample(brighten, 0.862)).toBeGreaterThan(0.862);
    expect(sample(recover, 0.898)).toBeLessThan(0.898);
    expect(sample(brighten, 0.862)).toBeGreaterThan(sample(recover, 0.862));
  });

  it('darks + and lights + each brighten their region (slider right = lighter)', () => {
    const dark = buildParametricToneLut(0, 0, 60, 0);
    // Darks anchor (0.40, 0.472) above the diagonal.
    expect(sample(dark, 0.37)).toBeGreaterThan(0.37);
    const bright = buildParametricToneLut(0, 60, 0, 0);
    // Lights anchor (0.60, 0.672) above the diagonal.
    expect(sample(bright, 0.63)).toBeGreaterThan(0.63);
  });
});

describe('fitRegionParams (the Region <-> Point inverse)', () => {
  it('round-trips parametricControlPoints back to the exact sliders', () => {
    for (const [h, l, d, s] of [[60, -20, 25, 40], [-60, 50, -30, -10], [0, 0, 0, 0], [100, 100, -100, -100]]) {
      const fitted = fitRegionParams(parametricControlPoints(h, l, d, s));
      expect(Math.abs(fitted.highlights - h)).toBeLessThanOrEqual(2);
      expect(Math.abs(fitted.lights - l)).toBeLessThanOrEqual(2);
      expect(Math.abs(fitted.darks - d)).toBeLessThanOrEqual(2);
      expect(Math.abs(fitted.shadows - s)).toBeLessThanOrEqual(2);
    }
  });

  it('is all-zero for the linear curve (Region neutral state)', () => {
    const fitted = fitRegionParams([0, 0, 1, 1]);
    expect(fitted).toEqual({ highlights: 0, lights: 0, darks: 0, shadows: 0 });
  });

  it('tracks a dragged point: raising the highlight anchor lifts the Highlights slider', () => {
    // A canonical parametric curve, then the top anchor nudged up.
    const pts = parametricControlPoints(0, 0, 0, 0);
    pts[9] = 0.95; // the (0.88, 0.88) highlight anchor -> y 0.95
    const fitted = fitRegionParams(pts);
    expect(fitted.highlights).toBeGreaterThan(0);
    expect(fitted.shadows).toBe(0);
  });
});
