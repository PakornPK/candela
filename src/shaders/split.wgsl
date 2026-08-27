// Before/After split blit: two full-res textures side by side in one canvas --
// Before (fresh-import ops) on the left half, After (current ops) on the right.
// Vertex stage is shared with blit.wgsl; this fragment adds the second texture
// binding and picks the half by uv.x. Each half samples its texture across the
// full [0,1] UV range, so each image is scaled to fit its half.
@group(0) @binding(0) var beforeTex: texture_2d<f32>;
@group(0) @binding(1) var afterTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out: VertexOut;
  out.position = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

fn linearToSrgb(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, 12.92 * x, x <= 0.0031308);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let before = textureSample(beforeTex, srcSampler, vec2<f32>(in.uv.x * 2.0, in.uv.y));
  let after = textureSample(afterTex, srcSampler, vec2<f32>((in.uv.x - 0.5) * 2.0, in.uv.y));
  // Out-of-half sample coords clamp to the texture edge, so both samples are
  // always safe; select() picks the half.
  let c = select(after, before, in.uv.x < 0.5);
  return vec4<f32>(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b), 1.0);
}
