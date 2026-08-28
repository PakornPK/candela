// Analog film light leak (creative Effects effect). Light that reached the
// film during load/rewind ADDS a band of color along one frame edge --
// strongest at the edge, fading inward with soft streaks. Extra exposure, so
// the leak ADDS to LINEAR RGB (not the luma-ratio of grain.wgsl). Per-photo
// seed picks the edge + streak pattern; `hue` slides warm (classic orange) to
// cool (cyan). Runs LAST in the op chain.
//
// The leak shape is VENDORED TEXTURE-DRIVEN (case #8 -- the old procedural
// smoothstep+hash-band gradient looked "fake"). Three committed rgba8unorm
// leak textures (public/leaks/leak-{0,1,2}.png, generated once by
// scripts/gen-light-leaks.mjs) are authored entering from the TOP; the frame
// is rotated so the texture's top aligns with the per-photo edge. The bytes
// ARE linear additive values (no -srgb), so `texture * gain` adds straight to
// linear RGB. `hue` blends the three textures' weights (0 warm tex0, 50 mid
// tex1, 100 cool tex2); `fade` scales a distance envelope on top of the
// textures' own falloff (0 = texture shape, 100 = hard stop by LEAK_WIDTH).
//
// Model mirrored by lightleak.ts -- this shader and the CPU `leakAdd` must
// stay in sync (the CPU mirror uses representative colors + an envelope for
// the texture density; the pixels themselves are the harness's proof).
//
// ponytail: generated stand-ins for CC0 scans (none found clean enough); swap
// the PNGs for scans later without touching the shader. No bloom/blur pass.

struct Lightleak {
  amount: f32,      // 0..100
  hue: f32,         // 0..100, 0 warm .. 100 cool
  fade: f32,        // 0..100, 0 = texture falloff, 100 = hard stop by LEAK_WIDTH
  seed: f32,        // [0,1) -- per-file, shared with grain
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

const LEAK_WIDTH: f32 = 0.35;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Lightleak;
@group(0) @binding(3) var leakTex0: texture_2d<f32>;
@group(0) @binding(4) var leakTex1: texture_2d<f32>;
@group(0) @binding(5) var leakTex2: texture_2d<f32>;
@group(0) @binding(6) var leakSamp: sampler;

// Distance across the frame from the leak edge: 0 on the edge, 1 at the far
// side. edge 0=top, 1=right, 2=bottom, 3=left.
fn edgeDistance(edge: u32, nx: f32, ny: f32) -> f32 {
  if (edge == 0u) { return ny; }
  if (edge == 1u) { return 1.0 - nx; }
  if (edge == 2u) { return 1.0 - ny; }
  return nx;
}

// Rotates the frame coords so the texture's TOP (the leak entry) aligns with
// the chosen frame edge: texture y = distance from the edge, texture x = the
// coordinate running along it.
fn uvForEdge(edge: u32, nx: f32, ny: f32) -> vec2<f32> {
  if (edge == 0u) { return vec2<f32>(nx, ny); }
  if (edge == 1u) { return vec2<f32>(ny, 1.0 - nx); }
  if (edge == 2u) { return vec2<f32>(nx, 1.0 - ny); }
  return vec2<f32>(1.0 - ny, nx);
}

// Hue -> per-texture blend weights (triangular, sums to 1). hue01 0 -> tex0
// (warm), 0.5 -> tex1 (mid), 1 -> tex2 (cool). Mirror of lightleak.ts.
fn leakWeights(hue01: f32) -> vec3<f32> {
  let h = hue01 * 2.0; // 0..2
  var w = vec3<f32>(
    clamp(1.0 - h, 0.0, 1.0),
    max(0.0, 1.0 - abs(h - 1.0)),
    clamp(h - 1.0, 0.0, 1.0),
  );
  return w / (w.x + w.y + w.z);
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
  let uv = uvForEdge(edge, nx, ny);
  let t0 = textureSampleLevel(leakTex0, leakSamp, uv, 0.0).rgb;
  let t1 = textureSampleLevel(leakTex1, leakSamp, uv, 0.0).rgb;
  let t2 = textureSampleLevel(leakTex2, leakSamp, uv, 0.0).rgb;
  let w = leakWeights(clamp(p.hue * 0.01, 0.0, 1.0));
  let tex = t0 * w.x + t1 * w.y + t2 * w.z;
  let d = edgeDistance(edge, nx, ny);
  let fade01 = clamp(p.fade * 0.01, 0.0, 1.0);
  let fadeGain = mix(1.0, 1.0 - smoothstep(0.0, LEAK_WIDTH, d), fade01);
  let gain = clamp(p.amount * 0.01, 0.0, 1.0) * fadeGain;
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb + tex * gain, 1.0));
}
