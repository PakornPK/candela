import { describe, it, expect } from 'vitest';
import { OP_RENDERERS, presentOpIndices, setAsShotGains, setCameraColorMatrix } from './ops';
import { WB_NEUTRAL_KELVIN } from './uniforms';
import { TONE_LUT_SIZE } from './tone';
import type { Op } from '../catalog/types';

const NEUTRAL_TONE = { kind: 'tone', contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 } as const;
// Registry order: [whiteBalance, profile, exposure, tone, toneCurve, presence].
// The first two (whiteBalance + profile) are mandatory -- they always run even
// with no ops (fresh open), see presentOpIndices.
const CAMERA = { kind: 'profile', profile: 'camera' } as const;

describe('presentOpIndices', () => {
  it('always includes the mandatory whiteBalance + profile passes', () => {
    // A no-ops fresh open still applies As-Shot WB + the camera color matrix.
    expect(presentOpIndices([])).toEqual([0, 1]);
    expect(presentOpIndices([CAMERA])).toEqual([0, 1]);
  });

  it('reports an op index in registry order when a single op is present', () => {
    expect(presentOpIndices([{ kind: 'exposure', ev: 0.5 }])).toEqual([0, 1, 2]);
    expect(presentOpIndices([{ kind: 'whiteBalance', kelvin: 6000, tint: 0 }])).toEqual([0, 1]);
    expect(presentOpIndices([{ ...NEUTRAL_TONE, contrast: 20 }])).toEqual([0, 1, 3]);
    expect(presentOpIndices([{ kind: 'toneCurve', mode: 'point', points: [0, 0, 0.5, 0.6, 1, 1] }])).toEqual([0, 1, 4]);
  });

  it('reports all present ops in registry order, independent of Op[] order', () => {
    expect(presentOpIndices([
      CAMERA,
      { kind: 'whiteBalance', kelvin: 6000, tint: 0 },
      { kind: 'exposure', ev: -1 },
    ])).toEqual([0, 1, 2]);
  });
});

