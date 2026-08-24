struct Cfa {
  // 36 CFA colors (6x6, row-major), 4 packed per u32: color at (row, col)
  // is word (row*6+col)/4, component (row*6+col)%4. Values 0=R 1=G 2=B.
  // Bayer cameras tile their 2x2 to fill the 36, so one lookup handles
  // both Bayer and X-Trans (whose CFA is genuinely 6x6 -- treating it as
  // 2x2 renders every pixel as the same color, which is the color
  // speckling this unified layout replaces).
  pattern: array<vec4<u32>, 9>,
};

@group(0) @binding(0) var normalizedTex: texture_2d<f32>;
@group(0) @binding(1) var demosaicedTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> cfa: Cfa;

fn colorAt(x: u32, y: u32) -> u32 {
  let idx = (y % 6u) * 6u + (x % 6u);
  return cfa.pattern[idx / 4u][idx % 4u];
}

// Bilinear-style estimate of one missing channel: average of the samples
// within the 5x5 neighborhood whose CFA color matches `color`. Works for
// both CFA layouts -- in Bayer, same-color neighbors sit at distance 1
// (G around R/B) and distance 2 (same-color orthogonals); in X-Trans, each
// pixel has same-color neighbors at Chebyshev distance 2. Out-of-bounds
// samples are skipped (edges use fewer samples rather than clamping a
// row into the image).
fn averageColor(center: vec2<i32>, dims: vec2<u32>, color: u32) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      if (dx == 0 && dy == 0) {
        continue;
      }
      let p = vec2<i32>(center.x + dx, center.y + dy);
      if (p.x < 0 || p.y < 0) {
        continue;
      }
      if (u32(p.x) >= dims.x || u32(p.y) >= dims.y) {
        continue;
      }
      if (colorAt(u32(p.x), u32(p.y)) == color) {
        sum += textureLoad(normalizedTex, p, 0).r;
        count += 1.0;
      }
    }
  }
  return count > 0.0 ? sum / count : 0.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(normalizedTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let centerPos = vec2<i32>(id.xy);
  let center = textureLoad(normalizedTex, centerPos, 0).r;
  let thisColor = colorAt(id.x, id.y);

  var r: f32;
  var g: f32;
  var b: f32;

  if (thisColor == 0u) { // R pixel
    r = center;
    g = averageColor(centerPos, dims, 1u);
    b = averageColor(centerPos, dims, 2u);
  } else if (thisColor == 2u) { // B pixel
    b = center;
    g = averageColor(centerPos, dims, 1u);
    r = averageColor(centerPos, dims, 0u);
  } else { // G pixel
    g = center;
    r = averageColor(centerPos, dims, 0u);
    b = averageColor(centerPos, dims, 2u);
  }

  textureStore(demosaicedTex, centerPos, vec4<f32>(r, g, b, 1.0));
}
