import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { crc32, encodePng16, encodeTiff16 } from './exportEncode';

// 2x1 RGBA u16 (native LE). A white pixel and a mid-gray pixel.
function samplePixels(): Uint16Array {
  return new Uint16Array([
    65535, 0, 0, 65535, // pure red (so a byte swap is visible in the R channel)
    32768, 32768, 32768, 65535, // 50% gray
  ]);
}

function readChunks(png: Uint8Array): { type: string; data: Uint8Array; start: number }[] {
  const dv = new DataView(png.buffer);
  const chunks: { type: string; data: Uint8Array; start: number }[] = [];
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = new TextDecoder().decode(png.subarray(o + 4, o + 8));
    chunks.push({ type, data: png.subarray(o + 8, o + 8 + len), start: o });
    o += 12 + len;
  }
  return chunks;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('encodePng16', () => {
  it('produces a well-formed 16-bit RGBA PNG whose IDAT round-trips to BE scanlines', async () => {
    const png = await encodePng16(samplePixels(), 2, 1);
    // Signature.
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    // IHDR: 2x1, 16-bit, RGBA. (data is a subarray view -- read within it.)
    const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, chunks[0].data.byteLength);
    expect(ihdr.getUint32(0)).toBe(2);
    expect(ihdr.getUint32(4)).toBe(1);
    expect(chunks[0].data[8]).toBe(16);
    expect(chunks[0].data[9]).toBe(6);

    // Every chunk CRC is correct (type + data), stored big-endian after data.
    for (const c of chunks) {
      const typeAndData = new Uint8Array(4 + c.data.length);
      typeAndData.set(new TextEncoder().encode(c.type));
      typeAndData.set(c.data, 4);
      expect(crc32(typeAndData)).toBe(new DataView(png.buffer).getUint32(c.start + 8 + c.data.length));
    }

    // IDAT inflates to: filter byte 0 + 2px x 4chan x 2 bytes, BIG-endian.
    const raw = inflateSync(chunks[1].data);
    expect(raw.length).toBe(1 + 2 * 4 * 2);
    const rdv = new DataView(raw.buffer);
    expect(raw[0]).toBe(0);
    expect(rdv.getUint16(1)).toBe(65535); // R=65535 stays 0xFF 0xFF in BE
    expect(rdv.getUint16(3)).toBe(0); // G=0
    expect(rdv.getUint16(9)).toBe(32768); // gray R=32768
  });
});

describe('encodeTiff16', () => {
  it('produces a little-endian 16-bit RGB TIFF with correct IFD + strip', () => {
    const tiff = encodeTiff16(samplePixels(), 2, 1);
    const dv = new DataView(tiff.buffer);
    expect(tiff[0]).toBe(0x49); // "II"
    expect(tiff[1]).toBe(0x49);
    expect(dv.getUint16(2, true)).toBe(42);
    expect(dv.getUint32(4, true)).toBe(8); // IFD at 8
    expect(dv.getUint16(8, true)).toBe(9); // 9 entries
    const entry = (i: number) => {
      const o = 10 + i * 12;
      return { tag: dv.getUint16(o, true), type: dv.getUint16(o + 2, true), count: dv.getUint32(o + 4, true), value: dv.getUint32(o + 8, true) };
    };
    expect(entry(0)).toMatchObject({ tag: 256, value: 2 }); // width
    expect(entry(1)).toMatchObject({ tag: 257, value: 1 }); // height
    expect(entry(2)).toMatchObject({ tag: 258, value: 122 }); // BitsPerSample at 122
    expect(dv.getUint16(122, true)).toBe(16);
    expect(dv.getUint16(126, true)).toBe(16);
    expect(entry(3)).toMatchObject({ tag: 259, value: 1 }); // no compression
    expect(entry(4)).toMatchObject({ tag: 262, value: 2 }); // RGB
    expect(entry(5)).toMatchObject({ tag: 273, value: 128 }); // strip at 128
    expect(entry(6)).toMatchObject({ tag: 277, value: 3 }); // 3 samples/px
    expect(entry(8)).toMatchObject({ tag: 279, value: 2 * 1 * 6 }); // byte count
    // Strip: RGB interleaved u16 LE, alpha dropped.
    expect(dv.getUint16(128, true)).toBe(65535);
    expect(dv.getUint16(130, true)).toBe(0);
    expect(dv.getUint16(136, true)).toBe(32768); // second pixel's R
    expect(tiff.length).toBe(128 + 2 * 1 * 6);
  });
});
