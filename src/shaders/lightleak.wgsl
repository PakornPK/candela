// Analog film light leak (creative Effects effect). Light that reached the
// film during load/rewind ADDS a band of color along one frame edge --
// strongest at the edge, fading inward with soft streaks. Extra exposure, so
// the leak ADDS to LINEAR RGB (not the luma-ratio of grain.wgsl). Per-photo
// seed picks the edge + streak pattern; `hue` slides warm (classic orange) to
// cool (cyan). Runs LAST in the op chain.
//
// Model mirrored by lightleak.ts -- this shader and the CPU `leakAdd` must
// stay in sync.
//
// ponytail: a smooth banded falloff approximates real leaks (which scatter and
// bloom); no bloom/blur pass -- recalibrate against real leaks if the user
// flags the look.

struct Lightleak {
  amount: f32,      // 0..100
  hue: f32,         // 0..100, 0 warm .. 100 cool
  seed: f32,        // [0,1) -- per-file, shared with grain
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

const WARM: vec3<f32> = vec3<f32>(1.0, 0.55, 0.2);
const COOL: vec3<f32> = vec3<f32>(0.1, 0.55, 1.0);
const LEAK_WIDTH: f32 = 0.35;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Lightleak;

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
  return f32(hashU32(x, y, seed)) / 4294967296.0; // [0,1), mirror of grain.ts
}

// Distance across the frame from the leak edge: 0 on the edge, 1 at the far
// side. edge 0=top, 1=right, 2=bottom, 3=left.
fn edgeDistance(edge: u32, nx: f32, ny: f32) -> f32 {
  if (edge == 0u) { return ny; }
  if (edge == 1u) { return 1.0 - nx; }
  if (edge == 2u) { return 1.0 - ny; }
  return nx;
}

// The coordinate running ALONG the leak edge (0..1), keying the streaks.
fn alongEdge(edge: u32, nx: f32, ny: f32) -> f32 {
  if (edge == 0u) { return nx; }
  if (edge == 1u) { return ny; }
  if (edge == 2u) { return 1.0 - nx; }
  return 1.0 - ny;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  let seedU = u32(p.seed * 16777215.0);

  let nx = (f32(id.x) + 0.5) / f32(dims.x);
  let ny = (f32(id.y) + 0.5) / f32(dims.y);
  let edge = seedU % 4u;
  let d = edgeDistance(edge, nx, ny);
  let falloff = 1.0 - smoothstep(0.0, LEAK_WIDTH, d);
  let band = u32(floor(alongEdge(edge, nx, ny) * 24.0));
  let streak = 0.35 + 0.65 * hash01(band, 0u, seedU);
  let gain = clamp(p.amount * 0.01, 0.0, 1.0) * 0.5 * falloff * streak;
  let color = mix(WARM, COOL, clamp(p.hue * 0.01, 0.0, 1.0));

  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb + color * gain, 1.0));
}
