// Crop + rotate: map each output pixel to its source sample via the inverse
// rotation, masked to the rotated IMAGE's axis-aligned bbox. Outside the mask
// is black — the bars LrC letterboxes a crop into; the same black fills the
// bbox's empty corners (samples past the source's extent), the loupe backdrop.
// The mask is centered on the crop rect (cx,cy — the texture center for a
// preset, the freeform rect's center when the overlay drags it) and scaled to
// fit, so the fixed-size canvas shows the WHOLE image rotated fit-in-window
// exactly like LrC's crop loupe — a straighten tilts the entire image under
// the DOM selection frame, and the image's corners beyond the frame are what
// the overlay dims / the export trims. Bilinear source sampling keeps the crop
// smooth; 90° and straighten share the same inverse-map (rotate90·π/2 +
// angle·π/180) so rotating a straightened crop keeps the rotation cumulative.

struct Crop {
  angle: f32,
  zoom: f32,
  halfW: f32,
  halfH: f32,
  cx: f32,
  cy: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Crop;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(srcTex);
  let pos = vec2<i32>(gid.xy);
  if (any(pos >= vec2<i32>(dims))) {
    return;
  }

  let id = vec2<f32>(pos);
  let center = vec2<f32>(p.cx, p.cy);

  // ponytail: a pure aspect crop (no 90° turn, no straighten) is the workbench
  // identity -- the FULL image stays on screen and the crop is a DOM rect+dim
  // overlay (#2). No-rotation crops never needed the letterbox bars in the
  // view (that was the "crop refits / zooms in" jump); the export, frame,
  // vignette and histogram all sample the cropFrac region themselves. Any
  // rotation (angle != 0) keeps the transform below -- the export must rotate.
  if (abs(p.angle) < 1e-6) {
    textureStore(dstTex, pos, textureLoad(srcTex, pos, 0));
    return;
  }

  // Output-space offset from the crop rect center.
  let o = id - center;

  // Outside the rotated crop's bbox -> letterbox bar.
  if (abs(o.x) > p.halfW || abs(o.y) > p.halfH) {
    textureStore(dstTex, pos, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Inverse rotation: src = R(-angle) · (o · zoom) + center. The mask is the
  // rotated bbox scaled DOWN by zoom to fit the source, so its boundary maps
  // back to the FULL crop rect via o·zoom -- dividing (o/zoom) sampled only a
  // center slice at 90° (a 1.8x zoom-in, the "rotate 90 ซูม" bug). At zoom=1
  // (every ≤5° straighten, unrotated presets) the two forms are identical.
  // A pure 90° rotation has exact cos/sin in f32; straighten is f32-accurate.
  let ca = cos(p.angle);
  let sa = sin(p.angle);
  let r = o * p.zoom;
  let sx = r.x * ca + r.y * sa + center.x;  // R(-angle) row 0: [cos, sin]
  let sy = -r.x * sa + r.y * ca + center.y; // R(-angle) row 1: [-sin, cos]

  // Past the source's extent (the rotated image's empty bbox corners, or a
  // freeform rect overhanging the edge) -> the loupe backdrop, not a clamped
  // edge smear. The selection frame lands on the rotated image's edges, so the
  // Done export never samples these.
  if (sx < 0.0 || sy < 0.0 || sx >= f32(dims.x) || sy >= f32(dims.y)) {
    textureStore(dstTex, pos, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Clamp in-range samples to the source's last texel (a 90° rotation of an
  // asymmetric source can round a pixel out by a hair).
  let maxv = vec2<f32>(dims) - 1.0;
  let s = clamp(vec2<f32>(sx, sy), vec2<f32>(0.0), maxv);

  // Manual bilinear (4× textureLoad) — a sampler + filtered sample cannot
  // feed a storage texture, and nearest alone aliases on rotation.
  let b = floor(s);
  let t = s - b;
  let c00 = textureLoad(srcTex, vec2<i32>(b), 0).rgb;
  let c10 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(1.0, 0.0), maxv)), 0).rgb;
  let c01 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(0.0, 1.0), maxv)), 0).rgb;
  let c11 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(1.0, 1.0), maxv)), 0).rgb;
  let c = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
  textureStore(dstTex, pos, vec4<f32>(c, 1.0));
}
