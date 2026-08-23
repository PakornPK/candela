struct Cfa {
  pattern: vec4<u32>, // pattern[(y%2)*2 + x%2] = color at that CFA position, 0=R 1=G 2=B
};

@group(0) @binding(0) var normalizedTex: texture_2d<f32>;
@group(0) @binding(1) var demosaicedTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> cfa: Cfa;

fn sampleAt(coord: vec2<i32>, dims: vec2<u32>) -> f32 {
  let clamped = clamp(coord, vec2<i32>(0, 0), vec2<i32>(dims) - vec2<i32>(1, 1));
  return textureLoad(normalizedTex, clamped, 0).r;
}

fn colorAt(x: u32, y: u32) -> u32 {
  let idx = (y % 2u) * 2u + (x % 2u);
  return cfa.pattern[idx];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(normalizedTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  let center = sampleAt(vec2<i32>(x, y), dims);
  let thisColor = colorAt(id.x, id.y);

  let up    = sampleAt(vec2<i32>(x, y - 1), dims);
  let down  = sampleAt(vec2<i32>(x, y + 1), dims);
  let left  = sampleAt(vec2<i32>(x - 1, y), dims);
  let right = sampleAt(vec2<i32>(x + 1, y), dims);
  let diagUL = sampleAt(vec2<i32>(x - 1, y - 1), dims);
  let diagUR = sampleAt(vec2<i32>(x + 1, y - 1), dims);
  let diagDL = sampleAt(vec2<i32>(x - 1, y + 1), dims);
  let diagDR = sampleAt(vec2<i32>(x + 1, y + 1), dims);

  var r: f32;
  var g: f32;
  var b: f32;

  if (thisColor == 0u) { // R pixel
    r = center;
    g = (up + down + left + right) * 0.25;
    b = (diagUL + diagUR + diagDL + diagDR) * 0.25;
  } else if (thisColor == 2u) { // B pixel
    b = center;
    g = (up + down + left + right) * 0.25;
    r = (diagUL + diagUR + diagDL + diagDR) * 0.25;
  } else { // G pixel — R/B come from whichever axis has the R neighbor
    g = center;
    if (colorAt(id.x - 1u, id.y) == 0u || colorAt(id.x + 1u, id.y) == 0u) {
      r = (left + right) * 0.5;
      b = (up + down) * 0.5;
    } else {
      r = (up + down) * 0.5;
      b = (left + right) * 0.5;
    }
  }

  textureStore(demosaicedTex, vec2<i32>(x, y), vec4<f32>(r, g, b, 1.0));
}
