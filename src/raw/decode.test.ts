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

    // Camera identity (EXIF Make/Model, LibRaw-normalized) -- the key the
    // per-camera WB-readout calibration registry matches on.
    expect(result.make).toBe('Fujifilm');
    expect(result.model).toBe('X100V');

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

// The majority-brand decode path (every Bayer-brand raw: Canon/Sony/Nikon/
// Panasonic/Olympus) shares the DNG loader -- the one path the test suite had
// zero coverage for before this fixture (all real fixtures are Fuji X-Trans).
// The fixture is generated by /private/tmp/make-bayer-dng.mjs (regenerate by
// re-running it): 64x48, uncompressed 16-bit, RGGB CFA, BlackLevel=512,
// WhiteLevel=16383, AsShotNeutral=[0.5,1,0.5], ColorMatrix1, Make/Model set
// to NIKON D800 so LibRaw's camera table engages like a real camera.
describe('decode: synthetic Bayer DNG', () => {
  it('decodes the RGGB DNG with exact levels/WB and 2x2-tiled CFA', async () => {
    const result = await decode(loadFixture('bayer.dng'));

    // 64x48, no sensor margins (unlike the X-Trans fixture's 6246x4170 crop).
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.effectiveWidth).toBe(64);
    expect(result.effectiveHeight).toBe(48);
    expect(result.leftMargin).toBe(0);
    expect(result.topMargin).toBe(0);

    // The raw strip is a smooth gradient up from black; top-left is R at
    // exactly black, the pixel to its right is G at 512 + (WHITE-BLACK)/112
    // = 654. Guards that the strip bytes land in place (raw copy, no
    // black subtraction, no off-by-row in the wrapper's pitch handling).
    expect(result.bayerData.length).toBe(64 * 48);
    expect(result.bayerData[0]).toBe(512);
    expect(result.bayerData[1]).toBe(654);

    // Black/white levels written into the DNG come back exactly.
    expect(result.blackLevel).toBe(512);
    expect(result.whiteLevel).toBe(16383);

    // 2x2 Bayer, RGGB. The 6x6 CFA is a pure tile of the 2x2 (rows 0 and 2
    // identical) -- the opposite of the X-Trans fixture, which is the whole
    // point: the same 6x6 lookup feeds both demosaic paths.
    expect(result.cfaPattern).toBe('RGGB');
    expect(result.cfa6.length).toBe(36);
    expect([...result.cfa6.slice(0, 6)]).toEqual([...result.cfa6.slice(12, 18)]);

    // AsShotNeutral [0.5, 1, 0.5] -> green-normalized gains r=2, g=1, b=2.
    expect(result.asShotGains).toEqual({ r: 2, g: 1, b: 2 });

    // Camera matrix present (Make/Model NIKON D800 -> LibRaw's adobe_coeff
    // table), row-normalized, not identity; cam_xyz rides alongside.
    expect(result.hasColorMatrix).toBe(true);
    expect(result.camXyz).toBeDefined();
    expect(result.colorMatrix.length).toBe(9);
    for (const row of [0, 3, 6]) {
      const sum = result.colorMatrix[row] + result.colorMatrix[row + 1] + result.colorMatrix[row + 2];
      expect(Math.abs(sum - 1)).toBeLessThan(0.05);
    }
    expect([...result.colorMatrix]).not.toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // No EXIF in the synthetic file: all metadata reads as "not reported" (0).
    expect(result.cameraMeta).toEqual({ iso: 0, shutter: 0, aperture: 0, focal: 0 });

    // Make/Model ARE written into the DNG (the generator sets NIKON D800 so
    // LibRaw's camera table engages) -- verified in the exact normalized form
    // LibRaw reports, which is what the WB-calibration key consumes.
    expect(result.make).toBe('Nikon');
    expect(result.model).toBe('D800');
  });
});
