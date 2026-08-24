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
