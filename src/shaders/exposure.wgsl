struct Exposure {
  gain: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: Exposure;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb * u.gain, 1.0));
}
