// Vendors the downloaded Resource Boy light-leak PHOTOS (light_leak/NNN.jpg)
// into the six committed additive leak textures the shader samples
// (public/leaks/leak-{0..5}.png): two PATTERN SETS of three hue anchors
// (Set A = leak-0..2, Set B = leak-3..5). Replaces the old procedural
// stand-ins: real scans now drive the leak.
//
// Source: Resource Boy Light Leak Overlays (https://resourceboy.com) —
// royalty-free for personal + commercial use, no attribution required.
// License committed at public/leaks/RESOURCE-BOY-LICENSE.txt.
//
// Shader contract (lightleak.wgsl): rgba8unorm, the leak enters from the TOP
// of the texture (y=0), and `texture * gain` adds to linear RGB. The bytes
// are the SCAN'S OWN sRGB pixels (NOT linearized — linearizing crushed the
// gradient to a few value buckets): screen-blend additive semantics. The 8K
// JPGs are (1) ROTATED so the leak's dominant bright edge becomes the texture
// top, (2) downscaled to 1024x1024 (uv-space proportions are unchanged by the
// squish — it only blurs), (3) kept as-is. Only BLACK-background leaks work
// additively: a bright full-frame scene averages to neutral gray. These were
// picked from the 250 by corner-brightness + bright-centroid analysis.
//
// Usage: node scripts/vend-light-leaks.mjs
// Requires: macOS sips (JPG decode + rotate + resize) + light_leak/ present.
import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Two PATTERN SETS, each with one leak per hue anchor (0 warm, 1 mid, 2 cool).
// The UI picker selects a set (or Auto, where the per-photo seed flips the
// set), and `hue` blends the set's three textures. `edge` is the photo's
// dominant bright edge; the script rotates it to the top. Measured by the
// edge-luma analysis (all 250; only ~61 have dark backgrounds usable for
// additive leaks).
//   Set A (leak-0..2) = the original three: subtle pale bands (119 warm
//   red->pink->white, 174 bright warm yellow, 139 cool cyan->white->blue).
//   Set B (leak-3..5) = picked from the same dark-bg pool for RICHER casts:
//   150 saturated warm orange, 122 muted cream, 196 cool blue-white glow.
const SETS = [
  { note: 'Set A: subtle pale bands', texs: [
    { src: '119', edge: 'r', note: 'warm red->pink->white right band' },
    { src: '174', edge: 'r', note: 'bright warm yellow right band' },
    { src: '139', edge: 't', note: 'cool cyan->white->blue top band' },
  ] },
  { note: 'Set B: richer casts', texs: [
    { src: '150', edge: 'r', note: 'saturated warm orange right band' },
    { src: '122', edge: 'r', note: 'muted warm cream right band' },
    { src: '196', edge: 'r', note: 'cool blue-white glow (center-right)' },
  ] },
];
// Clockwise degrees to bring each photo edge to the texture top.
const ROT = { t: 0, r: 270, b: 180, l: 90 };

// ---- minimal PNG decoder (RGBA8/RGB8 non-interlaced) --------------------
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

// ---- minimal PNG encoder (RGBA8), same as gen-film-strip.mjs --------------
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
const SRC = join(ROOT, 'light_leak');
const OUT = join(ROOT, 'public', 'leaks');
const SIZE = 1024;

const tmp = mkdtempSync(join(tmpdir(), 'vendleak-'));
try {
  let i = 0;
  for (const set of SETS) for (const { src, edge, note } of set.texs) {
    const outI = i++; // leak-0..2 = Set A, leak-3..5 = Set B
    const srcPng = join(SRC, `${src}.jpg`);
    // sips: rotate (edge -> top) then resize to exactly SIZE^2, as PNG.
    const rot = join(tmp, `r${src}.png`);
    const sq = join(tmp, `s${src}.png`);
    const rotDeg = ROT[edge];
    execFileSync('sips', rotDeg ? ['-s', 'format', 'png', '--rotate', String(rotDeg), '--out', rot, srcPng] : ['-s', 'format', 'png', '--out', rot, srcPng]);
    execFileSync('sips', ['-z', String(SIZE), String(SIZE), '-s', 'format', 'png', '--out', sq, rot]);
    const img = decodePng(readFileSync(sq));
    if (img.w !== SIZE || img.h !== SIZE) throw new Error(`sips produced ${img.w}x${img.h}, expected ${SIZE}^2`);
    // Bytes = the SCAN'S OWN sRGB pixels, kept as-is (NOT linearized): the
    // shader adds `texture * gain` to linear RGB, and a photo's display value
    // is the standard screen-blend amount -- its gradient is what makes the
    // leak look real. Linearizing to 8-bit crushed the falloff to a sliver
    // (only a few distinct values survive), so the scan's own bytes win.
    const rgba = Buffer.alloc(SIZE * SIZE * 4);
    let maxL = 0, topMean = 0, bottomMean = 0;
    for (let y = 0; y < SIZE; y++) {
      let rowSum = 0;
      for (let x = 0; x < SIZE; x++) {
        const o = (y * SIZE + x) * 4;
        for (let k = 0; k < 3; k++) { const b = img.data[o + k]; rgba[o + k] = b; maxL = Math.max(maxL, b); }
        rgba[o + 3] = 255;
        rowSum += (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
      }
      if (y < 8) topMean += rowSum / SIZE;
      if (y > SIZE - 9) bottomMean += rowSum / SIZE;
    }
    topMean /= 8; bottomMean /= 8;
    const outPng = join(OUT, `leak-${outI}.png`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(outPng, encodePng(SIZE, SIZE, rgba));
    console.log(`leak-${outI}.png <- ${src}.jpg (${edge}->top) ${note}: top-8 rows mean=${topMean.toFixed(1)}, bottom-8=${bottomMean.toFixed(1)}, max=${maxL}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
