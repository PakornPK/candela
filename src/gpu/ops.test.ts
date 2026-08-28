import { describe, it, expect } from 'vitest';
import { OP_RENDERERS, presentOpIndices, setAsShotGains, setCameraColorMatrix, setImageSize } from './ops';
import { setGrainSeed } from './grain';
import { WB_NEUTRAL_KELVIN } from './uniforms';
import { TONE_LUT_SIZE } from './tone';
import { buildBwToneLut } from './bw';
import type { Op } from '../catalog/types';

const NEUTRAL_TONE = { kind: 'tone', contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 } as const;
// Registry order: [whiteBalance, profile, exposure, tone, bw, toneCurve, presence, geometry, lightleak, crop, vignette, dodgeBurn, grain, frame].
// Three passes are mandatory -- they always run even with no ops (fresh open):
// whiteBalance (As-Shot fallback), profile (camera matrix), and tone (neutral
// tone now renders the ACR baseline curve -- the LrC import look, see tone.ts).
const CAMERA = { kind: 'profile', profile: 'camera' } as const;

describe('presentOpIndices', () => {
  it('always includes the mandatory whiteBalance + profile + tone passes', () => {
    // A no-ops fresh open still applies As-Shot WB + the camera color matrix +
    // the ACR baseline tone curve.
    expect(presentOpIndices([])).toEqual([0, 1, 3]);
    expect(presentOpIndices([CAMERA])).toEqual([0, 1, 3]);
  });

  it('reports an op index in registry order when a single op is present', () => {
    expect(presentOpIndices([{ kind: 'exposure', ev: 0.5 }])).toEqual([0, 1, 2, 3]);
    expect(presentOpIndices([{ kind: 'whiteBalance', kelvin: 6000, tint: 0 }])).toEqual([0, 1, 3]);
    expect(presentOpIndices([{ ...NEUTRAL_TONE, contrast: 20 }])).toEqual([0, 1, 3]);
    expect(presentOpIndices([{ kind: 'toneCurve', mode: 'point', points: [0, 0, 0.5, 0.6, 1, 1] }])).toEqual([0, 1, 3, 5]);
    expect(presentOpIndices([{ kind: 'vignette', amount: -50, midpoint: 50, roundness: 0, feather: 50, highlights: 0 }])).toEqual([0, 1, 3, 10]);
    expect(presentOpIndices([{ kind: 'bw', mix: [0, 0, 0, 0, 0, 0, 0, 0], tone: 'acros' }])).toEqual([0, 1, 3, 4]);
    expect(presentOpIndices([{ kind: 'grain', amount: 40, size: 25, roughness: 50 }])).toEqual([0, 1, 3, 12]);
    expect(presentOpIndices([{ kind: 'lightleak', amount: 60, hue: 20 }])).toEqual([0, 1, 3, 8]);
    expect(presentOpIndices([{ kind: 'crop', aspect: '1:1', rotate90: 0, angle: 0 }])).toEqual([0, 1, 3, 9]);
    expect(presentOpIndices([
      { kind: 'dodgeBurn', amount: 40, size: 20, opacity: 50, feather: 0, mask: new Int8Array(4), maskW: 2, maskH: 2 },
    ])).toEqual([0, 1, 3, 11]);
    expect(presentOpIndices([{ kind: 'frame', style: '135' }])).toEqual([0, 1, 3, 13]);
    expect(presentOpIndices([{ kind: 'geometry', vertical: 10, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 }])).toEqual([0, 1, 3, 7]);
  });

  it('reports all present ops in registry order, independent of Op[] order', () => {
    expect(presentOpIndices([
      CAMERA,
      { kind: 'whiteBalance', kelvin: 6000, tint: 0 },
      { kind: 'exposure', ev: -1 },
    ])).toEqual([0, 1, 2, 3]);
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

  it('tone packs 3 per-channel LUTs; the default look is the CAMERA look', () => {
    const tone = OP_RENDERERS[3];
    expect(tone.kind).toBe('tone');
    const neutral = tone.packParams([]);
    // Three 512-entry per-channel LUTs (R/G/B). Today all three carry the SAME
    // shared curve -- the camera look is a neutral tone (see cameraOutput in
    // tone.ts); the per-channel layout stays for future per-camera fits.
    expect(neutral.length).toBe(TONE_LUT_SIZE * 3);
    for (let ch = 1; ch < 3; ch++) {
      for (let i = 0; i < TONE_LUT_SIZE; i++) {
        expect(neutral[ch * TONE_LUT_SIZE + i]).toBe(neutral[i]);
      }
    }
    // NOT identity -- the CAMERA look renders the ACR baseline in the midtones
    // (index 256 sits at ~0.5475 log-norm; identity would be 256/511 = 0.501)
    // plus the film-sim shadow lift below it.
    expect(neutral[256]).toBeCloseTo(0.5475, 3);
    expect(neutral[512 + 256]).toBeCloseTo(0.5475, 3);
    expect(neutral[1024 + 256]).toBeCloseTo(0.5475, 3);
    // The camera look diverges from the ACR baseline ONLY in the shadow toe
    // (deep shadow index 60 lifts above standard -- the neutral black lift),
    // not in the midtones.
    const std = tone.packParams([{ kind: 'profile', profile: 'neutral' }]);
    expect(neutral[60]).toBeGreaterThan(std[60]);
    expect(neutral[256]).toBeCloseTo(std[256], 3);
    // A real adjustment changes the LUT (contrast +50 darkens below the pivot).
    const adjusted = tone.packParams([{ ...NEUTRAL_TONE, contrast: 50 }]);
    expect(adjusted[128]).toBeLessThan(neutral[128]);
  });

  it('tone falls back to the ACR baseline (standard look) when profile is neutral', () => {
    const tone = OP_RENDERERS[3];
    const std = tone.packParams([{ kind: 'profile', profile: 'neutral' }]);
    expect(std.length).toBe(TONE_LUT_SIZE * 3);
    // The standard look reproduces the old ACR-baseline single curve (all three
    // channels identical) -- the generic fallback for cameras we haven't fitted.
    expect(std[256]).toBeCloseTo(0.5475, 3);
    expect(std[512 + 256]).toBeCloseTo(0.5475, 3);
    expect(std[1024 + 256]).toBeCloseTo(0.5475, 3);
  });

  it("tone builds the per-channel film look when profile is a film stock (Portra 400)", () => {
    const tone = OP_RENDERERS[3];
    const film = tone.packParams([{ kind: 'profile', profile: 'portra400' }]);
    expect(film.length).toBe(TONE_LUT_SIZE * 3);
    // Per-channel: the film's H-D curves differ (gamma/d_min rise R<G<B), so
    // unlike camera/standard the three LUTs are NOT identical -- that IS the
    // stock's color character.
    const diff = (a: Float32Array, b: Float32Array) =>
      Array.from(a).some((v, i) => Math.abs(v - b[i]) > 1e-4);
    expect(diff(film.subarray(0, TONE_LUT_SIZE), film.subarray(TONE_LUT_SIZE, 2 * TONE_LUT_SIZE))).toBe(true);
    // Each channel LUT stays monotone (no tone inversion from the H-D + filmic).
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(film[ch * TONE_LUT_SIZE + i]).toBeGreaterThanOrEqual(film[ch * TONE_LUT_SIZE + i - 1]);
      }
    }
  });

  it('tone selects the requested stock -- each stock packs its own distinct LUT', () => {
    const tone = OP_RENDERERS[3];
    const portra = tone.packParams([{ kind: 'profile', profile: 'portra400' }]);
    const slide = tone.packParams([{ kind: 'profile', profile: 'ektachrome100' }]);
    const diff = (a: Float32Array, b: Float32Array) =>
      Array.from(a).some((v, i) => Math.abs(v - b[i]) > 1e-4);
    expect(diff(portra, slide)).toBe(true);
    // Index 256 is the log-domain midpoint (~lum 0.06, a shadow): the punchy
    // slide curve sits darker there than a soft negative -- the divergence IS
    // the stock's character. (Both anchor mid-gray at 0.39 -- the per-stock
    // exposure scale keeps a switch a look, not a re-exposure.)
    expect(slide[TONE_LUT_SIZE + 256]).toBeLessThan(portra[TONE_LUT_SIZE + 256]);
  });

  it('vignette packs 8 floats; neutral when absent, amount-driven when present', () => {
    const vignette = OP_RENDERERS[10];
    expect(vignette.kind).toBe('vignette');
    const absent = vignette.packParams([]);
    expect(absent.length).toBe(8);
    expect(absent[0]).toBe(0); // amount 0 = off
    expect(absent[1]).toBe(50); // LrC neutral midpoint
    expect(absent[3]).toBe(50); // LrC neutral feather
    const dark = vignette.packParams([
      { kind: 'vignette', amount: -60, midpoint: 40, roundness: 20, feather: 30, highlights: 10 },
    ]);
    // cropFrac defaults to (1,1) -- no crop op in the ops list.
    expect(Array.from(dark)).toEqual([-60, 40, 20, 30, 10, 1, 1, 0]);
  });

  it('dodgeBurn packs ev = amount/25; absent op is neutral (identity pass)', () => {
    const dodge = OP_RENDERERS[11];
    expect(dodge.kind).toBe('dodgeBurn');
    const absent = dodge.packParams([]);
    expect(Array.from(absent)).toEqual([0, 0, 0, 0]); // amount 0 = off
    const strong = dodge.packParams([
      { kind: 'dodgeBurn', amount: 75, size: 20, opacity: 50, feather: 0, mask: new Int8Array(4), maskW: 2, maskH: 2 },
    ]);
    expect(strong[0]).toBeCloseTo(3, 9); // 75/25 = 3 EV
  });

  it('bw packs mix + tone id + LUT; absent op is a neutral color no-op', () => {
    const bw = OP_RENDERERS[4];
    expect(bw.kind).toBe('bw');
    const absent = bw.packParams([]);
    expect(absent.length).toBe(8 + 4 + TONE_LUT_SIZE);
    expect(Array.from(absent.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(absent[8]).toBe(0); // 'none' id
    const acros = bw.packParams([{ kind: 'bw', mix: [40, 100, 20, 0, 0, 0, 0, 0], tone: 'acros' }]);
    expect(acros[0]).toBe(40);
    expect(acros[1]).toBe(100);
    expect(acros[8]).toBe(1); // 'acros' id
    expect(Array.from(acros.subarray(12))).toEqual(Array.from(buildBwToneLut('acros')));
  });

  it('grain packs amount/size/roughness + the current photo seed; absent op is neutral', () => {
    const grain = OP_RENDERERS[12];
    expect(grain.kind).toBe('grain');
    setGrainSeed(0.5);
    const absent = grain.packParams([]);
    expect(Array.from(absent)).toEqual([0, 25, 50, 0.5, 0, 0, 0, 0]);
    setGrainSeed(0.25);
    const strong = grain.packParams([{ kind: 'grain', amount: 60, size: 40, roughness: 80 }]);
    expect(Array.from(strong)).toEqual([60, 40, 80, 0.25, 0, 0, 0, 0]);
  });

  it('lightleak packs amount/hue + the shared photo seed; absent op is neutral', () => {
    const lightleak = OP_RENDERERS[8];
    expect(lightleak.kind).toBe('lightleak');
    setGrainSeed(0.5);
    const absent = lightleak.packParams([]);
    expect(Array.from(absent)).toEqual([0, 0, 0.5, 0, 0, 0, 0, 0]);
    setGrainSeed(0.75);
    const warm = lightleak.packParams([{ kind: 'lightleak', amount: 70, hue: 0 }]);
    expect(Array.from(warm)).toEqual([70, 0, 0.75, 0, 0, 0, 0, 0]);
  });

  it('frame packs the style id + cropFrac; absent op is the none identity', () => {
    const frame = OP_RENDERERS[13];
    expect(frame.kind).toBe('frame');
    // imageSize is unloaded in tests -> cropFrac defaults to (1,1).
    expect(Array.from(frame.packParams([]))).toEqual([3, 1, 1, 0]); // none = identity
    expect(Array.from(frame.packParams([{ kind: 'frame', style: '135' }]))).toEqual([0, 1, 1, 0]);
    expect(Array.from(frame.packParams([{ kind: 'frame', style: 'print' }]))).toEqual([2, 1, 1, 0]);
  });

  it('crop packs geometry for a 1:1 crop (fits the source dims)', () => {
    const crop = OP_RENDERERS[9];
    expect(crop.kind).toBe('crop');
    setImageSize(6000, 4000);
    const packed = crop.packParams([{ kind: 'crop', aspect: '1:1', rotate90: 0, angle: 0 }]);
    expect(packed.length).toBe(8);
    expect(packed[1]).toBe(1); // zoom
    expect(packed[2]).toBe(2000); // halfW
    expect(packed[3]).toBe(2000); // halfH
    setImageSize(0, 0);
  });

  it('geometry packs the homography uniform; absent op is identity', () => {
    const geometry = OP_RENDERERS[7];
    expect(geometry.kind).toBe('geometry');
    // Absent -> neutral defaults (all zero, scale 100 = 1.0), no-op pass.
    expect(Array.from(geometry.packParams([]))).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    // vertical 10 -> radians angle 0, scale 1, aspect 0, hp 0, vp 0.1, offset 0.
    const packed = Array.from(
      geometry.packParams([
        { kind: 'geometry', vertical: 10, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 },
      ]),
    );
    expect(packed[0]).toBeCloseTo(0, 9);
    expect(packed[1]).toBeCloseTo(1, 9);
    expect(packed[4]).toBeCloseTo(0.1, 6);
    expect(packed[5]).toBeCloseTo(0, 9);
    // rotate 30 -> 30° in radians.
    const rotated = geometry.packParams([
      { kind: 'geometry', vertical: 0, horizontal: 0, rotate: 30, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 },
    ]);
    expect(rotated[0]).toBeCloseTo(Math.PI / 6, 6);
  });

  it('toneCurve packs a LUT, identity when absent or linear', () => {
    const curve = OP_RENDERERS[5];
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
    const curve = OP_RENDERERS[5];
    const legacy = curve.packParams([
      { kind: 'toneCurve', points: [0, 0, 0.25, 0.4, 0.75, 0.7, 1, 1] } as Op,
    ]);
    expect(legacy[Math.floor(TONE_LUT_SIZE * 0.25)]).toBeGreaterThan(0.25);
    expect(legacy[Math.floor(TONE_LUT_SIZE * 0.75)]).toBeLessThan(0.75);
  });

  it('toneCurve region mode packs the parametric LUT, point/legacy unchanged', () => {
    const curve = OP_RENDERERS[5];
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
