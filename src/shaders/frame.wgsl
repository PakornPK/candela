// Film frame (creative Effects panel look). Scales the image into the inner
// (1-2b) rect and draws the rebate / matte + sprocket holes around it. Runs
// LAST in the op chain (nothing draws over the frame). Model mirrored by
// frame.ts -- this shader and the CPU geometry helpers must stay in sync.
//
// Styles (uniform `style`):
//   3 'none'  -- no frame (border 0, identity)
//   0 '135'   -- real sprocket holes + dark rebate (135-strip.png, layer 0)
//   1 '120'   -- real dark paper backing (120-strip.png, layer 1)
//   2 'print' -- real off-white matte paper (print-strip.png, layer 2)
//
// ponytail: nearest-neighbor downscale (the op chain has no sampler binding --
// textureLoad only) is fine at a 5-10% shrink; box-average it if jitter shows.

struct Frame {
  style: f32,      // 0/1/2/3
  cropX: f32,      // crop mask rect (see crop.ts): left/top/size, normalized;
  cropY: f32,      // [0,0,1,1] = no crop -- the frame wraps the image inside it
  cropW: f32,
  cropH: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

// Border band as a fraction of the frame (matches FRAME_BORDER in frame.ts).
fn borderF(style: u32) -> f32 {
  if (style == 2u) { return 0.10; }
  if (style == 1u) { return 0.05; }
  if (style == 3u) { return 0.0; }
  return 0.06;
}

@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Frame;
// Three vendored strip textures (public/frames/*-strip.png, scripts/
// vend-frames.mjs -- real film/paper photos, committed): layer 0 = '135'
// sprocket edge, 1 = '120' paper backing, 2 = 'print' matte. rgba8unorm-srgb:
// the bands are displayed colors (linearized by sampling -srgb), not additive.
@group(0) @binding(3) var frameTexs: texture_2d_array<f32>;
@group(0) @binding(4) var filmSamp: sampler;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let style = u32(p.style);
  let b = borderF(style);
  let cfx = max(p.cropW, 1e-3);
  let cfy = max(p.cropH, 1e-3);
  let nx = (f32(id.x) + 0.5) / f32(dims.x);
  let ny = (f32(id.y) + 0.5) / f32(dims.y);

  // The crop op leaves its content in the crop rect, black outside
  // ([0,0,1,1] when there's no crop -> the crop region IS the texture,
  // so every formula below reduces to the no-crop geometry). The frame wraps
  // the CROP rect: rebate of border b around it, image = the crop rect
  // shrunk by b -- exactly the no-crop layout applied inside the crop.
  let cropL = p.cropX;
  let cropT = p.cropY;
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

  // Rebate band: every style samples its own REAL strip texture (layer =
  // style: 0 '135' sprocket edge, 1 '120' paper backing, 2 'print' matte).
  // The band maps to the strip's top / bottom halves (uv.y 0..0.5 top,
  // 0.5..1 bottom); the photo itself is drawn by the image branch above,
  // never by the texture.
  let px2 = (nx - cropL) / cfx;      // 0..1 across the crop content
  var py = (ny - cropT) / cfy;
  let top = py < b;
  if (!top) { py = 1.0 - py; }
  let band = clamp(py / b, 0.0, 1.0); // 0..1 across the band thickness
  let uv = vec2<f32>(px2, select(band * 0.5 + 0.5, band * 0.5, top));
  let color = textureSampleLevel(frameTexs, filmSamp, uv, style, 0.0).rgb;
  textureStore(outTex, vec2<i32>(id.xy), vec4<f32>(color, 1.0));
}
