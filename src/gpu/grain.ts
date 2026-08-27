// CPU-side model for the Grain op (grain.wgsl). Pure + unit-tested: the GPU
// shader computes the seeded noise per-pixel, and the response model below is
// the exact same math so the direction logic (which way amount/size/roughness
// move the image) is verifiable without a browser.
//
// Film grain is DISPLAY-referred: LrC applies it in the Effects panel, after
// the color/tone chain, as output-referred luminance noise. Model (mirrors
// O3DE's FilmGrain shader):
//   - noise = mix(coarse gradient-noise clumps, fine per-pixel gaussian,
//     roughness) `size` sets the gradient-noise cell size (grain particle
//     scale), `roughness` blends between smooth clumps and sharp speckle.
//   - The noise is a multiplicative MASK on the linear color -- exp2(noise*A*damp),
//     log-symmetric like real film density (no brightening bias, no white-clip),
//     gated by a mid-gray damp `max(4d(1-d), 0)` (strongest mid-tone, invisible
//     in crushed shadows and blown highlights). Tail capped at 2 sigma so a
//     single gaussian-tail pixel can't light up as a glowing speck.
//   - Monochrome: RGB scaled together by the mask, chroma preserved.
//   - Per-image seed (from the file path) keeps the pattern stable across
//     frames and different between photos -- stateless in the shader, so it's
//     deterministic across GPUs.
//
// ponytail: procedural value-noise grain is a stand-in for LrC's real film
// grain scans -- recalibrate strength (A=0.12) / cell scale against screenshots
// if the user flags the look. LrC's Size/roughness are film-sample-relative, so
// the 1..24 px mapping is an approximation.

export interface GrainParams {
  amount: number; // 0..100, 0 off
  size: number; // 0..100, default 25; grain particle scale
  roughness: number; // 0..100, default 50; 0 smooth clumps .. 100 sharp speckle
}

export const GRAIN_DEFAULTS: GrainParams = { amount: 0, size: 25, roughness: 50 };

// Only `amount` matters -- at 0 the noise is scaled by exactly 0, so a pass is
// only worth emitting when it's non-zero (same rule as presence/vignette).
export function isNeutralGrain(p: GrainParams): boolean {
  return p.amount === 0;
}

// The seed for the currently loaded photo. Per-image so two photos get
// different grain, stable for one photo (an undo/redo or a re-render shows the
// same pattern, like LrC's deterministic grain). Set by pipeline.load() via
// setGrainSeed(seedFromPath(record.path)).
let currentGrainSeed = 0.5;

export function setGrainSeed(seed: number): void {
  currentGrainSeed = seed;
}

export function getGrainSeed(): number {
  return currentGrainSeed;
}

// FNV-1a 32-bit hash of the file path -> [0,1) seed. Stable across sessions,
// different per file, no RNG state -- the shader needs just this one float.
export function seedFromPath(path: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967295;
}

// Layout must match the `Grain` struct in grain.wgsl (4 f32s + 4 pad).
export function packGrain(p: GrainParams, seed: number): Float32Array {
  return new Float32Array([p.amount, p.size, p.roughness, seed, 0, 0, 0, 0]);
}

// ---- stateless seeded noise (mirrors grain.wgsl exactly) --------------------

// Integer hash -- a multiply-xor-shift avalanche, identical in WGSL so the CPU
// model and the shader produce the same field for the same (x,y,seed).
export function hashU32(x: number, y: number, seed: number): number {
  let h = (x ^ y) >>> 0;
  h = (Math.imul(h, 0x27d4eb2d) + seed) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash01(x: number, y: number, seed: number): number {
  return hashU32(x, y, seed) / 4294967296; // [0,1), mirror of the shader
}

// Standard normal via Box-Muller from two independent hashes.
export function gauss(x: number, y: number, seed: number): number {
  const u1 = Math.max(hash01(x, y, seed), 1e-6); // avoid log(0)
  const u2 = hash01(x, y, (seed ^ 0x9e3779b9) >>> 0);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// 2D Perlin gradient noise, roughly [-1,1] with the *1.5 scale. Smooth clumps
// of `size` px, the coarse half of the field. x/y are in CELL units (already
// divided by sizePx). Replaces bilinear value noise: value noise pins every
// local maximum to a cell corner, so the coarse clumps marched in a visible
// square lattice ("grid of pink specks" on a magenta cast). Gradient noise
// rotates smooth pseudo-random slopes instead -- extrema sit off-grid.
function gradAngle(x: number, y: number, seed: number): number {
  return (hashU32(x, y, seed) & 0xffff) / 65536 * 2 * Math.PI;
}
export function gradientNoise(px: number, py: number, seed: number): number {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const tx = px - x0;
  const ty = py - y0;
  const sx = smoothstep01(tx);
  const sy = smoothstep01(ty);
  const a = gradAngle(x0, y0, seed);
  const b = gradAngle(x0 + 1, y0, seed);
  const c = gradAngle(x0, y0 + 1, seed);
  const d = gradAngle(x0 + 1, y0 + 1, seed);
  const g00 = Math.cos(a) * tx + Math.sin(a) * ty;
  const g10 = Math.cos(b) * (tx - 1) + Math.sin(b) * ty;
  const g01 = Math.cos(c) * tx + Math.sin(c) * (ty - 1);
  const g11 = Math.cos(d) * (tx - 1) + Math.sin(d) * (ty - 1);
  return mix01(mix01(g00, g10, sx), mix01(g01, g11, sx), sy);
}

// The uniform carries the seed as a [0,1) float; the shader converts it once
// to the u32 the hash functions key on (u32(p.seed * 16777215.0) -- 2^24-1,
// the largest representable power-of-two-minus-one in f32, so the conversion
// is never out of range). Mirror that exactly -- hashing on the float itself
// would truncate the same range of seeds to near-identical keys.
export function seedU32(seed: number): number {
  return Math.floor(seed * 16777215) >>> 0;
}

// The combined noise field: coarse gradient-noise clumps (cell size from
// `size`, 1..24 px) blended toward fine per-pixel gaussian by `roughness`.
// Zero-mean, roughly [-0.7, 0.7]. `seed` is the u32 hash key (see seedU32).
export function grainNoise(x: number, y: number, p: GrainParams, seed: number): number {
  const sizePx = 1 + 23 * clamp01(p.size / 100);
  const coarse = gradientNoise(x / sizePx, y / sizePx, seed) * 1.5;
  const fine = gauss(x, y, seed);
  return mix01(coarse * 0.5, fine * 0.7, clamp01(p.roughness / 100));
}

// The full response: LINEAR luma in -> LINEAR luma out. Density-domain grain
// (log-symmetric, like real film density): the zero-mean noise is a
// multiplicative MASK exp2(noise*A*damp) on the linear value, gated to the
// mid-tones by damp, tail capped at 2 sigma so an isolated particle can't
// light up as a glowing speck on a film-sim look. `seed` is the [0,1) uniform
// value, converted to the u32 key like the shader does.
export function grainResponse(lum: number, p: GrainParams, seed: number, x: number, y: number): number {
  if (p.amount === 0) return lum;
  const s = seedU32(seed);
  const A = clamp01(p.amount / 100) * 0.12;
  const d = linearToSrgb(lum);
  const damp = Math.max(4 * d * (1 - d), 0);
  const noise = Math.min(Math.max(grainNoise(x, y, p, s), -2), 2);
  return lum * 2 ** (noise * A * damp);
}

// ---- helpers shared with the shader -----------------------------------------

export function linearToSrgb(x: number): number {
  const c = Math.max(x, 0);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function mix01(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
