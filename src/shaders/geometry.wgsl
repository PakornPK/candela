// Geometry / LrC Transform: warp each output pixel to its source sample via
// the homography in geometry.ts (offset -> aspect -> rotate+scale ->
// perspective keystone). Output is the full texture; where the warp maps
// outside the source the bilinear clamp holds the edge color (LrC shows the
// same stretched edge). This runs BEFORE the crop op so the crop rect is
// applied to the already-transformed frame. Same warp-op shape as crop.wgsl.
struct Geometry {
  angle: f32,   // rotate, radians
  scale: f32,   // scale/100 (1 = 1:1)
  aspect: f32,  // aspect/100
  hp: f32,      // horizontal/100
  vp: f32,      // vertical/100
  ox: f32,      // offsetX/100
  oy: f32,      // offsetY/100
  _pad0: f32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Geometry;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(srcTex);
  let pos = vec2<i32>(gid.xy);
  if (any(pos >= vec2<i32>(dims))) {
    return;
  }

  // Output pixel in [-1, 1]^2.
  let x = (f32(gid.x) + 0.5) * 2.0 / f32(dims.x) - 1.0;
  let y = (f32(gid.y) + 0.5) * 2.0 / f32(dims.y) - 1.0;

  let ca = cos(p.angle);
  let sa = sin(p.angle);
  let u0 = x - p.ox;
  let v0 = y - p.oy;
  let u1 = u0 * (1.0 + p.aspect);
  let v1 = v0 * (1.0 - p.aspect);
  let u2 = p.scale * (u1 * ca - v1 * sa);
  let v2 = p.scale * (u1 * sa + v1 * ca);
  let denom = max(1.0 + p.hp * u2 + p.vp * v2, 1e-3);
  let su = u2 / denom;
  let sv = v2 / denom;

  let sx = (su * 0.5 + 0.5) * f32(dims.x);
  let sy = (sv * 0.5 + 0.5) * f32(dims.y);
  let maxv = vec2<f32>(dims) - 1.0;
  let s = clamp(vec2<f32>(sx, sy), vec2<f32>(0.0), maxv);

  // Manual bilinear (4x textureLoad) -- same as crop.wgsl.
  let b = floor(s);
  let t = s - b;
  let c00 = textureLoad(srcTex, vec2<i32>(b), 0).rgb;
  let c10 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(1.0, 0.0), maxv)), 0).rgb;
  let c01 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(0.0, 1.0), maxv)), 0).rgb;
  let c11 = textureLoad(srcTex, vec2<i32>(min(b + vec2<f32>(1.0, 1.0), maxv)), 0).rgb;
  let c = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
  textureStore(dstTex, pos, vec4<f32>(c, 1.0));
}
