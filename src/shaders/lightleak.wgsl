// Analog film light leak (creative Effects effect). Light that reached the
// film during load/rewind ADDS a band of color along one frame edge --
// strongest at the edge, fading inward with soft streaks. Extra exposure, so
// the leak ADDS to LINEAR RGB (not the luma-ratio of grain.wgsl). Per-photo
// seed picks the edge + streak pattern; `hue` slides warm (classic orange) to
// cool (cyan). Runs LAST in the op chain.
//
// The leak shape is VENDORED TEXTURE-DRIVEN (case #8 -- the old procedural
// smoothstep+hash-band gradient looked "fake"). Twelve committed rgba8unorm
// leak textures (public/leaks/leak-{0..11}.png, vendored from real Resource
// Boy scans by scripts/vend-light-leaks.mjs) uploaded as ONE texture_2d_array
// = FOUR PATTERN SETS of three hue anchors (Set A layers 0-2, Set B 3-5,
// Set C 6-8, Set D 9-11). A set is authored entering from the TOP; the frame
// is rotated so the texture's top aligns with the per-photo edge.
// `patternMode` picks the set: auto (0) = the per-photo seed picks among the
// four (2 bits), fixed (1) = the UI's `patternSel` (0-3). The bytes are the
// scans' own sRGB display values (no -srgb), kept as-is so `texture * gain`
// adds a screen-blend amount to linear RGB. `hue` blends the chosen set's
// three texture weights (0 warm tex0, 50 mid tex1, 100 cool tex2); `fade`
// scales a distance envelope on top of the textures' own falloff (0 =
// texture shape, 100 = hard stop by LEAK_WIDTH).
//
// Model mirrored by lightleak.ts -- this shader and the CPU `leakAdd` must
// stay in sync (the CPU mirror uses representative colors + an envelope for
// the texture density; the pixels themselves are the harness's proof).
//
// ponytail: no bloom/blur pass; the leak is one additive band per frame edge.

struct Lightleak {
  amount: f32,       // 0..100
  hue: f32,          // 0..100, 0 warm .. 100 cool
  fade: f32,         // 0..100, 0 = texture falloff, 100 = hard stop by LEAK_WIDTH
  seed: f32,         // [0,1) -- per-file, shared with grain
  patternMode: f32,  // 0 = auto (seed picks the set), 1 = fixed (patternSel)
  patternSel: f32,   // 0 = Set A, 1 = Set B (used when patternMode = 1)
  bw: f32,           // 1 = B&W treatment active -> the leak renders gray
  _pad3: f32,
};

const LEAK_WIDTH: f32 = 0.35;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Lightleak;
@group(0) @binding(3) var leakTexs: texture_2d_array<f32>; // 12 layers = 4 sets x 3 hue anchors
@group(0) @binding(4) var leakSamp: sampler;

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
  // Pattern set: auto = the seed's 2 bits (a file leaks one of the four
  // sets), fixed = the UI picker's patternSel (0-3). Mirrored by packLightleak.
  // ponytail: if/else, not `cond ? a : b` -- this Tint build rejects `?:`.
  var fam: u32;
  if (p.patternMode < 0.5) {
    fam = (seedU >> 22u) & 3u;
  } else {
    fam = min(u32(p.patternSel), 3u);
  }
  let uv = uvForEdge(edge, nx, ny);
  // One array texture: layer = set*3 + hue anchor (0 warm, 1 mid, 2 cool).
  // textureSampleLevel(t2d_array, sampler, coords, array_index, lod).
  let t0 = textureSampleLevel(leakTexs, leakSamp, uv, fam * 3u + 0u, 0.0).rgb;
  let t1 = textureSampleLevel(leakTexs, leakSamp, uv, fam * 3u + 1u, 0.0).rgb;
  let t2 = textureSampleLevel(leakTexs, leakSamp, uv, fam * 3u + 2u, 0.0).rgb;
  let w = leakWeights(clamp(p.hue * 0.01, 0.0, 1.0));
  var tex = t0 * w.x + t1 * w.y + t2 * w.z;
  // B&W treatment active (the bw op already dropped the image's chroma, so
  // the leak would re-add color on top of a gray image): desaturate the leak
  // to its linear luma -- the same weights as LUMA_WEIGHTS (tone.ts), which is
  // exactly what a neutral B&W mix produces, so a default-treatment shot shows
  // the precise bwLuminance result for the leak too.
  // ponytail: fixed luma weights; a tuned B&W mix shifts the leak's gray vs the
  // image by that band's weight -- pass the mix array here if the user flags it.
  if (p.bw > 0.5) {
    let lg = dot(tex, vec3<f32>(0.2126729, 0.7151522, 0.072175));
    tex = vec3<f32>(lg);
  }
  let d = edgeDistance(edge, nx, ny);
  let fade01 = clamp(p.fade * 0.01, 0.0, 1.0);
  let fadeGain = mix(1.0, 1.0 - smoothstep(0.0, LEAK_WIDTH, d), fade01);
  let gain = clamp(p.amount * 0.01, 0.0, 1.0) * fadeGain;
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb + tex * gain, 1.0));
}
