// Tone map driven by a CPU-built response LUT (see tone.ts), applied
// PER-CHANNEL to linear RGB -- exactly what LrC does. The LUT bakes the ACR
// default curve as its neutral baseline (the import look) plus the parametric
// perturbations; each channel maps through its own log-normalized position on
// it, so the hottest channel of a colored/blown highlight compresses the most
// and the cast desaturates on BOTH the baseline and the recover direction
// (LrC shows no red at Highlights +/-). A luma-ratio path scales every channel
// equally and keeps the cast -- the pre-fix "ติดแดง".
//
// Gray pixels are bit-identical to a luma-target pass: for c=(v,v,v) every
// channel samples the same LUT position, so the output luma equals the LUT
// value exactly -- the user-validated brightness (mid-gray +1.11 EV etc.) is
// preserved while saturated pixels get LrC's per-channel treatment.
//
// The `toneCurve` op uses tonecurve.wgsl (plain luma-ratio LUT, no baseline)
// on top of this pass -- the baseline must run once, not per op.
//
// Uniform layout: THREE per-channel LUTs (R/G/B), packed as
// array<vec4<f32>,384> (3*512 f32) in a 6144-byte buffer. A flat array would
// carry a 16-byte element stride and consume 24KB for nothing; the vec4 pack
// (entry i = luts[i>>2][i&3], channel c's floats offset by c*512 -- c*128
// vec4s) is the same idiom demosaic.wgsl uses for the CFA. Dynamic indexing
// of a uniform array is allowed in WGSL. Today all three channels carry the
// SAME shared curve (see cameraOutput in tone.ts) -- the per-channel layout
// stays for future per-camera fits.
struct Tone {
  luts: array<vec4<f32>, 384>,
};

const LUT_N: f32 = 512.0;
// Log2-luminance domain -- must stay in sync with tone.ts's LOG_MIN/LOG_MAX.
const LOG_MIN: f32 = -12.0;
const LOG_MAX: f32 = 4.0;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> tone: Tone;

// Manual linear interpolation between neighbors -- a uniform array can't be
// sampled, and nearest lookup would show 512 visible steps (banding). ch is
// the per-channel LUT index (0=R, 1=G, 2=B).
fn lutSampleC(ch: u32, x: f32) -> f32 {
  let xc = clamp(x, 0.0, 1.0);
  let pos = xc * (LUT_N - 1.0);
  let i0 = u32(floor(pos));
  let i1 = min(i0 + 1u, 511u);
  let f = pos - f32(i0);
  // Float index into the 3*512 concatenated LUT; ch offsets by 512 floats
  // (ch*128 was the vec4 stride -- off by 4x, which made G/B sample the wrong
  // channel's data and scrambled the render into the ฟ้าส้ม blue-orange cast).
  let a = ch * 512u + i0;
  let b = ch * 512u + i1;
  let v0 = tone.luts[a >> 2u][a & 3u];
  let v1 = tone.luts[b >> 2u][b & 3u];
  return mix(v0, v1, f);
}

// Linear luminance -> [0,1] LUT coordinate. max(lum, 1e-6) guards log2(0).
fn logToNorm(lum: f32) -> f32 {
  return clamp((log2(max(lum, 1e-6)) - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  // Per-channel tone curve (LrC): each linear channel maps through the LUT at
  // its own log-normalized position. For a warm highlight the hottest channel
  // sits highest in the log domain, so the baseline rolloff and the recover
  // deltas compress it most -- the cast desaturates on both + and -.
  let out = vec3<f32>(
    exp2(LOG_MIN + lutSampleC(0u, logToNorm(c.r)) * (LOG_MAX - LOG_MIN)),
    exp2(LOG_MIN + lutSampleC(1u, logToNorm(c.g)) * (LOG_MAX - LOG_MIN)),
    exp2(LOG_MIN + lutSampleC(2u, logToNorm(c.b)) * (LOG_MAX - LOG_MIN)),
  );
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(out, 1.0));
}
