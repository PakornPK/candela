import { describe, it, expect } from 'vitest';
import { evToGain, wbShiftToGains, packCfa6, shiftCfa6, packColorMatrix, kelvinToShift, shiftToKelvin, gainsToKelvin, gainsToTint, xyToCctAndTint, WB_NEUTRAL_KELVIN } from './uniforms';

// LibRaw's cam_xyz (XYZ->camera) for the Fuji X100V, as decoded from the
// fixture -- the exact matrix the LrC-model readout decomposes As-Shot gains
// through. Pinned in decode.test.ts against the real file; this is its
// Float32Array copy.
const FUJI_CAM_XYZ = new Float32Array([
  1.3425999879837036, -0.633400022983551, -0.1177000030875206,
  -0.4244000017642975, 1.2136000394821167, 0.2371000051498413,
  0.057999998331069946, 0.13030000030994415, 0.5979999899864197,
]);
const FUJI_GAINS = { r: 567 / 302, g: 1, b: 560 / 302 };
// The real compared file (DSCF8946.RAF, same X100V cam_xyz) -- the user's
// current LrC measurement (5350 K / +35). Decoded via the probe, 2026-08-26.
const REAL_GAINS = { r: 1.8344370860927153, g: 1, b: 1.8211920529801324 };

describe('evToGain', () => {
  it('returns 1 at EV 0', () => {
    expect(evToGain(0)).toBe(1);
  });

  it('doubles at EV +1 and halves at EV -1', () => {
    expect(evToGain(1)).toBeCloseTo(2);
    expect(evToGain(-1)).toBeCloseTo(0.5);
  });
});

describe('wbShiftToGains', () => {
  it('returns equal gains at shift 0 and tint 0', () => {
    expect(wbShiftToGains(0)).toEqual({ rGain: 1, gGain: 1, bGain: 1 });
  });

  it('boosts red and cuts blue for positive shift, green unchanged', () => {
    const { rGain, gGain, bGain } = wbShiftToGains(1);
    expect(rGain).toBeGreaterThan(1);
    expect(bGain).toBeLessThan(1);
    expect(gGain).toBe(1);
  });

  it('cuts green (magenta) for positive tint, boosts green for negative', () => {
    expect(wbShiftToGains(0, 100).gGain).toBeLessThan(1); // magenta
    expect(wbShiftToGains(0, -100).gGain).toBeGreaterThan(1); // green
    // tint/150 * exponent 2: +50 -> 2^-0.667 = 0.63.
    expect(wbShiftToGains(0, 50).gGain).toBeCloseTo(0.63, 2);
  });

  it('clamps shift outside [-1, 1]', () => {
    expect(wbShiftToGains(5)).toEqual(wbShiftToGains(1));
    expect(wbShiftToGains(-5)).toEqual(wbShiftToGains(-1));
  });
});

describe('packCfa6', () => {
  it('emits one u32 per CFA position (matches array<vec4<u32>, 9> layout)', () => {
    const cfa6 = new Uint8Array(36);
    for (let i = 0; i < 36; i++) cfa6[i] = i % 3;
    const packed = packCfa6(cfa6);
    expect(packed).toBeInstanceOf(Uint32Array);
    // 36 u32s = 144 bytes, the full size of the 9xvec4 uniform buffer.
    expect(packed.length).toBe(36);
    // Each component of each vec4 holds exactly one color code, so
    // demosaic.wgsl's colorAt (pattern[i/4][i%4]) reads a single color.
    for (let i = 0; i < 36; i++) {
      expect(packed[i]).toBe(i % 3);
    }
  });

  it('throws on the wrong length', () => {
    expect(() => packCfa6(new Uint8Array(35))).toThrow('36');
  });
});

describe('shiftCfa6 (effective-area crop re-indexes the CFA pattern)', () => {
  const ramp = new Uint8Array(36); // position i -> i%3, so row r col c -> (r+ c)%3
  for (let i = 0; i < 36; i++) ramp[i] = i % 3;

  it('is a no-op for crop offsets that are whole pattern periods (X-Trans top=6)', () => {
    expect(Array.from(shiftCfa6(ramp, 0, 6))).toEqual(Array.from(ramp));
  });

  it('re-indexes so texture pixel (x,y) reads the source pattern at (x+left, y+top)', () => {
    const shifted = shiftCfa6(ramp, 1, 2);
    // Texture pixel (3,4) = source (3+1, 4+2) -> pattern[(6%6)*6 + (4%6)] = pattern[4].
    expect(shifted[4 * 6 + 3]).toBe(ramp[(6 % 6) * 6 + (4 % 6)]);
    expect(shifted[0]).toBe(ramp[(2 % 6) * 6 + (1 % 6)]); // (0,0) -> source (1,2)
  });

  it('is length-preserving (36)', () => {
    expect(shiftCfa6(ramp, 3, 5).length).toBe(36);
  });
});

