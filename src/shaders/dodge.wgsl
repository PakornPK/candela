// Dodge & Burn: exposure gain modulated by a painted signed mask. Runs AFTER
// crop/vignette (display space -- the mask is painted on what the user sees)
// and BEFORE grain/frame. The mask is a capped-resolution r8unorm texture
// (128 = neutral = density 0), sampled bilinearly at the same fractional uv as
// the output (mask dims are proportional to output dims -- see dodge.ts).
// gain = exp2(ev * density): positive density (dodge strokes) lightens,
// negative (burn strokes) darkens, overlapping strokes cancel.
struct DodgeBurn {
  ev: f32,     // amount/25 -> 0..4 EV magnitude
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: DodgeBurn;
@group(0) @binding(3) var maskTex: texture_2d<f32>;
@group(0) @binding(4) var maskSampler: sampler;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(srcTex);
  let pos = vec2<i32>(gid.xy);
  if (any(pos >= vec2<i32>(dims))) {
    return;
  }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims);
  let density = textureSampleLevel(maskTex, maskSampler, uv, 0.0).r * 2.0 - 1.0;
  let c = textureLoad(srcTex, pos, 0).rgb * exp2(p.ev * density);
  textureStore(dstTex, pos, vec4<f32>(c, 1.0));
}
