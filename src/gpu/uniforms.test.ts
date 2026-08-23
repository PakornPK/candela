import { describe, it, expect } from 'vitest';
import { evToGain, wbShiftToGains, packAdjustUniforms, packCfaPattern } from './uniforms';

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

describe('packCfaPattern', () => {
  it('maps RGGB to [0, 1, 1, 2]', () => {
    expect(Array.from(packCfaPattern('RGGB'))).toEqual([0, 1, 1, 2]);
  });

  it('throws on an unknown color letter', () => {
    expect(() => packCfaPattern('RGGX')).toThrow('Unknown CFA color');
  });

  it('throws on the wrong length', () => {
    expect(() => packCfaPattern('RGB')).toThrow('4-character');
  });
});
