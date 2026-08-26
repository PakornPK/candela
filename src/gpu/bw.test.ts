import { describe, it, expect } from 'vitest';
import {
  BW_BAND_CENTERS,
  BW_FILTERS,
  BW_TONES,
  bandWeight,
  buildBwToneLut,
  bwLuminance,
  isNeutralBw,
  packBw,
} from './bw';
import { LUMA_WEIGHTS, TONE_LUT_SIZE } from './tone';
import type { BwMix } from '../catalog/types';

const NEUTRAL: BwMix = [0, 0, 0, 0, 0, 0, 0, 0];

describe('bandWeight', () => {
  it('returns the band value at its center and interpolates between centers', () => {
    const mix: BwMix = [100, 0, 0, 0, 0, 0, 0, 0];
    expect(bandWeight(0, mix)).toBe(100); // red center
    expect(bandWeight(30, mix)).toBe(0); // orange center
    // Halfway red(0)=100 -> orange(30)=0 is 50.
    expect(bandWeight(15, mix)).toBeCloseTo(50, 5);
  });

  it('wraps the magenta->red gap (300 -> 360 = red)', () => {
    const mix: BwMix = [100, 0, 0, 0, 0, 0, 0, 0];
    expect(bandWeight(300, mix)).toBe(0); // magenta center
    expect(bandWeight(359.9, mix)).toBeGreaterThan(99); // lerping toward red
    expect(bandWeight(360, mix)).toBe(100); // h=360 lands exactly on red
  });

  it('handles the sparse green->aqua span by lerping across it', () => {
    const mix: BwMix = [0, 0, 0, 100, 0, 0, 0, 0];
    expect(bandWeight(90, mix)).toBe(100); // green center
    expect(bandWeight(135, mix)).toBeCloseTo(50, 5); // midway to aqua(180)=0
  });

  it('is neutral everywhere for the neutral mix', () => {
    for (const h of [0, 45, 120, 200, 330]) expect(bandWeight(h, NEUTRAL)).toBe(0);
  });
});

describe('bwLuminance', () => {
  it('a neutral mix is an exact desaturation (plain luma)', () => {
    const rgb: [number, number, number] = [0.4, 0.2, 0.6];
    const lum = LUMA_WEIGHTS[0] * rgb[0] + LUMA_WEIGHTS[1] * rgb[1] + LUMA_WEIGHTS[2] * rgb[2];
    expect(bwLuminance(rgb, NEUTRAL)).toBeCloseTo(lum, 10);
  });

  it('a positive band weight brightens that hue, negative darkens it', () => {
    const red: [number, number, number] = [1, 0, 0];
    const bright: BwMix = [100, 0, 0, 0, 0, 0, 0, 0];
    const dark: BwMix = [-100, 0, 0, 0, 0, 0, 0, 0];
    const base = bwLuminance(red, NEUTRAL);
    expect(bwLuminance(red, bright)).toBeGreaterThan(base);
    expect(bwLuminance(red, dark)).toBeLessThan(base);
  });

  it("another hue's weight leaves this pixel's band alone", () => {
    const blue: [number, number, number] = [0, 0, 1];
    const redBoost: BwMix = [100, 0, 0, 0, 0, 0, 0, 0];
    expect(bwLuminance(blue, redBoost)).toBeCloseTo(bwLuminance(blue, NEUTRAL), 10);
  });

  it('neutral (gray) pixels are never touched by any mix', () => {
    const gray: [number, number, number] = [0.3, 0.3, 0.3];
    const wild: BwMix = [100, -100, 100, -100, 100, -100, 100, -100];
    expect(bwLuminance(gray, wild)).toBeCloseTo(0.3, 6);
  });
});

