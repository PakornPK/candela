// CPU-side model for the Frame op (frame.wgsl). Pure + unit-tested: the GPU
// shader draws the film rebate / print matte around a scaled-down image, this
// file is the same geometry so the layout is verifiable without a browser.
//
// Analog frame variants (a creative Effects panel look, not in LrC):
//   'none'  -- no frame (identity; style id 3, border 0)
//   '135'   -- 35mm: black rebate with a row of sprocket holes top + bottom
//   '120'   -- medium format: black rebate, no holes (paper-backed)
//   'print' -- darkroom print: generous white matte
// The image is scaled into the inner (1-2b) rect (nearest, in the shader), so
// the border is real -- the rebate is extra width, not painted over the photo.
//
// ponytail: nearest-neighbor downscale (no sampler binding in the op chain)
// is fine at a 5-10% shrink; box-averaging would smooth it if the user flags
// jitter. Holes are plain rects, no rounding. Widths are fixed per style.

export type FrameStyle = 'none' | '135' | '120' | 'print';

// Border band as a fraction of the frame, per style ('none' = 0, identity).
// Matches borderF() in frame.wgsl.
export const FRAME_BORDER: Record<FrameStyle, number> = {
  'none': 0,
  '135': 0.06,
  '120': 0.05,
  'print': 0.1,
};

// Sprocket-hole row height as a fraction of the frame (0 = no holes). Matches
// holeF() in frame.wgsl.
export const FRAME_HOLE: Record<FrameStyle, number> = {
  'none': 0,
  '135': 0.018,
  '120': 0,
  'print': 0,
};

export function isNeutralFrame(style: FrameStyle): boolean {
  return style === 'none';
}

export function frameStyleId(style: FrameStyle): number {
  return style === 'none' ? 3 : style === '135' ? 0 : style === '120' ? 1 : 2;
}

// Uniform layout: style id + cropFrac X/Y + 1 pad. cropFrac = the crop mask /
// texture (from crop.ts), 1,1 = no crop -- the frame wraps the image inside
// the crop, black bars beyond (frame.wgsl's crop branch).
export function packFrame(style: FrameStyle, cropFrac: [number, number] = [1, 1]): Float32Array {
  return new Float32Array([frameStyleId(style), cropFrac[0], cropFrac[1], 0]);
}

// Map an output-fraction coordinate to the source-image fraction, given the
// border b: the inner rect [b, 1-b] maps to [0, 1].
export function imageSource(nx: number, b: number): number {
  return Math.min(Math.max((nx - b) / (1 - 2 * b), 0), 1);
}

// True when the pixel at normalized (nx, ny) is inside a sprocket hole: a
// repeating rect cell along the top/bottom rebate bands. Cell pitch 0.055,
// hole filling the first 0.6 of the cell (width ~0.033). Matches frame.wgsl.
export function inSprocketHole(nx: number, ny: number, style: Exclude<FrameStyle, 'none'>): boolean {
  const hole = FRAME_HOLE[style];
  if (hole <= 0) return false;
  const b = FRAME_BORDER[style];
  const phase = nx / 0.055 - Math.floor(nx / 0.055);
  if (phase >= 0.6) return false;
  const top = Math.abs(ny - b / 2) < hole / 2;
  const bottom = Math.abs(ny - (1 - b / 2)) < hole / 2;
  return top || bottom;
}
