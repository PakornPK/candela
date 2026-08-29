// Vendors real (no-watermark) film-frame photos into the committed strip
// textures the frame shader samples (public/frames/{135,120,print}-strip.png),
// replacing the procedural stand-ins. Each texture is 2048x256: the top half
// (rows 0-127) is the top band -- outer film edge (row 0) to the image rebate
// (row 127) -- and the bottom half is the same band repeated (frame.wgsl maps
// both bands to the same orientation). All content is REAL photographic
// material, cleaned so the bands read as film/paper rather than as the source
// photo's scene (case #4 + git 1b50acd: a messy real scan read as "dots").
//
// Source (CC BY, committed license in public/frames/LICENSE.txt):
//   sr1.jpg   = File:Sprocket_Rocket_(27975049409).jpg -- Kevin Dooley
//               (Wikimedia Commons, CC BY 2.0). A real 35mm Sprocket Rocket
//               shot: backlit sprocket holes + the dark film base between
//               them. 135 uses the real holes; the unexposed film between the
//               holes (uniform dark, real grain) becomes the 135 rebate, the
//               120 paper backing, and the print matte (normalized to white).
//               ONE source for all three bands keeps the license simple.
//               (fibre.jpg was dropped: its author publishes under both CC BY
//               and CC BY-SA, so its exact license was unverifiable.)
//
// Usage: node scripts/vend-frames.mjs   (requires macOS sips + light_frames/)
import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---- minimal PNG decode/encode (RGBA8/RGB8, non-interlaced) ---------------
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
    prev.set(cur);
    for (let x = 0; x < w; x++) { out[(y * w + x) * 4 + 3] = 255; for (let k = 0; k < 3; k++) out[(y * w + x) * 4 + k] = ch === 4 ? cur[x * 4 + k] : cur[x * 3 + k]; }
  }
  return { w, h, data: out };
}
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(4); out.writeUInt32BE(data.length, 0); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0); return Buffer.concat([out, td, crc]); };
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'light_frames');
const OUT = join(ROOT, 'public', 'frames');
const BW = 2048, BH = 128; // band: 2048 wide x 128 tall (strip = band x 2)

// ---- helpers ---------------------------------------------------------------
// Nearest-neighbor resize of a source rect [sx0,sx1, sy0,sy1] to WxH.
function resizePatch(src, sw, sx0, sx1, sy0, sy1, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(sw === undefined ? sy0 : sy0, sy0 + Math.floor(((sy1 - sy0) * y) / H));
    const syi = sy0 + Math.min(sy1 - sy0 - 1, Math.floor(((sy1 - sy0) * y) / H));
    for (let x = 0; x < W; x++) {
      const sxi = sx0 + Math.min(sx1 - sx0 - 1, Math.floor(((sx1 - sx0) * x) / W));
      const o = (syi * src.w + sxi) * 4, di = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) out[di + k] = src.data[o + k];
    }
  }
  return out;
}
// Mirror-tile a W0xH0 patch to WxH (palindrome tiling => seamless edges).
function mirrorTile(patch, W0, H0, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    let py = y % (2 * H0); if (py >= H0) py = 2 * H0 - 1 - py;
    for (let x = 0; x < W; x++) {
      let px = x % (2 * W0); if (px >= W0) px = 2 * W0 - 1 - px;
      patch.copy(out, (y * W + x) * 4, (py * W0 + px) * 4, (py * W0 + px) * 4 + 4);
    }
  }
  return out;
}
function bandStats(rgba, W, H) {
  let r = 0, g = 0, b = 0, n = 0, xvar = 0;
  const col = new Array(W).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; col[x] += rgba[o] + rgba[o + 1] + rgba[o + 2]; n++; }
  r /= n; g /= n; b /= n;
  for (let x = 0; x < W; x++) { const m = col[x] / H; xvar += (m - (r + g + b)) ** 2; }
  return { r: r.toFixed(0), g: g.toFixed(0), b: b.toFixed(0), xStd: Math.sqrt(xvar / W).toFixed(1) };
}

// Film base BETWEEN the sprocket holes (sr1 rows 20-58): real, uniform, fine
// grain -- measured flat to ~1 unit across the flattest 30 cols. The centers
// of four dark runs (away from the bright hole-edge gradients) are
// concatenated so the tiled band has ~120px of unique content.
function filmBase(sr1) {
  const RUNS = [[397, 461], [550, 614], [702, 767], [855, 920]];
  const CX = 30, y0 = 20, y1 = 58, H = y1 - y0, W = RUNS.length * CX;
  const out = Buffer.alloc(W * H * 4);
  let dx = 0;
  for (const [r0, r1] of RUNS) {
    const x0 = r0 + ((r1 - r0 - CX) >> 1);
    for (let y = 0; y < H; y++) for (let x = 0; x < CX; x++) {
      const o = ((y0 + y) * sr1.w + (x0 + x)) * 4, di = (y * W + x + dx) * 4;
      out[di] = sr1.data[o]; out[di + 1] = sr1.data[o + 1]; out[di + 2] = sr1.data[o + 2]; out[di + 3] = 255;
    }
    dx += CX;
  }
  return { W, H, data: out };
}
// Normalize a patch's luminance to `tgt` with its grain amplified to ~`amp`
// units around it (per-pixel sd scaled) + a warm RGB cast. Returns the scale.
function normTo(patch, tgt, amp, warm) {
  let m = 0, n = 0;
  for (let i = 0; i < patch.length; i += 4) { m += patch[i]; n++; }
  m /= n;
  let sd = 0;
  for (let i = 0; i < patch.length; i += 4) sd += (patch[i] - m) ** 2;
  sd = Math.sqrt(sd / n);
  const b = amp / Math.max(sd, 0.25);
  for (let i = 0; i < patch.length; i += 4) {
    const g = tgt + (patch[i] - m) * b;
    patch[i] = Math.max(0, Math.min(255, g + warm[0]));
    patch[i + 1] = Math.max(0, Math.min(255, g + warm[1]));
    patch[i + 2] = Math.max(0, Math.min(255, g + warm[2]));
  }
  return b;
}

