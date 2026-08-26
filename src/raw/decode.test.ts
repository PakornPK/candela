import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decode, DecodeError } from './decode';

function loadFixture(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('decode', () => {
  it('decodes a real raw fixture into Bayer data with sane dimensions', async () => {
    const result = await decode(loadFixture('sample.raf'));

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.bayerData.length).toBe(result.width * result.height);
    expect(result.whiteLevel).toBeGreaterThan(result.blackLevel);
    expect(result.cfaPattern).toMatch(/^[RGB]{4}$/);
    // The full 6x6 CFA is always present, one byte per position.
    expect(result.cfa6.length).toBe(36);
    expect([...result.cfa6].every((c) => c === 0 || c === 1 || c === 2)).toBe(true);

    // The camera color matrix (LibRaw rgb_cam folded to a 3x3) is present
    // and sane: rows are row-normalized (sum to ~1), and it's not the
    // identity (the X100V has a real matrix). This exercises the new
    // wrapper accessors end-to-end on a real file.
    expect(result.hasColorMatrix).toBe(true);
    expect(result.colorMatrix.length).toBe(9);
    for (const row of [0, 3, 6]) {
      const sum = result.colorMatrix[row] + result.colorMatrix[row + 1] + result.colorMatrix[row + 2];
      expect(Math.abs(sum - 1)).toBeLessThan(0.05);
    }
    expect([...result.colorMatrix]).not.toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // cam_xyz (XYZ->camera) rides alongside -- the WB temp/tint readout
    // decomposes As-Shot gains through it (the LrC/DNG model), and the
    // uniform.test.ts pins calibrate against this exact matrix. Pinned to the
    // X100V's table entry in the vendored LibRaw (colordata.cpp:
    // { 13426,-6334,-1177,-4244,12136,2371,580,1303,5980 }).
    expect(result.camXyz).toBeDefined();
    expect([...result.camXyz!]).toEqual(
      [1.3426, -0.6334, -0.1177, -0.4244, 1.2136, 0.2371, 0.058, 0.1303, 0.598].map((v) => expect.closeTo(v, 1e-4)),
    );

    // Shooting metadata: the fixture is a real X100V exposure, so EXIF fills
    // all four. A value of 0 means "not reported" (the wrapper's sentinel),
    // so a photo that lacks one field stays valid -- but a real shot must
    // carry an ISO and an exposure time.
    expect(result.cameraMeta.iso).toBeGreaterThan(0);
    expect(result.cameraMeta.shutter).toBeGreaterThan(0);
    expect(result.cameraMeta.aperture).toBeGreaterThan(0);
    expect(result.cameraMeta.focal).toBeGreaterThan(0);

    // As-Shot WB: a real camera reports cam_mul, so asShotGains is present,
    // green-normalized (g=1), and not the flat neutral (1,1,1) -- a daylight
    // shot of a real scene needs real WB multipliers. Exercises the new
    // cam_mul wrapper accessors + DataView read + green normalization
    // end-to-end. The exact values are EXIF-verified: this X100V records
    // WB_GRBLevels [G=302, R=567, B=560], so R/G=567/302 and B/G=560/302.
    // The regression this locks in: Fuji stores WB as 3 values, so cam_mul's
    // G2 is 0 -- a naive (G1+G2)/2 average halves green and doubles the R/B
    // gains (a 2x warm cast vs the camera's actual WB).
    expect(result.asShotGains).toBeDefined();
    expect(result.asShotGains!.g).toBe(1);
    expect(result.asShotGains!.r).toBeCloseTo(567 / 302, 5);
    expect(result.asShotGains!.b).toBeCloseTo(560 / 302, 5);
  });

  it('reports a 6x6 CFA for the X-Trans fixture (not an all-G 2x2 tile)', async () => {
    const result = await decode(loadFixture('sample.raf'));

    // X-Trans 6x6: every color appears in the 36-entry pattern (the old 2x2
    // packing rendered this file as all-G, which is the root cause of the
    // speckled X-Trans render -- the demosaic classified every pixel as
    // green).
    const codes = new Set(result.cfa6);
    expect(codes.has(0)).toBe(true); // R
    expect(codes.has(1)).toBe(true); // G
    expect(codes.has(2)).toBe(true); // B
    // The 2x2 string covers positions (0,0),(0,1),(1,0),(1,1); cfa6 is
    // row-major 6x6, so those four map to indices 0, 1, 6, 7 (GGGG for this
    // file -- the X-Trans pattern starts G G / G G).
    const codesByChar: Record<string, number> = { R: 0, G: 1, B: 2 };
    const expected = [...result.cfaPattern].map((ch) => codesByChar[ch]);
    expect([result.cfa6[0], result.cfa6[1], result.cfa6[6], result.cfa6[7]]).toEqual(expected);
    // The pattern is genuinely 6x6-periodic, not a 2x2 tile: row 0 differs
    // from row 2 somewhere (a 2x2 tile would have rows 0 and 2 identical).
    const row0 = [...result.cfa6.slice(0, 6)];
    const row2 = [...result.cfa6.slice(12, 18)];
    expect(row0).not.toEqual(row2);
  });

  it('rejects a garbage buffer with a DecodeError', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(decode(garbage)).rejects.toBeInstanceOf(DecodeError);
  });
});
