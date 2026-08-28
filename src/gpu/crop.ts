// CPU-side model for the Crop op (crop.wgsl) — LrC's crop tool: preset aspect
// + 90° rotation + straighten + a FREE RECT (x/y/w/h) the workbench overlay
// drags. Pure + unit-tested: the GPU shader reads the packed uniform
// (angle/zoom/half-extents/center) and does the same inverse mapping, but the
// geometry (which source region a preset captures, how far a straighten zooms)
// is verifiable here without a browser.
//
// Model:
//   - cropRect: the source-space rect a crop captures — the largest centered
//     rect of a preset aspect, or the freeform x/y/w/h (normalized center +
//     size) the overlay committed. A 90° rotation swaps the preset's aspect (a
//     3:2 crop rotated 90° captures a 2:3 source rect so it DISPLAYS 3:2).
//   - cropGeometry: the output mask = the rotated rect's axis-aligned bbox
//     (centered on the rect), scaled by `zoom` to fit the texture. Inside the
//     mask the source is sampled at R(-angle)·o/zoom around the rect center,
//     so the rotated+zoomed crop fills it with no clipped corners. Outside =
//     black (the bars LrC letterboxes a crop into).
//   - The crop is drawn at SOURCE SCALE: the fixed-size canvas (sized to the
//     source) shows it fit-to-window exactly like LrC's loupe, and the op-chain
//     textures never resize.
//   - cropRegion: the normalized [x, y, w, h] of the mask bbox — what the
//     export/histogram blit samples and the frame/vignette treat as "the
//     image". [0,0,1,1] with no crop = identity.
//
// ponytail: the straighten zoom fits the rotated crop inside the SOURCE (no
// black corner wedges) rather than LrC's cover-to-fill — at ≤5° the 1-2%
// difference is invisible. Freeform resize locks only to the preset aspect
// (edge handles act free); the rect is axis-aligned, straighten still rotates
// the image inside it.

import { isCropOp, type AspectPreset, type Op } from '../catalog/types';

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  'original', '1:1', '3:2', '4:3', '5:4', '16:9', '2:3', '4:5',
];

// Target aspect ratio per preset ('original' = the source, resolved per file).
export const ASPECT_RATIO: Record<AspectPreset, number> = {
  'original': 0,
  '1:1': 1,
  '3:2': 1.5,
  '4:3': 4 / 3,
  '5:4': 1.25,
  '16:9': 16 / 9,
  '2:3': 2 / 3,
  '4:5': 0.8,
};

export interface CropParams {
  aspect: AspectPreset;
  rotate90: number; // 0..3 clockwise quarter-turns
  angle: number;    // straighten, -45..45 degrees
  // Freeform rect the workbench overlay drags (normalized 0..1): x/y = rect
  // center, w/h = size, fractions of the source. Absent = the centered preset
  // (LrC picks a preset -> centered; dragging commits x/y/w/h).
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function isFreeformCrop(c: CropParams): boolean {
  return typeof c.x === 'number' && typeof c.y === 'number' && typeof c.w === 'number' && typeof c.h === 'number';
}

export function isNeutralCrop(c: CropParams): boolean {
  if (c.aspect !== 'original' || c.rotate90 !== 0 || c.angle !== 0) return false;
  if (!isFreeformCrop(c)) return true;
  return c.x === 0.5 && c.y === 0.5 && c.w === 1 && c.h === 1;
}

// Source-space capture rect, in pixels (center + size).
export function cropRect(c: CropParams, W: number, H: number): { cx: number; cy: number; cw: number; ch: number } {
  if (isFreeformCrop(c)) {
    const cw = Math.min(c.w! * W, W);
    const ch = Math.min(c.h! * H, H);
    // Clamp the rect inside the source (a drag can push a corner out).
    const cx = Math.min(Math.max(c.x! * W, cw / 2), W - cw / 2);
    const cy = Math.min(Math.max(c.y! * H, ch / 2), H - ch / 2);
    return { cx, cy, cw, ch };
  }
  if (c.aspect === 'original') return { cx: W / 2, cy: H / 2, cw: W, ch: H };
  let a = ASPECT_RATIO[c.aspect];
  if (c.rotate90 % 2 === 1) a = 1 / a;
  const cw = a >= W / H ? W : H * a;
  const ch = a >= W / H ? W / a : H;
  return { cx: W / 2, cy: H / 2, cw, ch };
}

export interface CropGeometry {
  angle: number; // radians (90° steps + straighten)
  zoom: number;  // fit factor >= 1
  halfW: number; // mask half-extent, output pixels
  halfH: number;
  maskW: number; // mask full extent, output pixels
  maskH: number;
  cx: number;    // mask center, output pixels (the rect center)
  cy: number;
}

export function cropGeometry(c: CropParams, W: number, H: number): CropGeometry {
  const { cx, cy, cw, ch } = cropRect(c, W, H);
  const angle = (c.rotate90 * Math.PI) / 2 + (c.angle * Math.PI) / 180;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const bw = cw * Math.abs(ca) + ch * Math.abs(sa); // rotated bbox width
  const bh = cw * Math.abs(sa) + ch * Math.abs(ca); // rotated bbox height
  const zoom = Math.max(1, bw / W, bh / H);
  const maskW = bw / zoom;
  const maskH = bh / zoom;
  return { angle, zoom, halfW: maskW / 2, halfH: maskH / 2, maskW, maskH, cx, cy };
}

// Uniform layout must match the `Crop` struct in crop.wgsl (6 f32s + 2 pad).
export function packCrop(c: CropParams, W: number, H: number): Float32Array {
  const g = cropGeometry(c, W, H);
  return new Float32Array([g.angle, g.zoom, g.halfW, g.halfH, g.cx, g.cy, 0, 0]);
}

// The crop selection as a screen-space rect (texture pixels): the mask bbox
// centered in the source, rotated by the straighten angle. The DOM crop
// overlay (#2 workbench) draws exactly this -- rect + dim outside -- so the
// view shows the FULL image with a live crop selection instead of baked
// letterbox bars.
export interface CropOverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number; // radians, matches the packed crop uniform
}

export function cropOverlayRect(c: CropParams, W: number, H: number): CropOverlayRect {
  const g = cropGeometry(c, W, H);
  return { x: g.cx - g.halfW, y: g.cy - g.halfH, w: g.maskW, h: g.maskH, angle: g.angle };
}

// The crop mask bbox as a normalized [x, y, w, h] rect (left/top/size, 0..1) —
// what the export/histogram blit samples and the frame/vignette treat as "the
// image" (LrC's Post-Crop). [0,0,1,1] when no crop op is present = identity.
// Guarded for unloaded sizes so the vignette/frame packParams can call it in
// tests before any load.
export function cropRegion(ops: Op[], W: number, H: number): [number, number, number, number] {
  if (W <= 0 || H <= 0) return [0, 0, 1, 1];
  const c = ops.find(isCropOp);
  if (!c) return [0, 0, 1, 1];
  const g = cropGeometry(c, W, H);
  return [(g.cx - g.halfW) / W, (g.cy - g.halfH) / H, g.maskW / W, g.maskH / H];
}
