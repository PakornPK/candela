// Presence group: texture, clarity, dehaze, vibrance, saturation -- one pass,
// like Lightroom's Presence panel. All luma edits run in LOG space (log2 of
// linear luma), like LrC's perceptual tone handling -- a linear-space edit
// compresses shadows and slams highlights, and (the earlier bug) a dehaze
// pivot above linear mid-gray crushed most pixels toward black. Order inside
// the pass matters:
//
//   1. dehaze  -> veil removal + local structure, log space about mid-gray
//                 (log2 0.18). The large-radius local mean IS the haze
//                 (low-frequency additive brightening); pulling it toward
//                 mid-gray removes the veil, and a local-contrast term
//                 restores the structure the haze washed out -- plus a
//                 saturation lift. (The old global-contrast-only version read
//                 as plain contrast, not dehaze.)
//   2. texture/clarity -> local-contrast unsharp on log luma; clarity is
//                 ANTI-HALO clamped (boost may overshoot the neighborhood's
//                 [min,max] range by at most HALO of its width) so edges gain
//                 detail without the bright overshoot that reads as "glowing
//                 edges". Texture (radius 1) halos are 1px and negligible.
//   3. vibrance/saturation -> luma-preserving chroma scale, boost stronger for
//                 low-saturation pixels (vibrance) so skin tones don't blow out
//
// Hue is preserved by scaling RGB with the luma ratio after the luma edits,
// the same trick tone.wgsl uses.
//
// ponytail: clarity/dehaze are fixed-radius boxes (3 / 5) -- a real LrC look
// needs multi-scale detail processing (and a sampler the op bind-group shape
// doesn't carry). Strengths are rough calibrations; the anti-halo clamp is the
// cheap version of LrC's halo management. Upgrade path: bilinear sampler at
// several scales.
struct Presence {
  texture: f32,
  clarity: f32,
  dehaze: f32,
  vibrance: f32,
  saturation: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

const LUMA: vec3<f32> = vec3<f32>(0.2126729, 0.7151522, 0.0721750);
const TEXTURE_RADIUS: i32 = 1;
const CLARITY_RADIUS: i32 = 3;
const DEHAZE_RADIUS: i32 = 5;
// Anti-halo: a local-contrast boost may overshoot the neighborhood's log-luma
// range by this fraction of its width. 0 = hard clamp (no halo, but caps
// specular highlights); 0.06 = a thin rim only -- a wider radius and larger
// budget read as the "glowing edges" the user flagged. Radius 3 keeps the
// halo NARROW too (a radius-5 box smears the rim ~5px, which reads as a
// bloom), and both radii stay small for the 50 ms slider budget.
const HALO: f32 = 0.06;

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Presence;

fn lum(c: vec4<f32>) -> f32 {
  return dot(c.rgb, LUMA);
}

// Log2 of linear luma, floored at 1e-6 (the tone domain's floor).
fn logLum(c: vec4<f32>) -> f32 {
  return log2(max(lum(c), 1e-6));
}

// (2R+1)x(2R+1) box stats of LOG luma around `center`, clamped to the texture
// edge: x = mean, y = min, z = max. Local-contrast edits run in log space so
// shadow detail gets the same treatment as highlights (a linear-space unsharp
// is blind in the shadows, where linear luma variation is tiny). The min/max
// feed the anti-halo clamp.
fn boxStatsLogLuma(center: vec2<i32>, dims: vec2<u32>, radius: i32) -> vec4<f32> {
  var total = 0.0;
  var count = 0;
  var mn = 1e30;
  var mx = -1e30;
  let dimsI = vec2<i32>(dims);
  for (var dy = -radius; dy <= radius; dy = dy + 1) {
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let s = textureLoad(inTex, clamp(center + vec2<i32>(dx, dy), vec2<i32>(0), dimsI - vec2<i32>(1)), 0);
      let v = logLum(s);
      total += v;
      mn = min(mn, v);
      mx = max(mx, v);
      count = count + 1;
    }
  }
  return vec4<f32>(total / f32(count), mn, mx, 0.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let center = vec2<i32>(id.xy);
  let c = textureLoad(inTex, center, 0);
  let origLum = lum(c);
  let l = logLum(c);

  // Normalize sliders (-100..100) to -1..1.
  let dehaze = p.dehaze * 0.01;
  let texAmt = p.texture * 0.01;
  let claAmt = p.clarity * 0.01;
  let satAmt = p.saturation * 0.01;
  let vibAmt = p.vibrance * 0.01;

  // 1. Dehaze: veil removal + local structure, about mid-gray (log2 0.18).
  // dLocal is the local haze level; pulling it toward mid removes the veil
  // (bright hazy areas darken, deep areas lift), and the local-contrast term
  // restores the structure the haze washed out. Symmetric about mid-gray --
  // it normalizes toward mid, it does NOT crush toward black.
  var outL = l;
  if (dehaze != 0.0) {
    let mid = log2(0.18);
    let d = boxStatsLogLuma(center, dims, DEHAZE_RADIUS);
    // Veil removal: pull the local haze level (d.x) toward mid-gray. 0.7 not
    // 1.0 -- fully flattening the haze reads as "too dark / crushed".
    // Local structure uses the ORIGINAL deviation (l - d.x) so the two terms
    // stay independent, and clamps it to ±HALO of the neighborhood range so a
    // strong dehaze cannot crush deep-shadow details into black.
    let range = max(d.z - d.y, 1e-3);
    let detail = clamp(l - d.x, -HALO * range, HALO * range);
    outL = l + 0.7 * dehaze * (mid - d.x) + 0.6 * dehaze * detail;
  }

  // 2. Texture + clarity: local-contrast unsharp on log luma. Clarity is
  // anti-halo clamped -- without it, a strong clarity overshoots at edges and
  // the bright side glows ("weuang saeng").
  if (texAmt != 0.0 || claAmt != 0.0) {
    if (texAmt != 0.0) {
      let t = boxStatsLogLuma(center, dims, TEXTURE_RADIUS);
      outL = outL + 1.2 * texAmt * (outL - t.x);
    }
    if (claAmt != 0.0) {
      let cc = boxStatsLogLuma(center, dims, CLARITY_RADIUS);
      let range = max(cc.z - cc.y, 1e-3);
      outL = clamp(outL + 1.5 * claAmt * (outL - cc.x), cc.y - HALO * range, cc.z + HALO * range);
    }
  }

  // Apply the luma edit hue-preservingly, then chroma on top.
  let outLum = exp2(outL);
  let scale = select(0.0, outLum / origLum, origLum > 1e-6);
  var rgb = c.rgb * scale;

  // 3. Saturation + vibrance: luma-preserving chroma scale. Vibrance boosts
  // low-saturation pixels more (skin protection); saturation is flat.
  // Dehaze also lifts saturation (0.6 * dehaze). Clamped >= 0: a negative
  // chroma scale inverts hues (dehaze - + saturation - could go negative).
  let maxc = max(rgb.r, max(rgb.g, rgb.b));
  let minc = min(rgb.r, min(rgb.g, rgb.b));
  let sat = maxc - minc;
  let boost = max((1.0 + satAmt + 0.6 * dehaze) * (1.0 + 1.3 * vibAmt * (1.0 - sat)), 0.0);
  let newLum = dot(rgb, LUMA);
  rgb = newLum + (rgb - newLum) * boost;

  textureStore(outTex, center, vec4<f32>(rgb, 1.0));
}