describe('kelvinToShift', () => {
  it('returns 0 at the neutral point', () => {
    expect(kelvinToShift(WB_NEUTRAL_KELVIN)).toBe(0);
  });

  it('scales to +1/-1 at the ends of the Kelvin range (2000..50000K)', () => {
    expect(kelvinToShift(2000)).toBeCloseTo(-1); // cool end
    expect(kelvinToShift(50000)).toBeCloseTo(1); // warm end
    expect(kelvinToShift(10000)).toBeGreaterThan(0); // above neutral stays warm
  });

  it('shiftToKelvin is the exact inverse', () => {
    for (const k of [2000, 3500, 5500, 9000, 15000, 50000]) {
      expect(shiftToKelvin(kelvinToShift(k))).toBeCloseTo(k, 0);
    }
    // Clamped at the extremes like the forward direction.
    expect(shiftToKelvin(5)).toBeCloseTo(shiftToKelvin(1), 0);
    expect(shiftToKelvin(-5)).toBeCloseTo(shiftToKelvin(-1), 0);
  });
});

describe('gainsToKelvin / gainsToTint (As-Shot WB readout)', () => {
  it('a pure-temperature pair round-trips to its kelvin', () => {
    // gains from wbShiftToGains(+0.5): r=2^0.5, b=2^-0.5, product 1 -> no tint.
    const g = { r: Math.pow(2, 0.5), g: 1, b: Math.pow(2, -0.5) };
    expect(gainsToKelvin(g)).toBeCloseTo(shiftToKelvin(0.5), 0);
    expect(gainsToTint(g)).toBeCloseTo(0, 1);
  });

  it('an r/b-imbalanced pair reads the temp from the ratio and tint from the residual', () => {
    // Both R and B above green: strong red ratio (warm) AND a magenta cast.
    const g = { r: 2.1, g: 1, b: 1.4 };
    const kelvin = gainsToKelvin(g);
    expect(kelvin).toBeGreaterThan(WB_NEUTRAL_KELVIN); // r > b -> warm
    // product r*b = 2.94 > 1 -> both channels cut green -> +tint.
    const tint = gainsToTint(g);
    expect(tint).toBeGreaterThan(0);
    // A green-cast pair (both below green) reads the same temp but -tint.
    const cool = { r: 0.7, g: 1, b: 0.9 };
    expect(gainsToKelvin(cool)).toBeLessThan(WB_NEUTRAL_KELVIN);
    expect(gainsToTint(cool)).toBeLessThan(0);
  });

  it('pins the real compared file through the LrC model -- the "WB readout ≠ LrC" fix (5350K / +35)', () => {
    // The exact As-Shot gains the app opens DSCF8946.RAF at (probe-decoded
    // 2026-08-26), decomposed through the X100V's cam_xyz + the re-fit offsets
    // to land on the user's LrC measurement, 5350K / +35 -- the repro for
    // "temp 5408 vs 5350, tint +29 vs +35" is closed. The render keeps the
    // exact gains regardless; only the readout is calibrated here.
    expect(gainsToKelvin(REAL_GAINS, FUJI_CAM_XYZ)).toBeCloseTo(5350, 1);
    expect(gainsToTint(REAL_GAINS, FUJI_CAM_XYZ)).toBeCloseTo(35, 1);
  });

  it('falls back to the legacy R/B-ratio axes when no camera matrix is available', () => {
    // Same gains, no cam_xyz: the pre-calibration decomposition (5544K /
    // +67.5). Kept as the fallback pin -- a camera with no usable matrix
    // (hasColorMatrix false) still gets a sane readout.
    expect(gainsToKelvin(FUJI_GAINS)).toBeCloseTo(5544.2, 1);
    expect(gainsToTint(FUJI_GAINS)).toBeCloseTo(67.5, 1);
  });
});

describe('xyToCctAndTint (Robertson 1968)', () => {
  it('reads the canonical D65 white point as ~6504K with a small magenta tint', () => {
    const { kelvin, tint } = xyToCctAndTint(0.3127, 0.329);
    expect(kelvin).toBeCloseTo(6503.7, 0);
    expect(tint).toBeCloseTo(9.8, 0);
  });

  it('reads the canonical Illuminant A white point as ~2855K, neutral tint', () => {
    const { kelvin, tint } = xyToCctAndTint(0.4476, 0.4074);
    expect(kelvin).toBeCloseTo(2854.9, 0);
    expect(tint).toBeCloseTo(-0.1, 0);
  });

  it('returns the neutral readout for non-finite input (safety)', () => {
    expect(xyToCctAndTint(NaN, NaN)).toEqual({ kelvin: WB_NEUTRAL_KELVIN, tint: 0 });
  });
});

describe('packColorMatrix', () => {
  it('pads a 3x3 to 3 vec4s (matches ColorMat in cameraColor.wgsl)', () => {
    const m = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const packed = packColorMatrix(m);
    expect(packed.length).toBe(12);
    expect(Array.from(packed)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('throws on the wrong length', () => {
    expect(() => packColorMatrix(new Float32Array(8))).toThrow('9');
  });
});
