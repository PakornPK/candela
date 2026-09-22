struct Levels {
  blackLevel: f32,
  whiteLevel: f32,
};

// Sensor-orientation flip (LibRaw imgdata.sizes.flip decomposed to bit
// flags, 0/1 each) plus the effective-area rect inside the raw grid. The
// normalize pass doubles as the orientation pass: it READS the bayer
// texture (the FULL raw grid) at [srcLeft, srcTop, srcWidth, srcHeight]
// and SCATTERS normalized values into an output texel under the flip
// mapping, so the normalized texture is already upright and every
// downstream pass (demosaic, ops, blit, histogram, export, the navigator
// readback) needs zero orientation knowledge. See pipeline.load() for why
// the flip lives here rather than in demosaic.wgsl.
struct Orientation {
  swap: u32,   // flip & 4: transpose (output x = sensor y)
  flipY: u32,  // flip & 2: sensor rows reversed
  flipX: u32,  // flip & 1: sensor cols reversed
  _pad: u32,
  srcLeft: u32, // effective-area origin within the raw grid
  srcTop: u32,
  srcWidth: u32,  // effective-area size (the pre-flip grid)
  srcHeight: u32,
};

@group(0) @binding(0) var bayerTex: texture_2d<u32>;
@group(0) @binding(1) var normalizedTex: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> levels: Levels;
@group(0) @binding(3) var<uniform> orient: Orientation;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // Dispatch runs over the effective-area rect only (see dispatchUnpack):
  // sensor-margin pixels (zeros on the Fuji) never enter the output, which
  // keeps the dark-bar fix of the old upload-time crop.
  if (id.x >= orient.srcWidth || id.y >= orient.srcHeight) {
    return;
  }
  let src = vec2<i32>(i32(orient.srcLeft), i32(orient.srcTop));
  let raw = f32(textureLoad(bayerTex, vec2<i32>(i32(id.x), i32(id.y)) + src, 0).r);
  let range = max(levels.whiteLevel - levels.blackLevel, 1.0);
  let normalized = clamp((raw - levels.blackLevel) / range, 0.0, 1.0);

  // The dcraw/LibRaw flip composition (flip applied at output gather by
  // flip_index -- src/write/file_write.cpp:20): mirrors act in SENSOR space
  // with SENSOR bounds, THEN the transpose. Written forward (sensor ->
  // output) as the scatter. This mirrors src/gpu/orient.ts mapOutputPoint
  // exactly -- orient.test.ts pins that pair against a TS mirror of
  // LibRaw's flip_index gather (a full-grid bijection check); keep both in
  // lockstep.
  var x = id.x;
  var y = id.y;
  if (orient.flipY == 1u) {
    y = orient.srcHeight - 1u - y;
  }
  if (orient.flipX == 1u) {
    x = orient.srcWidth - 1u - x;
  }
  if (orient.swap == 1u) {
    let t = x;
    x = y;
    y = t;
  }
  textureStore(normalizedTex, vec2<i32>(i32(x), i32(y)), vec4<f32>(normalized, 0.0, 0.0, 0.0));
}
