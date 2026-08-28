// CPU-side model for the Crop op (crop.wgsl) — LrC's crop tool: preset aspect
// + 90° rotation + straighten. Pure + unit-tested: the GPU shader reads the
// packed uniform (angle/zoom/half-extents) and does the same inverse mapping,
// but the geometry (which source region a preset captures, how far a straighten
// zooms) is verifiable here without a browser.
//
// Model:
//   - cropRect: the source-space rect a preset captures — the largest centered
//     rect of that aspect. A 90° rotation swaps the preset's aspect (a 3:2 crop
//     rotated 90° captures a 2:3 source rect so it DISPLAYS 3:2).
//   - cropGeometry: the output mask = the rotated rect's axis-aligned bbox,
//     scaled by `zoom` to fit the texture. Inside the mask the source is
//     sampled at R(-angle)·o/zoom, so the rotated+zoomed crop fills it with no
//     clipped corners. Outside = black (the bars LrC letterboxes a crop into).
//   - The crop is drawn at SOURCE SCALE, centered: the fixed-size canvas (sized
//     to the source) shows it fit-to-window exactly like LrC's loupe, and the
//     op-chain textures never resize.
//
// ponytail: the straighten zoom fits the rotated crop inside the SOURCE (no
// black corner wedges) rather than LrC's cover-to-fill — at ≤5° the 1-2%
// difference is invisible. Preset aspects are centered; no freeform
// drag/reposition (add a drag overlay when the crop tool gets one).

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
}

export function isNeutralCrop(c: CropParams): boolean {
  return c.aspect === 'original' && c.rotate90 === 0 && c.angle === 0;
}

// Source-space capture rect, in pixels.
export function cropRect(c: CropParams, W: number, H: number): { cw: number; ch: number } {
  if (c.aspect === 'original') return { cw: W, ch: H };
  let a = ASPECT_RATIO[c.aspect];
  if (c.rotate90 % 2 === 1) a = 1 / a;
  return a >= W / H ? { cw: W, ch: W / a } : { cw: H * a, ch: H };
}

export interface CropGeometry {
  angle: number; // radians (90° steps + straighten)
  zoom: number;  // fit factor >= 1
  halfW: number; // mask half-extent, output pixels
  halfH: number;
  maskW: number; // mask full extent, output pixels
  maskH: number;
}

export function cropGeometry(c: CropParams, W: number, H: number): CropGeometry {
  const { cw, ch } = cropRect(c, W, H);
  const angle = (c.rotate90 * Math.PI) / 2 + (c.angle * Math.PI) / 180;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const bw = cw * Math.abs(ca) + ch * Math.abs(sa); // rotated bbox width
  const bh = cw * Math.abs(sa) + ch * Math.abs(ca); // rotated bbox height
  const zoom = Math.max(1, bw / W, bh / H);
  const maskW = bw / zoom;
  const maskH = bh / zoom;
  return { angle, zoom, halfW: maskW / 2, halfH: maskH / 2, maskW, maskH };
}

// Uniform layout must match the `Crop` struct in crop.wgsl (4 f32s + 4 pad).
export function packCrop(c: CropParams, W: number, H: number): Float32Array {
  const g = cropGeometry(c, W, H);
  return new Float32Array([g.angle, g.zoom, g.halfW, g.halfH, 0, 0, 0, 0]);
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
  return { x: (W - g.maskW) / 2, y: (H - g.maskH) / 2, w: g.maskW, h: g.maskH, angle: g.angle };
}

// Fraction of the texture the crop mask occupies — the vignette's post-crop
// frame, the frame's inner rect, and the export/histogram blit region. (1,1)
// when no crop op is present = identity. Guarded for unloaded sizes so the
// vignette/frame packParams can call it in tests before any load.
export function cropFracFromOps(ops: Op[], W: number, H: number): [number, number] {
  if (W <= 0 || H <= 0) return [1, 1];
  const c = ops.find(isCropOp);
  if (!c) return [1, 1];
  const g = cropGeometry(c, W, H);
  return [g.maskW / W, g.maskH / H];
}
