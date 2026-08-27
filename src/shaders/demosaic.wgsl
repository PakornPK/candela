struct Cfa {
  // 36 CFA colors (6x6, row-major), one u32 per color, filling all 144
  // bytes of the 9xvec4 buffer: color at (row, col) is word (row*6+col)/4,
  // component (row*6+col)%4. Values 0=R 1=G 2=B. Bayer cameras tile their
  // 2x2 to fill the 36, so one lookup handles both Bayer and X-Trans (whose
  // CFA is genuinely 6x6 -- treating it as 2x2 renders every pixel as the
  // same color, which is the color speckling this unified layout replaces).
  pattern: array<vec4<u32>, 9>,
};

@group(0) @binding(0) var normalizedTex: texture_2d<f32>;
@group(0) @binding(1) var demosaicedTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> cfa: Cfa;

fn colorAt(x: u32, y: u32) -> u32 {
  let idx = (y % 6u) * 6u + (x % 6u);
  return cfa.pattern[idx / 4u][idx % 4u];
}

// Bilinear base of one missing channel: average of the *nearest* samples --
// those on the 3x3 ring (Chebyshev distance 1) whose CFA color matches
// `color`. This is Malvar-He-Cutler's own base: around a non-green Bayer
// pixel the ring holds exactly the four orthogonal G samples and the four
// diagonal R/B samples that the MHC kernels weigh. Sampling only the ring
// (not the full 5x5) matters -- the 5x5 would also pull in G at distance 2
// (positions (±1,±2)/(±2,±1)), which the real kernels give weight 0 and
// which blur the estimate. For X-Trans the ring still yields the nearest
// same-color samples; irregular positions just use fewer of them.
// Out-of-bounds samples are skipped (edges use fewer samples rather than
// clamping a row into the image).
fn averageColor(center: vec2<i32>, dims: vec2<u32>, color: u32) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
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
  // WGSL has no `?:` ternary -- select(if-false, if-true, cond).
  return select(0.0, sum / count, count > 0.0);
}

// Average of `color` samples on the distance-2 orthogonal cross
// (dx,dy) in {(±2,0),(0,±2)}. This is the Laplacian tap set of the
// Malvar-He-Cutler kernels: MHC interpolates each missing channel C as
//   C = bilinear(C) + alpha * (K_center - avg K at distance 2)
// where K is the center's own channel and alpha = 1/2 when C is green,
// 1/4 otherwise. For a non-green center in Bayer the cross is exactly the
// four distance-2 same-color taps of MHC (the diagonal corners have weight
// 0 in the real kernels), so the R/B-centered path below is bit-for-bit
// MHC; the same shape extends CFA-agnostically to X-Trans. The correction
// couples the channels' high-frequency content, which is what kills the
// false color a pure same-color average produces at edges.
fn averageColorCross(center: vec2<i32>, dims: vec2<u32>, color: u32) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  let taps = array<vec2<i32>, 4>(
    vec2<i32>(0, -2), vec2<i32>(0, 2), vec2<i32>(-2, 0), vec2<i32>(2, 0),
  );
  for (var t = 0; t < 4; t = t + 1) {
    let p = center + taps[t];
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
  return select(0.0, sum / count, count > 0.0);
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

  // Malvar-He-Cutler color-difference form: each missing channel is its
  // bilinear average plus a cross-channel Laplacian correction from the
  // center channel (alpha = 1/2 for green, 1/4 for R/B). max(0) clips the
  // correction's undershoot at hard edges; the high side is left open for
  // the linear highlight headroom downstream.
  if (thisColor == 0u) { // R pixel
    let lap = center - averageColorCross(centerPos, dims, 0u);
    r = center;
    g = max(0.0, averageColor(centerPos, dims, 1u) + 0.5 * lap);
    b = max(0.0, averageColor(centerPos, dims, 2u) + 0.25 * lap);
  } else if (thisColor == 2u) { // B pixel
    let lap = center - averageColorCross(centerPos, dims, 2u);
    b = center;
    g = max(0.0, averageColor(centerPos, dims, 1u) + 0.5 * lap);
    r = max(0.0, averageColor(centerPos, dims, 0u) + 0.25 * lap);
  } else { // G pixel
    let lap = center - averageColorCross(centerPos, dims, 1u);
    g = center;
    r = max(0.0, averageColor(centerPos, dims, 0u) + 0.25 * lap);
    b = max(0.0, averageColor(centerPos, dims, 2u) + 0.25 * lap);
  }

  textureStore(demosaicedTex, centerPos, vec4<f32>(r, g, b, 1.0));
}
