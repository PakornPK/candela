// 2x2 box-average halving (exact area filter): every output texel is the mean
// of a 2x2 input block, so every source texel contributes equally. exportImage
// pyramids with this before its final blit -- a single bilinear 8x leap from
// 60MP to the 1080px IG preset smears fine detail (LrC resamples with a
// proper area/Lanczos kernel, not one interpolating step). Edge texels clamp
// (odd dims duplicate the last row/col -- weight 2/4 on the edge, fine).
@group(0) @binding(0) var inTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let outDims = textureDimensions(outTex);
  if (id.x >= outDims.x || id.y >= outDims.y) { return; }
  let inDims = textureDimensions(inTex);
  let x0 = id.x * 2u;
  let y0 = id.y * 2u;
  let x1 = min(x0 + 1u, inDims.x - 1u);
  let y1 = min(y0 + 1u, inDims.y - 1u);
  let c = textureLoad(inTex, vec2<i32>(i32(x0), i32(y0)), 0)
        + textureLoad(inTex, vec2<i32>(i32(x1), i32(y0)), 0)
        + textureLoad(inTex, vec2<i32>(i32(x0), i32(y1)), 0)
        + textureLoad(inTex, vec2<i32>(i32(x1), i32(y1)), 0);
  textureStore(outTex, vec2<i32>(id.xy), c * 0.25);
}