describe('OP_RENDERERS packParams', () => {
  it('profile packs the current camera matrix, identity for neutral', () => {
    const profile = OP_RENDERERS[1];
    expect(profile.kind).toBe('profile');
    setCameraColorMatrix(new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]));
    expect(Array.from(profile.packParams([CAMERA]))).toEqual([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0]);
    expect(Array.from(profile.packParams([{ kind: 'profile', profile: 'neutral' }]))).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    ]);
  });

  it('exposure packs ev as a gain, identity when absent', () => {
    const exposure = OP_RENDERERS[2];
    expect(exposure.kind).toBe('exposure');
    expect(Array.from(exposure.packParams([{ kind: 'exposure', ev: 0 }]))).toEqual([1, 0, 0, 0]);
    expect(Array.from(exposure.packParams([{ kind: 'exposure', ev: 1 }]))).toEqual([2, 0, 0, 0]);
    expect(Array.from(exposure.packParams([]))).toEqual([1, 0, 0, 0]);
  });

  it('whiteBalance packs kelvin as r/b gains and tint as g gain', () => {
    const wb = OP_RENDERERS[0];
    expect(wb.kind).toBe('whiteBalance');
    // Neutral 5500K + tint 0 -> gains (1, 1, 1).
    expect(Array.from(wb.packParams([{ kind: 'whiteBalance', kelvin: WB_NEUTRAL_KELVIN, tint: 0 }]))).toEqual([1, 1, 1, 0]);
    // Warm 9000K (mildly warm, shift +0.22) -> boost red, cut blue, green unchanged.
    const warm = wb.packParams([{ kind: 'whiteBalance', kelvin: 9000, tint: 0 }]);
    expect(warm[0]).toBeGreaterThan(1);
    expect(warm[1]).toBe(1); // gGain: kelvin never touches green
    expect(warm[2]).toBeLessThan(1);
    // Tint +100 (magenta) cuts green: gGain = 2^-((100/150)*2) = 0.397.
    const magenta = wb.packParams([{ kind: 'whiteBalance', kelvin: WB_NEUTRAL_KELVIN, tint: 100 }]);
    expect(magenta[1]).toBeCloseTo(0.397, 3);
    // Old stored rows without tint still pack (treated as tint 0).
    expect(Array.from(wb.packParams([{ kind: 'whiteBalance', kelvin: WB_NEUTRAL_KELVIN, tint: 0 }]))).toEqual([1, 1, 1, 0]);
    expect(Array.from(wb.packParams([]))).toEqual([1, 1, 1, 0]);
  });

  it('whiteBalance packs exact As-Shot gains when present, and falls back to the file default when absent', () => {
    const wb = OP_RENDERERS[0];
    expect(wb.kind).toBe('whiteBalance');
    // A cam_mul pair that kelvin+tint cannot represent (rGain*bGain != 1):
    // the op carries the exact gains and the renderer uses them verbatim.
    const asShot = wb.packParams([
      { kind: 'whiteBalance', kelvin: 5500, tint: 0, gains: { r: 2.1, g: 1, b: 1.4 } },
    ]);
    expect(asShot[0]).toBeCloseTo(2.1, 5);
    expect(asShot[1]).toBe(1);
    expect(asShot[2]).toBeCloseTo(1.4, 5);
    expect(asShot[3]).toBe(0);
    // No WB op -> the loaded file's As-Shot gains (set per load).
    setAsShotGains({ r: 1.5, g: 1, b: 0.8 });
    const fallback = wb.packParams([]);
    expect(fallback[0]).toBeCloseTo(1.5, 5);
    expect(fallback[1]).toBe(1);
    expect(fallback[2]).toBeCloseTo(0.8, 5);
    expect(fallback[3]).toBe(0);
    setAsShotGains({ r: 1, g: 1, b: 1 }); // restore neutral default
  });

  it('tone packs a 512-entry LUT, identity when absent', () => {
    const tone = OP_RENDERERS[3];
    expect(tone.kind).toBe('tone');
    const neutral = tone.packParams([]);
    expect(neutral.length).toBe(TONE_LUT_SIZE);
    // Identity LUT: entry i = i/(N-1) -- index 256 is 256/511, not 0.5.
    expect(neutral[256]).toBeCloseTo(256 / (TONE_LUT_SIZE - 1), 4);
    // A real adjustment changes the LUT (here contrast +50 darkens shadows).
    const adjusted = tone.packParams([{ ...NEUTRAL_TONE, contrast: 50 }]);
    expect(adjusted[Math.floor(TONE_LUT_SIZE * 0.25)]).toBeLessThan(0.25);
  });

  it('toneCurve packs a LUT, identity when absent or linear', () => {
    const curve = OP_RENDERERS[4];
    expect(curve.kind).toBe('toneCurve');
    const absent = curve.packParams([]);
    expect(absent.length).toBe(TONE_LUT_SIZE);
    expect(absent[Math.floor(TONE_LUT_SIZE * 0.3)]).toBeCloseTo(0.3, 2); // linear -> identity
    const linear = curve.packParams([{ kind: 'toneCurve', mode: 'point', points: [0, 0, 1, 1] }]);
    expect(linear[Math.floor(TONE_LUT_SIZE * 0.7)]).toBeCloseTo(0.7, 2);
    // A real curve changes the LUT (here lifted shadows / compressed highlights).
    const lifted = curve.packParams([{ kind: 'toneCurve', mode: 'point', points: [0, 0, 0.25, 0.4, 0.75, 0.7, 1, 1] }]);
    expect(lifted[Math.floor(TONE_LUT_SIZE * 0.25)]).toBeGreaterThan(0.25);
    expect(lifted[Math.floor(TONE_LUT_SIZE * 0.75)]).toBeLessThan(0.75);
  });

  it('toneCurve legacy rows (no mode) are treated as point mode', () => {
    // Rows saved before the region mode existed carry `points` without `mode`.
    const curve = OP_RENDERERS[4];
    const legacy = curve.packParams([
      { kind: 'toneCurve', points: [0, 0, 0.25, 0.4, 0.75, 0.7, 1, 1] } as Op,
    ]);
    expect(legacy[Math.floor(TONE_LUT_SIZE * 0.25)]).toBeGreaterThan(0.25);
    expect(legacy[Math.floor(TONE_LUT_SIZE * 0.75)]).toBeLessThan(0.75);
  });

  it('toneCurve region mode packs the parametric LUT, point/legacy unchanged', () => {
    const curve = OP_RENDERERS[4];
    const region = curve.packParams([
      { kind: 'toneCurve', mode: 'region', highlights: 60, lights: 0, darks: 0, shadows: 0 },
    ]);
    expect(region.length).toBe(TONE_LUT_SIZE);
    // Highlights +60 pushes the region curve's top anchor above the diagonal
    // (LrC: slider right = lighter), while the shadows end stays untouched.
    expect(region[Math.floor(TONE_LUT_SIZE * 0.862)]).toBeGreaterThan(0.862);
    expect(region[Math.floor(TONE_LUT_SIZE * 0.12)]).toBeCloseTo(0.12, 2);
    // All-zero region params are the identity -- same as the linear default.
    const neutralRegion = curve.packParams([
      { kind: 'toneCurve', mode: 'region', highlights: 0, lights: 0, darks: 0, shadows: 0 },
    ]);
    expect(neutralRegion[Math.floor(TONE_LUT_SIZE * 0.5)]).toBeCloseTo(0.5, 2);
  });
});
