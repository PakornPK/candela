// Sensor-orientation (EXIF flip) math -- pure helpers, unit-testable.
//
// LibRaw computes imgdata.sizes.flip (0..7) during open_buffer/identify()
// from EXIF Orientation or camera makernote rotation flags (vendored source:
// src/metadata/tiff.cpp:631 maps EXIF tag 274 through "50132467"[o&7]-'0';
// src/metadata/identify.cpp:1287-1305 finalizes it + the degrees form).
// LibRaw 0.22.2 never pixel-flips the raw bitmap: it applies flip at OUTPUT
// GATHER time via flip_index() (src/write/file_write.cpp:20-29, called from
// the write loop at :224-226, with iheight=H/iwidth=W and output dims
// swapped first at :182-183):
//
//   int flip_index(row, col) {            // (row,col) = OUTPUT coords
//     if (flip & 4) SWAP(row, col);       // undo the output transpose
//     if (flip & 2) row = iheight-1-row;  // sensor-row mirror (sensor bounds)
//     if (flip & 1) col = iwidth-1-col;   // sensor-col mirror (sensor bounds)
//     return row * iwidth + col;          // sensor index
//   }
//
// Reading that backwards gives the FORWARD (sensor -> output) mapping used
// here and mirrored in unpack.wgsl: apply the mirrors FIRST in sensor space
// with the SENSOR bounds (srcW/srcH), then the transpose. mem_image.cpp
// (:220-230) confirms: it restores S.iheight=S.height (sensor dims),
// swaps S.height/S.width alone, and indexes with flip_index -- so the
// &2/&1 mirror bounds are the sensor dims, not the output dims.
//
// For EXIF Orientation 6 (Rotate 90 CW) LibRaw sets flip=6 (&4|&2):
// out = (srcH-1-y, x) -- the sensor top edge lands on the output right
// edge, i.e. a true 90 deg clockwise rotation of the landscape sensor grid.

export interface Orientation {
  /** 1 when flip & 4: output (x,y) = transpose of the mirrored sensor point. */
  swap: number;
  /** 1 when flip & 2: vertical mirror (sensor rows reversed). */
  flipY: number;
  /** 1 when flip & 1: horizontal mirror (sensor cols reversed). */
  flipX: number;
}

export function orientationFromFlip(flip: number): Orientation {
  return { swap: flip & 4 ? 1 : 0, flipY: flip & 2 ? 1 : 0, flipX: flip & 1 ? 1 : 0 };
}

/** Output dimensions for a srcW x srcH (effective-area) grid under `flip`. */
export function flippedDims(flip: number, srcW: number, srcH: number): [number, number] {
  return flip & 4 ? [srcH, srcW] : [srcW, srcH];
}

/**
 * Forward map: sensor-space input texel (x, y) (already cropped to the
 * effective area, so 0 <= x < srcW, 0 <= y < srcH) -> output texel. Mirror
 * with sensor bounds, then transpose (see header). This is the GPU
 * normalize pass's scatter formula (unpack.wgsl keeps the identical line
 * order); orient.test.ts pins it against a TS mirror of LibRaw's own
 * flip_index gather, which makes it a bijection check over the full grid.
 */
export function mapOutputPoint(
  o: Orientation,
  x: number,
  y: number,
  srcW: number,
  srcH: number,
): [number, number] {
  let ix = x;
  let iy = y;
  if (o.flipY) iy = srcH - 1 - iy;
  if (o.flipX) ix = srcW - 1 - ix;
  if (o.swap) {
    const t = ix;
    ix = iy;
    iy = t;
  }
  return [ix, iy];
}

/**
 * 6x6 CFA remap under flip (metadata: 36 tiny bytes -- CPU-legal, same
 * standing as packCfa6/shiftCfa6). Feed it the ALREADY margin-shifted
 * pattern (shiftCfa6's output) plus the effective-area dims; get back the
 * pattern demosaic should use in OUTPUT space.
 *
 * The sensor grid carries per-position CFA colors P6[y%6][x%6]; under the
 * flip mapping the output texel (ox, oy) holds sensor texel (x, y) =
 * mapOutputPoint^-1(ox, oy) -- undo the transpose first, then the mirrors
 * (in that inverse order, with the sensor bounds, so the srcW-1/srcH-1
 * mirror offsets must ride through as mod-6 phase shifts).
 *
 * Why the pattern swap is EXACT and colors never permute: LibRaw demosaics
 * in SENSOR space with the unrotated CFA and applies the flip only at
 * output gather (dcraw_process runs xtrans/interpolate before the writers'
 * flip_index walk). So a flip&4 code is a pure array transpose, not a
 * camera-space rotation -- after transposing, what used to be a sensor row
 * becomes an output column, and the CFA color at each output position is
 * whatever the sensor had at the transposed position (R stays R; the
 * transpose swaps the pattern's axes -- X-Trans VI is NOT transpose-
 * symmetric, so ignoring that renders G-heavy rows as columns and shows up
 * as false color along edges; the mirrors shift the 6-phase). The
 * interpolation itself is transpose-equivariant for our kernel (ring and
 * distance-2 cross map onto each other under transpose), so demosaicing in
 * output space with this remapped pattern reproduces LibRaw's picture.
 */
export function remapCfa6(shifted: Uint8Array, flip: number, srcW: number, srcH: number): Uint8Array {
  const out = new Uint8Array(36);
  if (flip === 0) {
    out.set(shifted);
    return out;
  }
  const o = orientationFromFlip(flip);
  for (let oy = 0; oy < 6; oy++) {
    for (let ox = 0; ox < 6; ox++) {
      // Inverse of mapOutputPoint: undo swap, then undo mirrors (mod 6 --
      // the pattern is 6-periodic, and outW/outH are 6-periodic images of
      // srcH/srcW so a 6x6 output sweep covers every phase exactly).
      let my = o.swap ? ox : oy;
      let mx = o.swap ? oy : ox;
      if (o.flipY) my = (srcH - 1 - my) % 6;
      if (o.flipX) mx = (srcW - 1 - mx) % 6;
      out[oy * 6 + ox] = shifted[(((my % 6) + 6) % 6) * 6 + ((mx % 6) + 6) % 6];
    }
  }
  return out;
}
