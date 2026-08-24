import { describe, it, expect } from 'vitest';
import { evToGain, wbShiftToGains, packAdjustUniforms, packCfa6, kelvinToShift, WB_NEUTRAL_KELVIN } from './uniforms';

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
  it('returns equal gains at shift 0', () => {
    expect(wbShiftToGains(0)).toEqual({ rGain: 1, bGain: 1 });
  });

  it('boosts red and cuts blue for positive shift', () => {
    const { rGain, bGain } = wbShiftToGains(1);
    expect(rGain).toBeGreaterThan(1);
    expect(bGain).toBeLessThan(1);
  });

  it('clamps shift outside [-1, 1]', () => {
    expect(wbShiftToGains(5)).toEqual(wbShiftToGains(1));
    expect(wbShiftToGains(-5)).toEqual(wbShiftToGains(-1));
  });
});

describe('packAdjustUniforms', () => {
  it('produces a 4-float array matching the WGSL Adjust struct layout', () => {
    const packed = packAdjustUniforms({ exposureEV: 0, wbShift: 0 });
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed.length).toBe(4);
    expect(packed[0]).toBe(1); // exposureGain
    expect(packed[1]).toBe(1); // rGain
    expect(packed[2]).toBe(1); // bGain
  });
});

describe('packCfa6', () => {
  it('packs 36 colors into 9 u32s, 4 per word, low byte first', () => {
    // 36 entries: codes 0..2 repeating (RGGB tile would be 0,1,1,2).
    const cfa6 = new Uint8Array(36);
    for (let i = 0; i < 36; i++) cfa6[i] = i % 3;
    const packed = packCfa6(cfa6);
    expect(packed).toBeInstanceOf(Uint32Array);
    expect(packed.length).toBe(9);
    // Word 0 = entries 0..3 = codes 0,1,2,0 -> byte 0=0, byte 1=1, byte 2=2,
    // byte 3=0, little-endian byte order in the word: 0x00020100.
    expect(packed[0]).toBe(0x00020100);
    // Last word = entries 32..35 = codes 2,0,1,2 -> 0x02010002.
    expect(packed[8]).toBe(0x02010002);
  });

  it('round-trips the packing order (entry i lands in word i/4, byte i%4)', () => {
    const cfa6 = new Uint8Array(36);
    for (let i = 0; i < 36; i++) cfa6[i] = (i * 7) % 3;
    const packed = packCfa6(cfa6);
    for (let i = 0; i < 36; i++) {
      expect((packed[i >> 2] >> ((i & 3) * 8)) & 0xff).toBe(cfa6[i]);
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

  it('scales to +1/-1 at the ends of the Kelvin range', () => {
    expect(kelvinToShift(9000)).toBeCloseTo(1);
    expect(kelvinToShift(2000)).toBeCloseTo(-1);
  });
});
