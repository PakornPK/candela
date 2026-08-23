struct Adjust {
  exposureGain: f32,
  rGain: f32,
  bGain: f32,
  _pad: f32,
};

@group(0) @binding(0) var demosaicedTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> adjust: Adjust;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(demosaicedTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let color = textureLoad(demosaicedTex, vec2<i32>(id.xy), 0);
  let adjusted = vec4<f32>(
    clamp(color.r * adjust.exposureGain * adjust.rGain, 0.0, 1.0),
    clamp(color.g * adjust.exposureGain, 0.0, 1.0),
    clamp(color.b * adjust.exposureGain * adjust.bGain, 0.0, 1.0),
    1.0,
  );
  textureStore(outTex, vec2<i32>(id.xy), adjusted);
}
