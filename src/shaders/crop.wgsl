// Crop + rotate: map each output pixel to its source sample via the inverse
// rotation, masked to the rotated crop's axis-aligned bbox. Outside the mask
// is black — the bars LrC letterboxes a crop into. The mask is centered in
// the full-res texture and scaled to fit, so the fixed-size canvas shows the
// crop fit-in-window exactly like LrC's loupe (crop fills one dimension, the
// bars the other). Bilinear source sampling keeps the crop smooth; 90° and
// straighten share the same inverse-map (rotate90·π/2 + angle·π/180) so
// rotating a straightened crop keeps the rotation cumulative.
//
// ponytail: the mask fits the rotated rect inside the source (no black corner
// wedges) rather than LrC's cover-to-fill — indistinguishable at ≤5°.

struct Crop {
  angle: f32,
  zoom: f32,
  halfW: f32,
  halfH: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
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
  let center = vec2<f32>(dims) * 0.5;

  // Output-space offset from the texture center (the crop is centered).
  let o = id - center;

  // Outside the rotated crop's bbox -> letterbox bar.
  if (abs(o.x) > p.halfW || abs(o.y) > p.halfH) {
    textureStore(dstTex, pos, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Inverse rotation: src = R(-angle) · (o / zoom) + center. A pure 90°
  // rotation has exact cos/sin in f32; straighten is f32-accurate.
  let ca = cos(p.angle);
  let sa = sin(p.angle);
  let r = o / p.zoom;
  let sx = r.x * ca + r.y * sa + center.x;  // R(-angle) row 0: [cos, sin]
  let sy = -r.x * sa + r.y * ca + center.y; // R(-angle) row 1: [-sin, cos]

  // Clamp to the source (the crop rect never extends past it, but a 90°
  // rotation of an asymmetric source could round a pixel out by a hair).
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
