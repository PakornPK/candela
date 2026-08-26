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
//   2. texture/clarity -> local-contrast unsharp on log luma; clarity is gated
//                 to the MIDTONES (a bell on log luma, ~1 at mid-gray, ~0 at
//                 black/white) -- LrC's halo management. The old ANTI-HALO hard
//                 clamp capped the whole response at a few percent (repro:
//                 "clarity does nothing"); halos in the midtones are a feature
//                 (LrC +100 shows them wide and soft), only the extremes must
//                 not bloom. Texture (radius 1) halos are 1px and negligible.
//   3. vibrance/saturation -> luma-preserving chroma scale, boost stronger for
//                 low-saturation pixels (vibrance) so skin tones don't blow out
//
// Hue is preserved by scaling RGB with the luma ratio after the luma edits,
// the same trick tone.wgsl uses.
//
// ponytail: clarity/dehaze are fixed-radius boxes (8 / 5) -- a real LrC look
// needs multi-scale detail processing (fine texture + wide halos, and a sampler
// the op bind-group shape doesn't carry). Dehaze keeps the old HALO clamp on
// its local-detail sub-term (its main veil term is unclamped, so it still
// responds -- recalibrate only if the user flags dehaze). Upgrade path:
// bilinear sampler at several scales.
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
// Clarity radius 8 (a 17px-wide halo) -- up from 3. LrC clarity is a
// mid-frequency band boost; its halos are wide and soft. Radius 3 read almost
// like texture. ponytail: fixed radius, full-res box (289 loads/px) -- a
// scale-relative radius (~1-3% of the short dim) and multi-scale clarity are
// the upgrade path if the 50ms budget or the LrC halo width demands them.
const CLARITY_RADIUS: i32 = 8;
const DEHAZE_RADIUS: i32 = 5;
// Midtone gate for clarity. log2(0.18) = mid-gray -- MUST match CLARITY_MID_LOG
// in presence.ts. Replaces the old HALO hard clamp (which capped +100 at ~6%
// brightness): LrC clarity is gated to the midtones, full at mid-gray, rolling
// to ~0 toward black/white. The smooth rolloff is the "soft edge-aware" half of
// halo management -- midtone halos show (a feature), extremes don't bloom.
const CLARITY_MID: f32 = -2.473931188;
const CLARITY_GATE_WIDTH: f32 = 3.5;
// Anti-halo for DEHAZE's local-detail sub-term only (its main veil term is
// unclamped): a detail boost may overshoot the neighborhood's log-luma range
// by this fraction of its width before it would crush details into black.
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

  // 2. Texture + clarity: local-contrast unsharp on log luma. Clarity is gated
  // to the midtones (the gate replaces the old anti-halo clamp -- the repro'ed
  // cap that made +100 do ~nothing). At mid-gray a +100 edge boost runs at full
  // 1.5x strength (halos there are LrC's "pop"); near black/white the gate
  // rolls it off so nothing blooms in the extremes.
  if (texAmt != 0.0 || claAmt != 0.0) {
    if (texAmt != 0.0) {
      let t = boxStatsLogLuma(center, dims, TEXTURE_RADIUS);
      outL = outL + 1.2 * texAmt * (outL - t.x);
    }
    if (claAmt != 0.0) {
      let cc = boxStatsLogLuma(center, dims, CLARITY_RADIUS);
      let dev = outL - cc.x;
      let gate = exp(-3.0 * pow((outL - CLARITY_MID) / CLARITY_GATE_WIDTH, 2.0));
      outL = outL + 1.5 * claAmt * dev * gate;
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
