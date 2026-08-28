// Generates public/leaks/leak-{0,1,2}.png -- three organic light-leak
// textures for the Light Leak op (case #8: the procedural gradient blob
// "fake"). Real leaks are extra exposure that entered the film during
// load/rewind: a bright band along one edge with soft entry blobs, elongated
// color-fringed streaks, and faint dust/scratches -- none of which the old
// smoothstep+hash-band look had. Deterministic (seeded), so the render+scan
// harness can assert the baked marker appears.
//
// Asset layout: 1024x1024 RGBA. The leak enters from the TOP (y=0), density
// falling to ~0 by ~85% down. lightleak.wgsl rotates the frame so the
// texture's top aligns with the per-photo leak edge (seedU % 4), then samples
// with a shared linear sampler.
//
// Color science: uploaded as rgba8unorm (NOT -srgb), so the bytes ARE linear
// additive values -- the shader adds `texture * gain` straight to linear RGB,
// no gamma round-trip. Each texture has a different dominant color so the
// hue control (weighted blend of the three) actually moves the leak's cast:
//   0 warm orange, 1 mid amber, 2 cool cyan.
//
// tex0 carries a baked MARKER: a 32x32 bright-R block at (512,300) -- the
// render+scan discriminator proving real texture sampling (the procedural
// shader could never produce a local hotspot like it). tex1/tex2 have none.
//
// ponytail: generated stand-ins for CC0 scans (none found clean enough);
// swap the PNGs for scans later without touching the shader.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1024, H = 1024;

// Seeded PRNG (mulberry32) so the pattern is reproducible for verification.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Cheap hash-based value noise (grain of the film-strip generator).
const hash = (a, b) => {
  let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const noise = (x, y) => {
  const fx = x % 1, fy = y % 1, cx = Math.floor(x), cy = Math.floor(y);
  const tl = hash(cx, cy), tr = hash(cx + 1, cy), bl = hash(cx, cy + 1), br = hash(cx + 1, cy + 1);
  const tx = fx * fx * (3 - 2 * fx), ty = fy * fy * (3 - 2 * fy);
  return (tl * (1 - tx) + tr * tx) * (1 - ty) + (bl * (1 - tx) + br * tx) * ty;
};

// Dominant linear colors per texture (the hue-blend anchors).
const BASES = [
  [1.0, 0.52, 0.22], // 0 warm orange
  [0.92, 0.68, 0.44], // 1 mid amber
  [0.2, 0.58, 1.0], // 2 cool cyan
];
const MARKER = { x: 512, y: 300, r: 16, rgb: [0.9, 0.3, 0.35] }; // tex0 only
const MAX_BYTE = 255;

function makeTexture(seed, base, withMarker) {
  const rnd = mulberry32(seed);
  // Entry blobs near the top: bright irregular cores the leak pours from.
  const blobs = [];
  for (let i = 0; i < 6; i++) {
    blobs.push({
      x: rnd() * W,
      y: rnd() * 130,
      r: 110 + rnd() * 280,
      b: 0.5 + rnd() * 0.6,
    });
  }
  const img = Buffer.alloc(W * H * 4);
  const scratch = [];
  for (let x = 0; x < W; x += 7) if (rnd() < 0.035) scratch.push(x + rnd() * 6); // faint dark lines
  const blobAt = (x, y) => {
    let s = 0;
    for (const b of blobs) {
      const dx = (x - b.x) / b.r, dy = (y - b.y) / b.r;
      s += b.b * Math.exp(-(dx * dx + dy * dy) * 2);
    }
    return Math.min(s, 1.3);
  };
  for (let y = 0; y < H; y++) {
    const env = Math.pow(Math.max(0, 1 - y / 750), 1.1); // global falloff
    for (let x = 0; x < W; x++) {
      // Elongated vertical streaks: per-6px-column brightness that persists
      // down the frame with its own (slower) decay.
      const col = hash(Math.floor(x / 6), seed ^ 0x9e37);
      const streakLen = 120 + 260 * hash(Math.floor(x / 6), seed ^ 0x41c);
      const streak = col * Math.exp(-y / streakLen);
      // Organic mottling (large grain) + fine dust.
      const grain = noise(x * 0.03, y * 0.03);
      // Per-channel offset -> the streaks fringe in color as real leaks do.
      const offset = 5 + 7 * hash(x % 64, seed);
      // Dust / scratches: a few columns are noticeably darker.
      let scratchDark = 1;
      for (const sx of scratch) if (Math.abs(x - sx) < 1.5) scratchDark = 0.3;
      for (let ch = 0; ch < 3; ch++) {
        const yy = y + (ch - 1) * offset;
        const yyC = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
        const envC = Math.pow(Math.max(0, 1 - yyC / 750), 1.1);
        const gC = noise(x * 0.03, yyC * 0.03);
        const bAt = blobAt(x, yyC);
        let vC = (envC * (0.18 + 0.82 * bAt) + col * Math.exp(-yyC / streakLen) * 1.3) * (0.5 + 0.6 * gC);
        vC = Math.max(0, Math.min(1, vC * scratchDark));
        const o = (y * W + x) * 4 + ch;
        img[o] = Math.round(base[ch] * vC * MAX_BYTE);
      }
      // Marker (tex0 only): a bright R-dominant block the harness scans for.
      if (withMarker && Math.abs(x - MARKER.x) <= MARKER.r && Math.abs(y - MARKER.y) <= MARKER.r) {
        const o = (y * W + x) * 4;
        img[o] = Math.round(MARKER.rgb[0] * MAX_BYTE);
        img[o + 1] = Math.round(MARKER.rgb[1] * MAX_BYTE);
        img[o + 2] = Math.round(MARKER.rgb[2] * MAX_BYTE);
      }
      img[(y * W + x) * 4 + 3] = 255;
    }
  }
  return img;
}

// Minimal PNG encoder (RGBA8): IHDR + IDAT(deflate) + IEND, no new deps.
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([out, td, crc]);
};
const encode = (img) => {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'leaks');
mkdirSync(outDir, { recursive: true });
for (let i = 0; i < 3; i++) {
  const img = makeTexture(20260828 + i * 7919, BASES[i], i === 0);
  const outPath = join(outDir, `leak-${i}.png`);
  writeFileSync(outPath, encode(img));
  console.log(`wrote ${outPath} (${W}x${H}, base ${BASES[i].join(',')}${i === 0 ? ', marker@' + MARKER.x + ',' + MARKER.y : ''})`);
}
