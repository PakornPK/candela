@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

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

// Linear -> sRGB OETF (the standard piecewise function). The pipeline
// produces linear rgba16float; the canvas is unorm8, so this encode is what
// makes images display at the correct brightness (before it, linear-to-8bit
// was shown directly = too dark). The export path reuses this same fragment
// shader via a second render pipeline targeting an rgba8unorm offscreen
// texture. max(c, 0) guards the color matrix's small negatives.
fn linearToSrgb(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, 12.92 * x, x <= 0.0031308);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(srcTex, srcSampler, in.uv);
  return vec4<f32>(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b), 1.0);
}
