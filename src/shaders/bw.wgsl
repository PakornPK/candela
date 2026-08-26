// The `bw` op -- LrC treatment -> Black & White. Converts color to monochrome
// via an 8-band hue mix, then applies an optional mono tone curve baked into a
// log2-luminance LUT (CPU side: bw.ts). Lives AFTER `tone` so the stock's
// per-channel H-D tone shaped the pre-conversion color first; everything after
// (toneCurve/presence/vignette) runs on the gray image.
//
//   L0 = luma * (1 + w/100 * saturation)     w = interpolated band weight
//   x  = logToNorm(L0); y = lutSample(x)     (same machinery as tonecurve.wgsl)
//   gray = exp2(LOG_MIN + y * (LOG_MAX - LOG_MIN))
//
// Uniform layout: mix (2x vec4) + tone id (vec4, LUT is pre-baked so the id is
// only for debugging) + LUT as array<vec4<f32>, 128> (entry i = lut[i>>2][i&3]).
struct Bw {
  mix: vec4<f32>,
  mix2: vec4<f32>,
  tone: vec4<f32>,
  lut: array<vec4<f32>, 128>,
};

const LUT_N: f32 = 512.0;
// Log2-luminance domain -- must stay in sync with tone.ts's LOG_MIN/LOG_MAX.
const LOG_MIN: f32 = -12.0;
const LOG_MAX: f32 = 4.0;
// Rec.709 luma -- identical to sRGB luma and to LibRaw's xyz_rgb[1] row.
const LUMA: vec3<f32> = vec3<f32>(0.2126729, 0.7151522, 0.0721750);
// Band centers (R,O,Y,G,Aq,Bl,P,M) -- must stay in sync with bw.ts's
// BW_BAND_CENTERS.
const CENTERS: array<f32, 9> = array<f32, 9>(0.0, 30.0, 60.0, 90.0, 180.0, 240.0, 270.0, 300.0, 360.0);

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> bw: Bw;

fn lutSample(x: f32) -> f32 {
  let xc = clamp(x, 0.0, 1.0);
  let pos = xc * (LUT_N - 1.0);
  let i0 = u32(floor(pos));
  let i1 = min(i0 + 1u, 511u);
  let f = pos - f32(i0);
  let v0 = bw.lut[i0 >> 2u][i0 & 3u];
  let v1 = bw.lut[i1 >> 2u][i1 & 3u];
  return mix(v0, v1, f);
}

fn logToNorm(lum: f32) -> f32 {
  return clamp((log2(max(lum, 1e-6)) - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 1.0);
}

fn hueDeg(rgb: vec3<f32>) -> f32 {
  let mx = max(rgb.r, max(rgb.g, rgb.b));
  let mn = min(rgb.r, min(rgb.g, rgb.b));
  let d = mx - mn;
  if (d < 1e-6) { return 0.0; }
  var h: f32;
  if (mx == rgb.r) {
    h = (rgb.g - rgb.b) / d;
    if (h < 0.0) { h += 6.0; }
  } else if (mx == rgb.g) {
    h = (rgb.b - rgb.r) / d + 2.0;
  } else {
    h = (rgb.r - rgb.g) / d + 4.0;
  }
  return h * 60.0;
}

// Piecewise-linear band weight, wrapping magenta(300) -> red(360).
fn bandWeight(h: f32) -> f32 {
  let vals = array<f32, 9>(
    bw.mix[0], bw.mix[1], bw.mix[2], bw.mix[3],
    bw.mix2[0], bw.mix2[1], bw.mix2[2], bw.mix2[3],
    bw.mix[0],
  );
  for (var i = 0u; i < 8u; i++) {
    if (h >= CENTERS[i] && h < CENTERS[i + 1]) {
      let t = (h - CENTERS[i]) / max(CENTERS[i + 1] - CENTERS[i], 1e-4);
      return mix(vals[i], vals[i + 1], t);
    }
  }
  return vals[0];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  let lum = dot(c.rgb, LUMA);
  let sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  let L0 = max(lum * (1.0 + bandWeight(hueDeg(c.rgb)) * 0.01 * sat), 1e-6);
  let x = logToNorm(L0);
  let y = lutSample(x);
  let gray = exp2(LOG_MIN + y * (LOG_MAX - LOG_MIN));
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(gray, gray, gray, 1.0));
}
