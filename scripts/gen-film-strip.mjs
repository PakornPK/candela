// Generates public/frames/135-strip.png -- a realistic 35mm film-strip edge
// texture for the Frame op's '135' style (case #4: procedural sprocket holes
// "ปลอมจัด"). Real film look = irregular sprocket spacing, rounded holes,
// edge markings (frame codes) and grain on the rebate -- none of which the old
// procedural rects had. Deterministic (seeded), so the render+scan harness can
// assert the exact hole pattern appears.
//
// Asset layout: 2048x256 RGBA. Rows [0,128) = the TOP edge band (sprockets +
// markings), rows [128,256) = the BOTTOM edge band (vertical mirror, so the
// two long edges carry the same perforation pattern like real 35mm).
// frame.wgsl maps the frame's rebate bands (border b) into this texture and
// samples it -- the image window is NOT in the texture; the shader draws the
// photo itself in the middle.
//
// ponytail: this is a generated stand-in for a scanned film strip (we couldn't
// find a usable CC0 scan with a clean edge). It's texture-driven and the
// shading path is real; swap the PNG for a scan later without touching the
// shader. 8-bit sRGB values are written directly (uploaded as rgba8unorm-srgb,
// so sampling decodes to linear -- rebate 39->~0.02, holes 118->~0.18, matching
// the old procedural colors).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 2048, HALF = 128; // one band = 128 rows, strip = 256 tall
const HOLE_H = 52;          // hole height in the 128-row band (40%)
const REBATE = [39, 39, 41];   // sRGB rebate (cool-ish black, film edge)
const HOLE = [122, 119, 124];  // sRGB hole: light spills through, warm-tinted
const GRAIN_AMP = 5;           // rebate grain +-encoded luma

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
const rnd = mulberry32(20260828);
const grain = (x, y) => {
  // cheap 2D value noise (hash of the cell + bilinear-ish blend) for film grain
  const h = (a, b) => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fx = x % 4, fy = y % 4, cx = Math.floor(x / 4), cy = Math.floor(y / 4);
  const tl = h(cx, cy), tr = h(cx + 1, cy), bl = h(cx, cy + 1), br = h(cx + 1, cy + 1);
  const tx = fx / 4, ty = fy / 4;
  return (tl * (1 - tx) + tr * tx) * (1 - ty) + (bl * (1 - tx) + br * tx) * ty;
};

// The sprocket pattern: irregular pitch, one hole guaranteed near x=1024 (the
// frame's horizontal centre, so the crop+frame layout proof keeps its centre
// hole), plus a distinctive bright edge-code mark at x=1500 for the scan.
const holes = []; // {x, w} centers
let x = 60 + rnd() * 40;
const target = 11;
for (let i = 0; i < target; i++) {
  const w = 92 + rnd() * 22; // hole width (irregular)
  if (i === 5) x = 1024;     // pin a hole at the centre (layout proof)
  if (i === 8) x = 1500;     // ...and at the edge-code mark column
  holes.push({ x, w });
  x += 150 + rnd() * 60;     // irregular pitch (~180px avg)
}
// The distinctive mark: a bright "frame number / barcode" block on the inner
// edge of the top band at x=1500 -- the render+scan discriminator.
const MARK = { x: 1500, y: 20, w: 7, h: 24, rgb: [168, 168, 178] };

function inHole(px, yBand) {
  const yy = yBand - 64; // holes centred vertically in the band
  for (const h of holes) {
    const dx = Math.abs(px - h.x) - h.w / 2;
    if (dx <= 0 && Math.abs(yy) <= HOLE_H / 2) return true; // inner rect
    if (Math.abs(dx) <= 3 && Math.abs(yy) <= HOLE_H / 2 + 3) return 0.5; // soft edge
  }
  return false;
}

const img = Buffer.alloc(W * (HALF * 2) * 4);
for (let band = 0; band < 2; band++) {
  const yTop = band * HALF;
  for (let y = 0; y < HALF; y++) {
    const yBand = band === 1 ? HALF - 1 - y : y; // bottom band mirrors the top
    for (let px = 0; px < W; px++) {
      let rgb = REBATE;
      const hole = inHole(px, yBand);
      if (hole === true) rgb = HOLE;
      else if (hole === 0.5) rgb = HOLE.map((c, i) => Math.round((c + REBATE[i]) / 2));
      // edge-code mark (top band only; the mirror keeps it on both edges)
      if (band === 0 && Math.abs(px - MARK.x) <= MARK.w / 2 && Math.abs(yBand - MARK.y) <= MARK.h / 2) {
        rgb = MARK.rgb;
      }
      // film grain on the rebate
      const g = (grain(px, yBand) - 0.5) * 2 * GRAIN_AMP;
      const o = (yTop + y) * W * 4 + px * 4;
      img[o] = Math.max(0, Math.min(255, Math.round(rgb[0] + g)));
      img[o + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] + g)));
      img[o + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] + g)));
      img[o + 3] = 255;
    }
  }
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
const raw = Buffer.alloc((HALF * 2) * (1 + W * 4));
for (let y = 0; y < HALF * 2; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: none
  img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(HALF * 2, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'frames', '135-strip.png');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${W}x${HALF * 2}, ${holes.length} holes, mark@${MARK.x},${MARK.y})`);
console.log(`hole columns: ${holes.map((h) => h.x).join(',')}`);