describe('buildBwToneLut', () => {
  it("'none' is an exact identity", () => {
    const lut = buildBwToneLut('none');
    expect(lut.length).toBe(TONE_LUT_SIZE);
    expect(lut[256]).toBeCloseTo(256 / (TONE_LUT_SIZE - 1), 6);
    expect(lut[Math.floor(TONE_LUT_SIZE * 0.7)]).toBeCloseTo(0.7, 2);
  });

  it('every mono tone is a distinct, non-identity, monotone curve', () => {
    const identity = buildBwToneLut('none');
    for (const tone of ['acros', 'tx400', 'doublex', 'leica'] as const) {
      const lut = buildBwToneLut(tone);
      expect(lut.length).toBe(TONE_LUT_SIZE);
      // Not identity somewhere in the midtones.
      expect(Math.abs(lut[256] - 256 / (TONE_LUT_SIZE - 1))).toBeGreaterThan(1e-4);
      // Monotone -- the mono tone never inverts.
      for (let i = 1; i < TONE_LUT_SIZE; i++) {
        expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
      }
      expect(Array.from(lut)).not.toEqual(Array.from(identity));
    }
    expect(Array.from(buildBwToneLut('acros'))).not.toEqual(Array.from(buildBwToneLut('tx400')));
  });

  it('every stock\'s control points are monotone in display space (authoring sanity)', () => {
    for (const id of ['acros', 'tx400', 'doublex', 'leica'] as const) {
      const p = BW_TONES[id].points;
      let prevX = -1, prevY = -1;
      for (let i = 0; i < p.length; i += 2) {
        expect(p[i]).toBeGreaterThan(prevX);
        expect(p[i + 1]).toBeGreaterThanOrEqual(prevY);
        prevX = p[i];
        prevY = p[i + 1];
      }
    }
  });
});

describe('packBw', () => {
  it('packs mix (8) + tone id (4) + LUT (512) = 524 floats in the shader layout', () => {
    const packed = packBw({ mix: NEUTRAL, tone: 'none' });
    expect(packed.length).toBe(8 + 4 + TONE_LUT_SIZE);
    expect(Array.from(packed.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(packed[8]).toBe(0); // 'none' id
    expect(packed[11]).toBe(0); // pad
    expect(packed[12]).toBeCloseTo(0, 10); // lut[0]
    expect(packed[12 + 256]).toBeCloseTo(256 / (TONE_LUT_SIZE - 1), 6);
  });

  it('carries the mix values and the tone id verbatim', () => {
    const packed = packBw({ mix: [50, -30, 0, 0, 0, 0, 0, 20], tone: 'acros' });
    expect(packed[0]).toBe(50);
    expect(packed[1]).toBe(-30);
    expect(packed[7]).toBe(20);
    expect(packed[8]).toBe(1); // 'acros' id
    expect(Array.from(packed.subarray(12))).toEqual(Array.from(buildBwToneLut('acros')));
  });
});

describe('isNeutralBw', () => {
  it('is neutral only when every mix is 0 and tone is none', () => {
    expect(isNeutralBw({ mix: NEUTRAL, tone: 'none' })).toBe(true);
    expect(isNeutralBw({ mix: [0, 0, 0, 0, 0, 0, 0, 0], tone: 'acros' })).toBe(false);
    expect(isNeutralBw({ mix: [10, 0, 0, 0, 0, 0, 0, 0], tone: 'none' })).toBe(false);
  });
});

describe('BW_FILTERS', () => {
  it('every filter preset is a valid 8-element mix', () => {
    for (const id of Object.keys(BW_FILTERS) as Array<keyof typeof BW_FILTERS>) {
      expect(BW_FILTERS[id]).toHaveLength(8);
      expect(BW_FILTERS[id].every((v) => v >= -100 && v <= 100)).toBe(true);
    }
    // The classic orange filter boosts reds/oranges and lets blues drop.
    expect(BW_FILTERS.orange[0]).toBeGreaterThan(0);
    expect(BW_FILTERS.orange[5]).toBeLessThanOrEqual(0);
  });
});

describe('BW_BAND_CENTERS', () => {
  it('is 8 ascending centers starting at red (0)', () => {
    expect(BW_BAND_CENTERS[0]).toBe(0);
    expect(BW_BAND_CENTERS).toHaveLength(8);
    for (let i = 1; i < BW_BAND_CENTERS.length; i++) {
      expect(BW_BAND_CENTERS[i]).toBeGreaterThan(BW_BAND_CENTERS[i - 1]);
    }
  });
});
