// Luma-ratio tone map driven by a CPU-built response LUT (see tone.ts). Both
// the parametric `tone` op and the `toneCurve` op share this shader -- only
// the LUT contents differ. The LUT maps NORMALIZED LOG2 luminance -> normalized
// log2 output luminance (see LOG_MIN/LOG_MAX + logToNorm below); each pixel is
// scaled by outLum/lum so hue is preserved. Working in log space is what makes
// shadows/highlights respond perceptually (see tone.ts's header comment).
//
// Uniform layout: the LUT is packed as array<vec4<f32>, 128> = 512 f32
// entries. A flat array<f32, 512> would carry a 16-byte element stride and
// consume 8KB for nothing; the vec4 pack (entry i = lut[i>>2][i&3]) is the
// same idiom demosaic.wgsl uses for the CFA. Dynamic indexing of a uniform
// array is allowed in WGSL.
struct Tone {
  lut: array<vec4<f32>, 128>,
};

const LUT_N: f32 = 512.0;
// Log2-luminance domain -- must stay in sync with tone.ts's LOG_MIN/LOG_MAX.
const LOG_MIN: f32 = -12.0;
const LOG_MAX: f32 = 4.0;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> tone: Tone;

// Manual linear interpolation between neighbors -- a uniform array can't be
// sampled, and nearest lookup would show 512 visible steps (banding).
fn lutSample(x: f32) -> f32 {
  let xc = clamp(x, 0.0, 1.0);
  let pos = xc * (LUT_N - 1.0);
  let i0 = u32(floor(pos));
  let i1 = min(i0 + 1u, 511u);
  let f = pos - f32(i0);
  let v0 = tone.lut[i0 >> 2u][i0 & 3u];
  let v1 = tone.lut[i1 >> 2u][i1 & 3u];
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
  // Rec.709 luma -- identical to sRGB luma and to LibRaw's xyz_rgb[1] row, so
  // it is consistent with the camera-color matrix the base came through.
  let lum = dot(c.rgb, vec3<f32>(0.2126729, 0.7151522, 0.0721750));
  let x = logToNorm(lum);
  let y = lutSample(x);
  // Inverse of logToNorm: normalized coordinate -> linear output luminance.
  let outLum = exp2(LOG_MIN + y * (LOG_MAX - LOG_MIN));
  let scale = select(0.0, outLum / lum, lum > 1e-6);
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * scale, 1.0));
}
