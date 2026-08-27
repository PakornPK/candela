// Film frame (creative Effects panel look). Scales the image into the inner
// (1-2b) rect and draws the rebate / matte + sprocket holes around it. Runs
// LAST in the op chain (nothing draws over the frame). Model mirrored by
// frame.ts -- this shader and the CPU geometry helpers must stay in sync.
//
// Styles (uniform `style`):
//   3 'none'  -- no frame (border 0, identity)
//   0 '135'   -- black rebate + sprocket holes top & bottom
//   1 '120'   -- black rebate, no holes (paper-backed)
//   2 'print' -- white matte (darkroom print)
//
// ponytail: nearest-neighbor downscale (the op chain has no sampler binding --
// textureLoad only) is fine at a 5-10% shrink; box-average it if jitter shows.
// Holes are plain rects, no rounding; widths are fixed per style.

struct Frame {
  style: f32,      // 0/1/2/3
  cropFracX: f32,  // crop mask / texture (see crop.ts); 1 = no crop
  cropFracY: f32,
  _pad0: f32,
};

// Border band as a fraction of the frame (matches FRAME_BORDER in frame.ts).
fn borderF(style: u32) -> f32 {
  if (style == 2u) { return 0.10; }
  if (style == 1u) { return 0.05; }
  if (style == 3u) { return 0.0; }
  return 0.06;
}

// Sprocket-hole row height as a fraction of the frame; 0 = no holes.
fn holeF(style: u32) -> f32 {
  if (style == 3u) { return 0.0; }
  if (style == 2u) { return 0.0; }
  if (style == 1u) { return 0.0; }
  return 0.018;
}

// Rebate color per style: near-black for film, off-white for the print matte.
fn rebateColor(style: u32) -> vec3<f32> {
  if (style == 2u) { return vec3<f32>(0.96, 0.96, 0.96); }
  return vec3<f32>(0.02, 0.02, 0.02);
}

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Frame;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let style = u32(p.style);
  let b = borderF(style);
  let cfx = max(p.cropFracX, 1e-3);
  let cfy = max(p.cropFracY, 1e-3);
  let nx = (f32(id.x) + 0.5) / f32(dims.x);
  let ny = (f32(id.y) + 0.5) / f32(dims.y);

  // The crop op leaves its content centered in the texture, black outside
  // (cropFrac = 1,1 when there's no crop -> the crop region IS the texture,
  // so every formula below reduces to the no-crop geometry). The frame wraps
  // the CROP rect: rebate of border b around it, image = the crop rect
  // shrunk by b -- exactly the no-crop layout applied inside the crop.
  let cropL = (1.0 - cfx) * 0.5;
  let cropT = (1.0 - cfy) * 0.5;
  let bx = b * cfx; // border thickness in texture space
  let by = b * cfy;
  let imgL = cropL + bx;
  let imgR = cropL + cfx - bx;
  let imgT = cropT + by;
  let imgB = cropT + cfy - by;

  // Beyond the rebate -> letterbox black (only exists with a crop).
  if (nx < cropL || nx > cropL + cfx || ny < cropT || ny > cropT + cfy) {
    textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Inside the image rect -> sample the crop region, scaled down (nearest).
  if (nx > imgL && nx < imgR && ny > imgT && ny < imgB) {
    let fx = (nx - cropL) / cfx; // 0..1 across the crop content
    let fy = (ny - cropT) / cfy;
    let sx = cropL + clamp((fx - b) / (1.0 - 2.0 * b), 0.0, 1.0) * cfx;
    let sy = cropT + clamp((fy - b) / (1.0 - 2.0 * b), 0.0, 1.0) * cfy;
    let sxi = min(u32(floor(sx * f32(dims.x))), dims.x - 1u);
    let syi = min(u32(floor(sy * f32(dims.y))), dims.y - 1u);
    let c = textureLoad(inTex, vec2<i32>(i32(sxi), i32(syi)), 0);
    textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(c.rgb, 1.0));
    return;
  }

  // Rebate band. Sprocket holes read as lighter than the black rebate (light
  // passes through), so a pixel inside a hole is repainted light. Hole pitch
  // is relative to the crop content so it scales with the framed image.
  var color = rebateColor(style);
  let hole = holeF(style);
  if (hole > 0.0) {
    let px = (nx - cropL) / cfx;
    let phase = px / 0.055 - floor(px / 0.055);
    let inCell = phase < 0.6;
    if (inCell) {
      let half = hole * 0.5;
      let topBand = abs(ny - (cropT + by * 0.5)) < half;
      let bottomBand = abs(ny - (cropT + cfy - by * 0.5)) < half;
      if (topBand || bottomBand) {
        color = vec3<f32>(0.18, 0.18, 0.22); // hole: light spills through
      }
    }
  }
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(color, 1.0));
}
