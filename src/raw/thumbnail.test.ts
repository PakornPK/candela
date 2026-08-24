import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractThumbnail, ThumbnailError } from './thumbnail';

function loadFixture(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('extractThumbnail', () => {
  it('extracts a JPEG-format embedded thumbnail from a real raw fixture', async () => {
    const blob = await extractThumbnail(loadFixture('sample.raf'));
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(0);
    // A real JPEG always starts with the SOI marker 0xFFD8.
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(Array.from(header)).toEqual([0xff, 0xd8]);
  });

  it('rejects a garbage buffer with a ThumbnailError', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(extractThumbnail(garbage)).rejects.toBeInstanceOf(ThumbnailError);
  });
});
