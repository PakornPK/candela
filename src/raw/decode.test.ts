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
  });

  it('rejects a garbage buffer with a DecodeError', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(decode(garbage)).rejects.toBeInstanceOf(DecodeError);
  });
});
