struct Levels {
  blackLevel: f32,
  whiteLevel: f32,
};

@group(0) @binding(0) var bayerTex: texture_2d<u32>;
@group(0) @binding(1) var normalizedTex: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> levels: Levels;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(bayerTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let raw = f32(textureLoad(bayerTex, vec2<i32>(id.xy), 0).r);
  let range = max(levels.whiteLevel - levels.blackLevel, 1.0);
  let normalized = clamp((raw - levels.blackLevel) / range, 0.0, 1.0);
  textureStore(normalizedTex, vec2<i32>(id.xy), vec4<f32>(normalized, 0.0, 0.0, 0.0));
}