const tmp = mkdtempSync(join(tmpdir(), 'vendframe-'));
try {
  mkdirSync(OUT, { recursive: true });
  // Convert the source to PNG via sips.
  const sr1Png = join(tmp, 'sr1.png');
  execFileSync('sips', ['-s', 'format', 'png', '--out', sr1Png, join(SRC, 'sr1.jpg')]);
  const sr1 = decodePng(readFileSync(sr1Png));
  console.log(`source: sr1 ${sr1.w}x${sr1.h}`);

  // ==== 135 band (sr1): [thin bright base][real holes][dark rebate] =========
  // sr1 rows: 0-18 bright backlit film edge, 19-58 the sprocket holes (clean
  // regular holes with dark film between), 59+ the exposed scene (skip -- it
  // would ghost the user's photo). The dark unexposed film BETWEEN the holes
  // (uniform, real grain) becomes the rebate so the band stays real but clean.
  const holeW = Math.floor(sr1.w * 0.55), holeX = Math.floor(sr1.w * 0.22); // center 55% of sr1
  const holes = resizePatch(sr1, sr1.w, holeX, holeX + holeW, 19, 58, BW, 60);
  // Bright film edge above the holes: REAL base, but dulled + thinned so its
  // scene content reads as translucent film edge, not the source photo.
  const base = resizePatch(sr1, sr1.w, holeX, holeX + holeW, 2, 18, BW, 8);
  for (let i = 0; i < base.length; i += 4) {
    base[i] = (base[i] * 0.55) | 0; base[i + 1] = (base[i + 1] * 0.55) | 0; base[i + 2] = (base[i + 2] * 0.55) | 0;
  }
  // dark film between the holes: patch from a dark column run (cols ~28-52).
  const rebate = resizePatch(sr1, sr1.w, 28, 52, 20, 56, BW, 60);
  // The between-hole film is near-black; lift it to a translucent dark rebate
  // (~16) with the real grain kept, warm-neutral like film base.
  {
    let m = 0, n = 0;
    for (let i = 0; i < rebate.length; i += 4) { m += rebate[i]; n++; }
    m /= n;
    for (let i = 0; i < rebate.length; i += 4) {
      const g = 16 + (rebate[i] - m) * 1.4;
      rebate[i] = Math.max(0, Math.min(255, g + 2)); rebate[i + 1] = Math.max(0, Math.min(255, g)); rebate[i + 2] = Math.max(0, Math.min(255, g - 1));
    }
  }
  const band135 = Buffer.alloc(BW * BH * 4);
  base.copy(band135, 0); holes.copy(band135, BW * 8 * 4); rebate.copy(band135, BW * 68 * 4);
  const strip135 = Buffer.alloc(BW * BH * 2 * 4);
  band135.copy(strip135, 0); band135.copy(strip135, BW * BH * 4);
  writeFileSync(join(OUT, '135-strip.png'), encodePng(BW, BH * 2, strip135));
  console.log('135-strip: base', bandStats(base, BW, 8), '| holes', bandStats(holes, BW, 60), '| rebate', bandStats(rebate, BW, 60), '| band xStd=', bandStats(band135, BW, BH).xStd);

  // ==== 120 band (sr1 film base): uniform real backing, no holes ============
  // Medium-format backing is a smooth charcoal rebate. sr1's film base
  // between the holes (real fine grain, flat to ~1 unit), mirror-tiled and
  // lifted to charcoal (~34), reads as real paper backing rather than a flat
  // colour. Grain amplitude tuned to read as paper texture, not sensor noise.
  const fb120 = filmBase(sr1);
  const band120 = mirrorTile(fb120.data, fb120.W, fb120.H, BW, BH);
  normTo(band120, 34, 6, [5, 1, -3]);
  const strip120 = Buffer.alloc(BW * BH * 2 * 4);
  band120.copy(strip120, 0); band120.copy(strip120, BW * BH * 4);
  writeFileSync(join(OUT, '120-strip.png'), encodePng(BW, BH * 2, strip120));
  console.log('120-strip:', bandStats(band120, BW, BH));

  // ==== print band (sr1 film base): real matte paper, normalized white =======
  // Print matte = real paper. The same film base normalized to paper white
  // (~252) with a warm cast reads as fibre paper at the 0.1 border thickness.
  // Same verified CC BY 2.0 source as the 135/120 bands -> one attribution.
  const fbP = filmBase(sr1);
  const bandPrint = mirrorTile(fbP.data, fbP.W, fbP.H, BW, BH);
  normTo(bandPrint, 252, 6, [2, 0, -2]);
  const stripPrint = Buffer.alloc(BW * BH * 2 * 4);
  bandPrint.copy(stripPrint, 0); bandPrint.copy(stripPrint, BW * BH * 4);
  writeFileSync(join(OUT, 'print-strip.png'), encodePng(BW, BH * 2, stripPrint));
  console.log('print-strip:', bandStats(bandPrint, BW, BH));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
