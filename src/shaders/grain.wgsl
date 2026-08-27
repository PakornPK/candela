// Film grain (LrC Effects panel). Display-referred luminance noise, applied
// LAST in the op chain (after the vignette). Model mirrored by grain.ts for the
// unit tests -- this shader and the CPU `grainResponse` must stay in sync.
//
//   - Stateless seeded noise: every pixel derives its value from its own
//     coordinates + one per-image seed, so the pattern is deterministic across
//     frames AND GPUs (no flicker, no per-frame RNG state). LrC grain is
//     static on a still image too.
//   - noise = mix(coarse value-noise, fine gaussian, roughness). `size` sets
//     the value-noise cell in px (1..24), `roughness` blends smooth clumps to
//     sharp per-pixel speckle. Zero-mean, so the mean brightness survives.
//   - Applied to the sRGB-encoded luma, damped by max(4d(1-d), 0) -- strongest
//     mid-gray, invisible in crushed shadows and blown highlights (film
//     behavior). The noised luma is un-encoded and the linear color scaled by
//     the ratio: monochrome grain, chroma preserved.
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

// Bilinear value noise in [0,1]. px/py in CELL units.
fn valueNoise(px: f32, py: f32, seed: u32) -> f32 {
  let x0 = u32(floor(px));
  let y0 = u32(floor(py));
  let tx = smoothstep(0.0, 1.0, px - f32(x0));
  let ty = smoothstep(0.0, 1.0, py - f32(y0));
  let a = hash01(x0, y0, seed);
  let b = hash01(x0 + 1u, y0, seed);
  let c = hash01(x0, y0 + 1u, seed);
  let d = hash01(x0 + 1u, y0 + 1u, seed);
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

fn linearToSrgb(x: f32) -> f32 {
  let c = max(x, 0.0);
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308);
}

fn srgbToLinear(x: f32) -> f32 {
  return select(12.92 * x, pow((x + 0.055) / 1.055, 2.4), x > 0.04045);
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

  // Combined noise field (zero-mean).
  let sizePx = 1.0 + 23.0 * clamp(p.size * 0.01, 0.0, 1.0);
  let coarse = valueNoise(f32(id.x) / sizePx, f32(id.y) / sizePx, seedU) * 2.0 - 1.0;
  let fine = gauss(id.x, id.y, seedU);
  let roughN = clamp(p.roughness * 0.01, 0.0, 1.0);
  let noise = mix(coarse * 0.5, fine * 0.7, roughN);

  // Display-domain additive, mid-tone damped, then luma-ratio back to linear.
  let A = clamp(p.amount * 0.01, 0.0, 1.0) * 0.12;
  let d = linearToSrgb(lum);
  let damp = max(4.0 * d * (1.0 - d), 0.0);
  let d2 = clamp(d + noise * A * damp, 0.0, 1.0);
  let lum2 = srgbToLinear(d2);
  let ratio = select(1.0, lum2 / lum, lum > 1e-6);

  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * ratio, 1.0));
}
