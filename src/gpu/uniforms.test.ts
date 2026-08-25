import { describe, it, expect } from 'vitest';
import { evToGain, wbShiftToGains, packCfa6, packColorMatrix, kelvinToShift, shiftToKelvin, gainsToKelvin, gainsToTint, WB_NEUTRAL_KELVIN } from './uniforms';

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
