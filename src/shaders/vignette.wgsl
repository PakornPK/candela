// Post-Crop Vignetting (LrC Effects panel): a radial falloff multiplied over
// the final image. Runs LAST in the op chain -- like LrC it's a display-level
// effect applied after tone/presence, not part of the colorimetry. One pass,
// no spatial sampling beyond the current pixel's position.
//
// Model (mirrored by vignette.ts for unit tests):
//   - r = radial distance in [0,1], shaped by roundness: -1 is a rounded
//     rectangle (the mid-edges darken like the corners), +1 is a circle (the
//     corners dominate). 0 mixes between them.
//   - The falloff ramp starts at `midpoint` and spans (1-midpoint)*feather of
//     the radius: midpoint 0 reaches into the center, 100 hugs the corners;
//     feather 0 is a hard edge, 100 is a full-width soft ramp.
//   - factor = 1 + 0.85 * amount * ramp, so amount -100 darkens corners to
//     ~0.15 linear (very dark, not black) and +100 lifts them to ~1.85.
//   - `highlights` blends the factor back toward 1 for bright pixels -- LrC
//     protects highlights from BOTH the lighten and darken sides, so skin and
//     white sky don't move with the corners.
//
// ponytail: the roundness mix (max-norm vs euclidean) and the linear-in-amount
// falloff are a reasonable LrC stand-in, not a pixel-fit -- recalibrate
// against real files/screenshots if the user flags the shape. Highlight
// protection keys on linear luma alone (no per-channel), same ceiling.

struct Vignette {
  amount: f32,       // -100..100
  midpoint: f32,     // 0..100
  roundness: f32,    // -100..100
  feather: f32,      // 0..100
  highlights: f32,   // 0..100
  cropFracX: f32,    // crop mask / texture (see crop.ts); 1 = no crop
  cropFracY: f32,
  _pad0: f32,
};

const LUMA: vec3<f32> = vec3<f32>(0.2126729, 0.7151522, 0.0721750);

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Vignette;

fn lum(c: vec4<f32>) -> f32 {
  return dot(c.rgb, LUMA);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);

  // Normalized centered coords (-1..1) over the CROP rect, not the full
  // texture: after a crop the vignette must span the image inside the crop,
  // with the black bars left untouched (they're 0, so factor × 0 stays 0
  // whether the vignette darkens or lightens). (1,1) cropFrac = identity.
  let dx = (f32(id.x) * 2.0 / f32(dims.x) - 1.0) / max(p.cropFracX, 1e-3);
  let dy = (f32(id.y) * 2.0 / f32(dims.y) - 1.0) / max(p.cropFracY, 1e-3);
  // Circular radius: corner of a unit square sits at sqrt(2), so scale by
  // 1/sqrt(2) to make the corner ~1.
  let rCirc = sqrt(dx * dx + dy * dy) * 0.70710678;
  // Rounded-rect radius: the mid-edges count as far out as the corners.
  let rRect = max(abs(dx), abs(dy));
  // roundness -100..100 -> 0..1 (rectangle -> circle).
  let tR = clamp((p.roundness + 100.0) * 0.005, 0.0, 1.0);
  let r = mix(rRect, rCirc, tR);

  // Falloff ramp, 0 at the midpoint .. 1 at the corners.
  let edge = clamp(p.midpoint * 0.01, 0.0, 1.0);
  let feather = clamp(p.feather * 0.01, 0.0, 1.0);
  let width = max((1.0 - edge) * (0.05 + 0.95 * feather), 1e-3);
  let ramp = smoothstep(edge, edge + width, r);

  let amount = clamp(p.amount * 0.01, -1.0, 1.0);
  var factor = 1.0 + 0.85 * amount * ramp;

  // Highlight protection (0..1): bright pixels blend toward no-op.
  let protect = smoothstep(0.55, 0.95, lum(c)) * clamp(p.highlights * 0.01, 0.0, 1.0);
  factor = mix(factor, 1.0, protect);

  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * factor, 1.0));
}
