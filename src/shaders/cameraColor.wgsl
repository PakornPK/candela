// Applies the camera's color matrix (LibRaw's rgb_cam, folded to a 3x3 by
// the wrapper) to the demosaiced raw-sensor RGB, producing a linear-sRGB
// base that every user op composes on top of. Runs once per load(), not per
// render(). The uniform holds one vec4 per output row (explicit rows avoid
// WGSL's column-major mat3 layout confusion); .w is padding. Small
// negatives are clamped (matrix cross-terms can go slightly negative);
// values >1 carry forward unclamped -- display/export clamp at encode.
struct ColorMat {
  rows: array<vec4<f32>, 3>,
};

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> m: ColorMat;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let c = textureLoad(inTex, vec2<i32>(id.xy), 0);
  let out = vec3<f32>(
    dot(m.rows[0].xyz, c.rgb),
    dot(m.rows[1].xyz, c.rgb),
    dot(m.rows[2].xyz, c.rgb),
  );
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(max(out, vec3<f32>(0.0)), 1.0));
}
