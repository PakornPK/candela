import { describe, it, expect } from 'vitest';
import { geometryMap, isNeutralGeometry, packGeometry, type GeometryParams } from './geometry';

const NEUTRAL: GeometryParams = { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 };

describe('isNeutralGeometry', () => {
  it('is true only for all-zero params with scale 100', () => {
    expect(isNeutralGeometry(NEUTRAL)).toBe(true);
    expect(isNeutralGeometry({ ...NEUTRAL, vertical: 1 })).toBe(false);
    expect(isNeutralGeometry({ ...NEUTRAL, scale: 99 })).toBe(false);
    expect(isNeutralGeometry({ ...NEUTRAL, offsetX: 0.5 })).toBe(false);
  });
});

describe('geometryMap', () => {
  it('is the identity for neutral params', () => {
    for (const u of [-1, -0.3, 0, 0.7, 1]) {
      for (const v of [-1, -0.2, 0, 0.4, 1]) {
        const [su, sv] = geometryMap(NEUTRAL, u, v);
        expect(su).toBeCloseTo(u, 9);
        expect(sv).toBeCloseTo(v, 9);
      }
    }
  });

  it('positive vertical pulls the bottom toward the source center (top-wide trapezoid)', () => {
    const p = { ...NEUTRAL, vertical: 10 };
    // Bottom edge samples closer to center: srcV < v.
    const [, bv] = geometryMap(p, 0, 0.9);
    expect(bv).toBeCloseTo(0.9 / 1.09, 6);
    expect(bv).toBeLessThan(0.9);
    // Top edge samples wider: |srcV| > |v|.
    const [, tv] = geometryMap(p, 0, -0.9);
    expect(tv).toBeCloseTo(-0.9 / 0.91, 6);
    expect(Math.abs(tv)).toBeGreaterThan(0.9);
  });

  it('positive horizontal pulls the right toward the source center', () => {
    const p = { ...NEUTRAL, horizontal: 10 };
    const [ru] = geometryMap(p, 0.9, 0);
    expect(ru).toBeCloseTo(0.9 / 1.09, 6);
    expect(ru).toBeLessThan(0.9);
    const [lu] = geometryMap(p, -0.9, 0);
    expect(Math.abs(lu)).toBeGreaterThan(0.9);
  });

  it('positive rotate turns the image clockwise: output bottom shows the source left edge', () => {
    const p = { ...NEUTRAL, rotate: 90 };
    // (0, +1) bottom edge -> source (-1, 0) left edge.
    const [su, sv] = geometryMap(p, 0, 1);
    expect(su).toBeCloseTo(-1, 6);
    expect(sv).toBeCloseTo(0, 6);
    // (1, 0) right edge -> source (0, +1) bottom edge.
    const [ru, rv] = geometryMap(p, 1, 0);
    expect(ru).toBeCloseTo(0, 6);
    expect(rv).toBeCloseTo(1, 6);
  });

  it('scale 200 zooms in 2x: output 0.5 samples source 1.0', () => {
    const [su] = geometryMap({ ...NEUTRAL, scale: 200 }, 0.5, 0);
    expect(su).toBeCloseTo(1, 6);
  });

  it('positive offsetX shifts the image right; positive offsetY shifts it down', () => {
    const [xu] = geometryMap({ ...NEUTRAL, offsetX: 100 }, 1, 0);
    expect(xu).toBeCloseTo(0, 6); // right edge now shows the source center
    const [, yv] = geometryMap({ ...NEUTRAL, offsetY: 100 }, 0, 1);
    expect(yv).toBeCloseTo(0, 6); // bottom edge now shows the source center
  });
});

describe('packGeometry', () => {
  it('packs 8 floats matching the WGSL Geometry struct (radians, scale/100, /100)', () => {
    expect(Array.from(packGeometry(NEUTRAL))).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    const p = packGeometry({ vertical: 10, horizontal: 20, rotate: 30, aspect: 40, scale: 150, offsetX: 5, offsetY: -6 });
    expect(p[0]).toBeCloseTo(Math.PI / 6, 6);
    expect(p[1]).toBeCloseTo(1.5, 9);
    expect(p[2]).toBeCloseTo(0.4, 6);
    expect(p[3]).toBeCloseTo(0.2, 6);
    expect(p[4]).toBeCloseTo(0.1, 6);
    expect(p[5]).toBeCloseTo(0.05, 6);
    expect(p[6]).toBeCloseTo(-0.06, 6);
    expect(p[7]).toBe(0);
  });
});
