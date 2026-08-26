// Luma-ratio tone map driven by a CPU-built response LUT -- the `toneCurve` op
// (user point/region curve), applied ON TOP of the `tone` op's per-channel ACR
// baseline. Same LUT machinery as tone.wgsl but WITHOUT the baseline: the tone
// pass already applied it, and re-baselining here would compress the highlights
// a second time. The LUT maps NORMALIZED LOG2 luminance -> normalized log2
// output luminance (see tone.ts's LOG_MIN/LOG_MAX); each pixel is scaled by
// outLum/lum so hue is preserved.
//
// Uniform layout: the LUT packed as array<vec4<f32>, 128> = 512 f32 (entry i =
// lut[i>>2][i&3]). A flat array<f32, 512> would carry a 16-byte element stride
// and consume 8KB for nothing.
struct Tone {
  lut: array<vec4<f32>, 128>,
};

const LUT_N: f32 = 512.0;
// Log2-luminance domain -- must stay in sync with tone.ts's LOG_MIN/LOG_MAX.
const LOG_MIN: f32 = -12.0;
const LOG_MAX: f32 = 4.0;
// Rec.709 luma -- identical to sRGB luma and to LibRaw's xyz_rgb[1] row.
const LUMA: vec3<f32> = vec3<f32>(0.2126729, 0.7151522, 0.0721750);

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> tone: Tone;

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

fn logToNorm(lum: f32) -> f32 {
  return clamp((log2(max(lum, 1e-6)) - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  let lum = dot(c.rgb, LUMA);
  let x = logToNorm(lum);
  let y = lutSample(x);
  let outLum = exp2(LOG_MIN + y * (LOG_MAX - LOG_MIN));
  let scale = select(0.0, outLum / lum, lum > 1e-6);
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * scale, 1.0));
}
