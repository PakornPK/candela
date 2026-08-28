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
// NOTE (case #4 -> now): '135' sprocket holes are a vendored film-strip TEXTURE
// (public/frames/135-strip.png) sampled by frame.wgsl, not procedural geometry.
// The texture is a clean REGULAR grid of rounded holes -- case #4's irregular +
// grainy v1 read as messy "dots" ("เห็นมีหลายจุด"), so it went back to a tidy
// repeating pattern. FRAME_HOLE / inSprocketHole were removed with the old
// procedural holes.

export function isNeutralFrame(style: FrameStyle): boolean {
  return style === 'none';
}

export function frameStyleId(style: FrameStyle): number {
  return style === 'none' ? 3 : style === '135' ? 0 : style === '120' ? 1 : 2;
}

// Uniform layout: style id + the crop mask rect [x, y, w, h] (from crop.ts),
// [0,0,1,1] = no crop -- the frame wraps the image inside the crop, black bars
// beyond (frame.wgsl's crop branch).
export function packFrame(style: FrameStyle, region: [number, number, number, number] = [0, 0, 1, 1]): Float32Array {
  return new Float32Array([frameStyleId(style), region[0], region[1], region[2], region[3], 0, 0, 0]);
}

// Map an output-fraction coordinate to the source-image fraction, given the
// border b: the inner rect [b, 1-b] maps to [0, 1].
export function imageSource(nx: number, b: number): number {
  return Math.min(Math.max((nx - b) / (1 - 2 * b), 0), 1);
}
