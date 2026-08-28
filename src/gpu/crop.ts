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

// Crop overlay interaction (the DOM workbench drags the freeform rect):
// - cropHandleAt: which handle (or move) a pointer is over.
// - dragCropRect: apply a pointer drag to the freeform rect, aspect-locked to
//   the preset, clamped inside the source. Pure + unit-tested -- main.ts just
//   feeds it the pointer delta and the source/crop state.
export type CropHandleMode = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// `hs` = handle radius in buffer px. The caller derives it from the DISPLAY
// scale (fixed CSS px / dispScale) so the grab zone stays grabbable at any
// buffer resolution -- a 6k photo shows the buffer at ~0.07x, which turned
// the old W-derived radius into a ~2 CSS px target (the "ย่อขยายไม่ได้" report).
export function cropHandleAt(r: { x: number; y: number; w: number; h: number }, bx: number, by: number, hs: number): CropHandleMode | null {
  const pt = { x: bx - r.x, y: by - r.y }; // rect-local (unrotated; angle is tiny for a live drag)
  if (pt.x >= -hs && pt.x <= r.w + hs && pt.y >= -hs && pt.y <= r.h + hs) {
    const col = pt.x < hs ? -1 : pt.x > r.w - hs ? 1 : 0;
    const row = pt.y < hs ? -1 : pt.y > r.h - hs ? 1 : 0;
    if (col === -1 && row === -1) return 'nw';
    if (col === 1 && row === -1) return 'ne';
    if (col === -1 && row === 1) return 'sw';
    if (col === 1 && row === 1) return 'se';
    if (col === 0 && row === -1) return 'n';
    if (col === 0 && row === 1) return 's';
    if (col === -1 && row === 0) return 'w';
    if (col === 1 && row === 0) return 'e';
    return 'move';
  }
  return null;
}

// The aspect the freeform rect must keep while resizing, or null = free.
// Matches cropRect's preset aspect (incl. the 90° flip).
export function lockedCropAspect(aspect: AspectPreset, rotate90: number): number | null {
  if (aspect === 'original') return null;
  let a = ASPECT_RATIO[aspect];
  if (rotate90 % 2 === 1) a = 1 / a;
  return a;
}

// Apply a drag to the freeform rect (normalized), clamped inside the source.
// `orig` is the pre-drag rect; `dxPx`/`dyPx` the pointer deltas in buffer px.
// Returns a NEW rect (normalized center + size), never mutates `orig`.
export function dragCropRect(
  mode: CropHandleMode,
  orig: { x: number; y: number; w: number; h: number },
  dxPx: number,
  dyPx: number,
  W: number,
  H: number,
  aspect: AspectPreset,
  rotate90: number,
): { x: number; y: number; w: number; h: number } {
  const cx = orig.x * W, cy = orig.y * H, cw = orig.w * W, ch = orig.h * H;
  if (mode === 'move') {
    // Clamp the stored rect so a re-grab starts from the same place the frame
    // is drawn (the overlay draws the CLAMPED geometry from cropRect).
    const ncx = Math.min(Math.max(cx + dxPx, cw / 2), W - cw / 2);
    const ncy = Math.min(Math.max(cy + dyPx, ch / 2), H - ch / 2);
    return { x: ncx / W, y: ncy / H, w: orig.w, h: orig.h };
  }
  // Resize: the opposite corner stays fixed; the dragged corner follows the
  // pointer (LrC's aspect-locked corner drag). `dx`/`dy` are the signed width/
  // height deltas (the LEFT/TOP edges move against the pointer), so nw/nh use
  // them; the CENTER must follow the pointer on BOTH axes (ncx = cx + dxPx/2),
  // or a left/top-edge drag moves the wrong edge ("ลากขอบซ้าย/บนแล้วข้างตรงข้าม
  // เลื่อน").
  const dx = mode.includes('e') ? dxPx : mode.includes('w') ? -dxPx : 0;
  const dy = mode.includes('s') ? dyPx : mode.includes('n') ? -dyPx : 0;
  let nw = cw + dx, nh = ch + dy;
  const a = lockedCropAspect(aspect, rotate90);
  if (mode === 'e' || mode === 'w' || mode === 'n' || mode === 's') {
    // Edge handles resize one axis only (free mode); locked aspect scales both.
    if (!a) {
      nw = cw + dx; nh = ch + dy;
    } else {
      nw = Math.max(cw + dx, (ch + dy) * a);
      nh = nw / a;
    }
  }
  const MIN = Math.round(W * 0.02);
  nw = Math.max(nw, MIN);
  nh = Math.max(nh, MIN);
  if (a) { if (nw / nh > a) nh = nw / a; else nw = nh * a; }
  // Keep the rect inside the source. The center follows the raw pointer delta
  // (dxPx/dyPx), NOT the signed edge delta (dx/dy) -- for 'w'/'n' those have
  // opposite signs, so the +dx/2 form pinned the wrong edge.
  const ncx = Math.min(Math.max(cx + dxPx / 2, nw / 2), W - nw / 2);
  const ncy = Math.min(Math.max(cy + dyPx / 2, nh / 2), H - nh / 2);
  return { x: ncx / W, y: ncy / H, w: nw / W, h: nh / H };
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
// centered in the source, tilted by the STRAIGHTEN angle only. The DOM crop
// overlay (#2 workbench) draws exactly this -- rect + dim outside -- so the
// view shows the FULL image with a live crop selection instead of baked
// letterbox bars.
export interface CropOverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number; // radians; ALWAYS 0 -- the selection frame is axis-aligned
}

export function cropOverlayRect(c: CropParams, W: number, H: number): CropOverlayRect {
  const g = cropGeometry(c, W, H);
  // The DOM selection frame is ALWAYS axis-aligned -- LrC's crop frame never
  // rotates. The straighten/90° rotation lives in the crop SHADER, which tilts
  // the IMAGE under the fixed frame, so the axis-aligned mask bbox is exactly
  // the region the rotated image fills and the frame hugs it. Drawing the
  // frame tilted instead (straighten-only) made the drawn handles sit far from
  // the axis-aligned hit-test at real-photo scale (3000px·sin10° ≈ 521px vs a
  // ~171px grab radius) -- the "Straighten แล้วเลื่อน ขนาด crop ไม่ได้" report.
  return { x: g.cx - g.halfW, y: g.cy - g.halfH, w: g.maskW, h: g.maskH, angle: 0 };
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
