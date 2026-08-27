// Minimal 16-bit export encoders. The browser canvas only produces 8-bit
// output (`putImageData` -> `toBlob`), so 16-bit downloads are hand-encoded
// here: PNG (RGBA, zlib via CompressionStream) and TIFF (RGB, uncompressed).
// Both are pure + unit-tested; the GPU side feeds them the rgba16uint readback
// as a native little-endian Uint16Array.
//
// ponytail: TIFF is uncompressed and PNG is single-IDAT (fine at these sizes;
// add zlib-compressed TIFF via raw-deflate + multi-strip at 100MP+).

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); // PNG is big-endian
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(new TextEncoder().encode(type));
  crcBuf.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}

// rgba16uint (native LE u16/chan) -> big-endian RGBA scanlines, zlib-compressed
// IDAT. CompressionStream is async, hence the Promise.
export async function encodePng16(data: Uint16Array, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // Scanlines: 1 filter byte + BE u16 samples.
  const raw = new Uint8Array(height * (1 + width * 8));
  const rv = new DataView(raw.buffer);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 8);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) rv.setUint16(row + 1 + (x * 4 + ch) * 2, data[px + ch]);
    }
  }
  const cs = new CompressionStream('deflate');
  const compressed = await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer();
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(compressed)), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// RGB u16 little-endian TIFF, uncompressed single strip. The rgba16uint
// readback is native LE, so pixels copy straight across (drop alpha).
export function encodeTiff16(data: Uint16Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const BPS = 122; // BitsPerSample array (3 SHORTs)
  const PIX = 128; // pixel strip, 4-aligned
  const ENTRIES = 9;
  const buf = new Uint8Array(PIX + width * height * 6);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49;
  buf[1] = 0x49; // "II" little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true); // IFD offset
  dv.setUint16(8, ENTRIES, true);
  const entry = (i: number, tag: number, type: number, count: number, value: number) => {
    const o = 10 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    dv.setUint32(o + 8, value, true);
  };
  entry(0, 256, 4, 1, width);                       // ImageWidth
  entry(1, 257, 4, 1, height);                      // ImageLength
  entry(2, 258, 3, 3, BPS);                         // BitsPerSample -> [16,16,16]
  entry(3, 259, 3, 1, 1);                           // Compression: none
  entry(4, 262, 3, 1, 2);                           // Photometric: RGB
  entry(5, 273, 4, 1, PIX);                         // StripOffsets
  entry(6, 277, 3, 1, 3);                           // SamplesPerPixel
  entry(7, 278, 4, 1, height);                      // RowsPerStrip
  entry(8, 279, 4, 1, width * height * 6);          // StripByteCounts
  dv.setUint32(10 + ENTRIES * 12, 0, true);         // next IFD: none
  dv.setUint16(BPS, 16, true);
  dv.setUint16(BPS + 2, 16, true);
  dv.setUint16(BPS + 4, 16, true);
  let o = PIX;
  for (let i = 0; i < width * height; i++) {
    const px = i * 4;
    dv.setUint16(o, data[px], true);
    dv.setUint16(o + 2, data[px + 1], true);
    dv.setUint16(o + 4, data[px + 2], true);
    o += 6;
  }
  return buf;
}
