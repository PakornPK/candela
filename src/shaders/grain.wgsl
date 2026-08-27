// Film grain (LrC Effects panel). Display-referred luminance noise, applied
// LAST in the op chain (after the vignette). Model mirrored by grain.ts for the
// unit tests -- this shader and the CPU `grainResponse` must stay in sync.
//
//   - Stateless seeded noise: every pixel derives its value from its own
//     coordinates + one per-image seed, so the pattern is deterministic across
//     frames AND GPUs (no flicker, no per-frame RNG state). LrC grain is
//     static on a still image too.
//   - noise = mix(coarse gradient-noise clumps, fine gaussian, roughness).
//     `size` sets the gradient-noise cell in px (1..24), `roughness` blends
//     smooth clumps to sharp per-pixel speckle. Zero-mean, so the mean
//     brightness survives. The combined field is capped at 2 sigma -- a
//     gaussian-tail pixel must not light up as an isolated glowing speck.
//   - The noise is a multiplicative MASK on the linear color -- exp2(noise*A*damp),
//     log-symmetric like real film density (no brightening bias, no white-clip),
//     gated by a mid-gray damp max(4d(1-d), 0) (strongest mid-tone, invisible
//     in crushed shadows and blown highlights). Monochrome, chroma preserved.
//
// ponytail: value-noise grain approximates LrC's real film-grain samples --
// recalibrate strength / cell scale against screenshots if the user flags it.

struct Grain {
  amount: f32,      // 0..100
  size: f32,        // 0..100
  roughness: f32,   // 0..100
  seed: f32,        // [0,1) -- per-file, from the path hash
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

const LUMA: vec3<f32> = vec3<f32>(0.2126729, 0.7151522, 0.0721750);

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Grain;

fn hashU32(x: u32, y: u32, seed: u32) -> u32 {
  var h: u32 = x ^ y;
  h = h * 0x27d4eb2du + seed;
  h = h ^ (h >> 15u);
  h = h * 0x85ebca6bu;
  h = h ^ (h >> 13u);
  h = h * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return h;
}

fn hash01(x: u32, y: u32, seed: u32) -> f32 {
  // 2^32 is exact in f32 (unlike 2^32-1, which rounds up) -- so the result is
  // strictly [0,1), matching the CPU mirror.
  return f32(hashU32(x, y, seed)) / 4294967296.0;
}

// Standard normal via Box-Muller from two independent hashes.
fn gauss(x: u32, y: u32, seed: u32) -> f32 {
  let u1 = max(hash01(x, y, seed), 1e-6); // avoid log(0)
  let u2 = hash01(x, y, seed ^ 0x9e3779b9u);
  return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
}

// 2D Perlin gradient noise, roughly [-1,1] with the *1.5 scale. px/py in CELL
// units. Replaces the old bilinear value noise: value noise pins every local
// maximum to a cell corner, so the coarse clumps marched in a visible square
// lattice ("grid of pink specks" on a magenta cast). Gradient noise rotates
// smooth pseudo-random slopes instead -- extrema sit off-grid, no lattice.
fn gradAngle(x: u32, y: u32, seed: u32) -> f32 {
  return (f32(hashU32(x, y, seed) & 0xffffu) / 65536.0) * 6.2831853;
}
fn gradientNoise(px: f32, py: f32, seed: u32) -> f32 {
  let x0 = floor(px);
  let y0 = floor(py);
  let tx = px - x0;
  let ty = py - y0;
  let sx = smoothstep(0.0, 1.0, tx);
  let sy = smoothstep(0.0, 1.0, ty);
  let a = gradAngle(u32(x0), u32(y0), seed);
  let b = gradAngle(u32(x0) + 1u, u32(y0), seed);
  let c = gradAngle(u32(x0), u32(y0) + 1u, seed);
  let d = gradAngle(u32(x0) + 1u, u32(y0) + 1u, seed);
  let g00 = cos(a) * tx + sin(a) * ty;
  let g10 = cos(b) * (tx - 1.0) + sin(b) * ty;
  let g01 = cos(c) * tx + sin(c) * (ty - 1.0);
  let g11 = cos(d) * (tx - 1.0) + sin(d) * (ty - 1.0);
  return mix(mix(g00, g10, sx), mix(g01, g11, sx), sy);
}

fn linearToSrgb(x: f32) -> f32 {
  let c = max(x, 0.0);
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  let lum = dot(c.rgb, LUMA);
  // 2^24-1 is the largest power-of-two-minus-one exactly representable in f32,
  // so the u32() conversion is always in range -- 4294967295.0 rounds to 2^32
  // and makes the conversion undefined. 24 bits of seed = 16M patterns, plenty.
  let seedU = u32(p.seed * 16777215.0);

  // Combined noise field (zero-mean). Tail capped at 2 sigma: a gaussian-tail
  // pixel must not light up as an isolated glowing speck.
  let sizePx = 1.0 + 23.0 * clamp(p.size * 0.01, 0.0, 1.0);
  let coarse = gradientNoise(f32(id.x) / sizePx, f32(id.y) / sizePx, seedU) * 1.5;
  let fine = gauss(id.x, id.y, seedU);
  let roughN = clamp(p.roughness * 0.01, 0.0, 1.0);
  let noise = clamp(mix(coarse * 0.5, fine * 0.7, roughN), -2.0, 2.0);

  // Density-domain grain (log-symmetric, like real film density): the noise is
  // a multiplicative MASK on the linear color, exp2(noise*A*damp), gated to the
  // mid-tones by damp. Not an additive display offset -- no brightening bias,
  // no white-clip by construction, monochrome (RGB scaled together), chroma
  // preserved.
  let A = clamp(p.amount * 0.01, 0.0, 1.0) * 0.12;
  let d = linearToSrgb(lum);
  let damp = max(4.0 * d * (1.0 - d), 0.0);
  let ratio = exp2(noise * A * damp);

  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * ratio, 1.0));
}
