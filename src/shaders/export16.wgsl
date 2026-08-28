// 16-bit export readback: sample the linear rgba16float op-chain output,
// apply the sRGB OETF (same as blit.wgsl) and write u16 values to an
// rgba16uint storage texture. The browser canvas path is 8-bit only, so 16-bit
// exports read back through here. The cropFrac remap is identical to the blit:
// the target is the crop mask size, so this covers exactly the exported region.
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> cropFrac: vec4<f32>;
@group(0) @binding(3) var dstTex: texture_storage_2d<rgba16uint, write>;

fn linearToSrgb(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, 12.92 * x, x <= 0.0031308);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(dstTex);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / vec2<f32>(dims);
  let uv2 = cropFrac.xy + uv * cropFrac.zw;
  let c = textureSampleLevel(srcTex, srcSampler, uv2, 0.0);
  let e = vec3<f32>(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
  textureStore(dstTex, vec2<i32>(gid.xy), vec4<u32>(u32(round(e.x * 65535.0)), u32(round(e.y * 65535.0)), u32(round(e.z * 65535.0)), 0xFFFFu));
}
