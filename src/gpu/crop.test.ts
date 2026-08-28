import { describe, it, expect } from 'vitest';
import {
  ASPECT_RATIO,
  cropGeometry,
  cropHandleAt,
  cropOverlayRect,
  cropRect,
  cropRegion,
  dragCropRect,
  isFreeformCrop,
  isNeutralCrop,
  packCrop,
} from './crop';
import type { CropParams } from './crop';
import type { Op } from '../catalog/types';

// A 3:2 landscape raw (like a 6000x4000 APS-C / full-frame sensor).
const W = 6000;
const H = 4000;

const crop = (c: Partial<CropParams>): CropParams => ({ aspect: 'original', rotate90: 0, angle: 0, ...c });

describe('crop', () => {
  it('is neutral only at original / 0° / no rotation / no freeform', () => {
    expect(isNeutralCrop(crop({}))).toBe(true);
    expect(isNeutralCrop(crop({ aspect: '1:1' }))).toBe(false);
    expect(isNeutralCrop(crop({ rotate90: 1 }))).toBe(false);
    expect(isNeutralCrop(crop({ angle: 3 }))).toBe(false);
    // A freeform rect equal to the full image is still neutral.
    expect(isNeutralCrop(crop({ x: 0.5, y: 0.5, w: 1, h: 1 }))).toBe(true);
    // A moved or shrunk freeform rect crops.
    expect(isNeutralCrop(crop({ x: 0.4, y: 0.5, w: 0.8, h: 1 }))).toBe(false);
    expect(isNeutralCrop(crop({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }))).toBe(false);
    expect(isFreeformCrop(crop({}))).toBe(false);
    expect(isFreeformCrop(crop({ x: 0.5, y: 0.5, w: 1, h: 1 }))).toBe(true);
  });

  it('captures the largest centered rect of the preset aspect', () => {
    expect(cropRect(crop({}), W, H)).toEqual({ cx: 3000, cy: 2000, cw: W, ch: H });
    expect(cropRect(crop({ aspect: '3:2' }), W, H)).toEqual({ cx: 3000, cy: 2000, cw: 6000, ch: 4000 }); // same ratio = full frame
    expect(cropRect(crop({ aspect: '1:1' }), W, H)).toEqual({ cx: 3000, cy: 2000, cw: 4000, ch: 4000 });
    expect(cropRect(crop({ aspect: '16:9' }), W, H)).toEqual({ cx: 3000, cy: 2000, cw: 6000, ch: 3375 });
    expect(cropRect(crop({ aspect: '4:3' }), W, H).cw).toBeCloseTo(5333.333, 3);
    expect(cropRect(crop({ aspect: '2:3' }), W, H).cw).toBeCloseTo(2666.667, 3);
    // A 90° rotation swaps the preset's aspect: a 3:2 crop rotated 90°
    // captures a 2:3 source rect so it DISPLAYS 3:2.
    expect(cropRect(crop({ aspect: '3:2', rotate90: 1 }), W, H).cw).toBeCloseTo(2666.667, 3);
  });

  it('captures a freeform rect and clamps it inside the source', () => {
    // Normalized center + size -> pixels; off-center rect.
    expect(cropRect(crop({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }), W, H))
      .toEqual({ cx: 1500, cy: 2000, cw: 3000, ch: 2000 });
    // A drag pushing a corner out clamps the rect inside the source.
    const pushed = cropRect(crop({ x: 0.05, y: 0.5, w: 0.5, h: 0.5 }), W, H);
    expect(pushed.cx).toBeCloseTo(1500, 3); // cx >= cw/2 keeps left >= 0
    // Oversized rect is clamped to the full source.
    expect(cropRect(crop({ x: 0.5, y: 0.5, w: 2, h: 2 }), W, H))
      .toEqual({ cx: 3000, cy: 2000, cw: 6000, ch: 4000 });
  });

  it('zooms a rotation to fit the source, no clipped corners', () => {
    // Pure 90° of the full frame: the mask is the swapped dims, fit into the
    // texture (4000x6000 content centered in 6000x4000 -> zoom 1.5).
    const r90 = cropGeometry(crop({ rotate90: 1 }), W, H);
    expect(r90.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(r90.zoom).toBeCloseTo(1.5, 6);
    expect(r90.maskW).toBeCloseTo(2666.667, 3);
    expect(r90.maskH).toBe(4000);
    // A 3° straighten of the full frame: bbox grows, zoom = bh/H, maskH = H.
    const s3 = cropGeometry(crop({ angle: 3 }), W, H);
    expect(s3.zoom).toBeCloseTo(1.0771, 3);
    expect(s3.halfH).toBeCloseTo(2000, 3);
    expect(s3.halfW).toBeCloseTo(2878.53, 2);
    // Neutral geometry = the full mask at zoom 1 (identity pass).
    const identity = cropGeometry(crop({}), W, H);
    expect(identity.zoom).toBe(1);
    expect(identity.maskW).toBe(W);
    expect(identity.maskH).toBe(H);
  });

  it('packs 6 geometry floats (rect center) + 2 pad', () => {
    const packed = packCrop(crop({ aspect: '1:1' }), W, H);
    expect(packed.length).toBe(8);
    expect(packed[0]).toBe(0); // angle
    expect(packed[1]).toBe(1); // zoom
    expect(packed[4]).toBe(W / 2); // cx (rect center)
    expect(packed[5]).toBe(H / 2); // cy
    expect(packed[6]).toBe(0);
    // A freeform rect packs its own center.
    const free = packCrop(crop({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }), W, H);
    expect(free[4]).toBe(1500);
    expect(free[5]).toBe(2000);
  });

  it('cropOverlayRect is the centered mask the DOM overlay draws', () => {
    // 4:3 on a square source: mask 200x150, top at 25 (the crop is a pure
    // selection overlay now -- no baked bars).
    expect(cropOverlayRect(crop({ aspect: '4:3' }), 200, 200))
      .toEqual({ x: 0, y: 25, w: 200, h: 150, angle: 0 });
    // 16:9 on 200x200: full-width 200x112.5, vertical letterbox split 43.75.
    const o = cropOverlayRect(crop({ aspect: '16:9' }), 200, 200);
    expect(o.x).toBe(0); expect(o.w).toBe(200);
    expect(o.y).toBeCloseTo(43.75, 6); expect(o.h).toBeCloseTo(112.5, 6);
    // 90° turn of the full frame: vertical 200x300 content is zoomed 1.5 into
    // the landscape 300x200 texture -> mask 133.3x200 (portrait). The DOM
    // selection stays AXIS-ALIGNED (angle = straighten only = 0) so it hugs
    // the portrait image -- the total angle belongs to the shader + export.
    const r = cropOverlayRect(crop({ rotate90: 1 }), 300, 200);
    expect(r.w).toBeCloseTo(133.33, 2); expect(r.h).toBe(200);
    expect(r.x).toBeCloseTo(83.33, 2); expect(r.angle).toBe(0);
    // The frame is ALWAYS axis-aligned (LrC-correct): the 90° turn + straighten
    // rotate the IMAGE in the shader, never the frame. This is what keeps the
    // drawn handles on the axis-aligned hit-test -- a tilted frame put them
    // ~521px off at real-photo scale (the "Straighten แล้วเลื่อน ขนาด crop
    // ไม่ได้" report) and carried the 90° turn ("straighten mark หมุนตาม").
    const rt = cropOverlayRect(crop({ rotate90: 1, angle: 3 }), 300, 200);
    expect(rt.angle).toBe(0);
    expect(rt.w).toBeCloseTo(138.96, 2); // 90°+3° rotated mask bbox (straighten grows it)
    const s = cropOverlayRect(crop({ angle: 3 }), W, H);
    expect(s.angle).toBe(0);
    expect(s.x).toBeCloseTo((W - s.w) / 2, 6);
  });

  it('reports the crop mask as a normalized rect', () => {
    const ops: Op[] = [{ kind: 'crop', aspect: '1:1', rotate90: 0, angle: 0 }];
    expect(cropRegion([], W, H)).toEqual([0, 0, 1, 1]);
    expect(cropRegion(ops, W, H)).toEqual([1 / 6, 0, 2 / 3, 1]); // centered 1:1 rect
    // A freeform rect reports its own region -- the blit/export samples it.
    const free: Op[] = [{ kind: 'crop', aspect: 'original', rotate90: 0, angle: 0, x: 0.25, y: 0.5, w: 0.5, h: 0.5 }];
    expect(cropRegion(free, W, H)).toEqual([0, 0.25, 0.5, 0.5]);
    // Unloaded size guard (vignette/frame packParams call this in tests).
    expect(cropRegion(ops, 0, 0)).toEqual([0, 0, 1, 1]);
  });

  it('knows every preset aspect ratio', () => {
    expect(ASPECT_RATIO['3:2']).toBe(1.5);
    expect(ASPECT_RATIO['1:1']).toBe(1);
    expect(ASPECT_RATIO['16:9']).toBeCloseTo(1.778, 3);
  });

  it('hit-tests the crop overlay handles', () => {
    const r = { x: 100, y: 100, w: 800, h: 600 };
    // hs = the handle radius in buffer px (the caller derives it from the
    // display scale). 13 = the old W=1200 value for parity.
    expect(cropHandleAt(r, 140, 140, 13)).toBe('move');       // interior
    expect(cropHandleAt(r, 112, 112, 13)).toBe('nw');         // top-left corner
    expect(cropHandleAt(r, 888, 112, 13)).toBe('ne');         // top-right
    expect(cropHandleAt(r, 900, 700, 13)).toBe('se');         // bottom-right
    expect(cropHandleAt(r, 900, 300, 13)).toBe('e');          // right edge
    expect(cropHandleAt(r, 500, 700, 13)).toBe('s');          // bottom edge
    expect(cropHandleAt(r, 500, 112, 13)).toBe('n');          // top edge
    expect(cropHandleAt(r, 87, 400, 13)).toBe('w');           // left edge
    expect(cropHandleAt(r, 50, 400, 13)).toBe(null);          // outside
    expect(cropHandleAt(r, 500, 800, 13)).toBe(null);         // outside below
    // Real-photo scale: a 6000px buffer shown ~0.067x gives hs ~180 buffer px.
    // The grab zone grows with the display scale, so the handles stay a fixed
    // CSS size even when the buffer is huge (the "ย่อขยายไม่ได้" report).
    expect(cropHandleAt(r, 0, 0, 180)).toBe('nw');            // far corner within the scaled radius
    expect(cropHandleAt(r, 500, 400, 180)).toBe('move');      // interior still moves
    expect(cropHandleAt(r, 500, 800, 180)).toBe('s');         // bottom edge
  });

  it('move drags the rect and clamps it inside the source', () => {
    // Half-size rect at the source center on a 6000x4000 workbench.
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }; // 3000x2000, centered
    const right = dragCropRect('move', orig, 400, 0, W, H, 'original', 0);
    expect(right.x).toBeCloseTo(0.5667, 3); // (1500+400)/6000
    expect(right.y).toBe(0.5);
    expect(right.w).toBe(0.5);
    // Dragging far right clamps so the right edge stays inside (cx = W - cw/2).
    const clamped = dragCropRect('move', orig, 50000, 0, W, H, 'original', 0);
    expect(clamped.x).toBeCloseTo(0.75, 6); // (6000 - 1500)/6000
  });

  it('aspect-locked corner resize keeps the opposite corner fixed', () => {
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }; // 3000x2000 on 6000x4000
    // 3:2 preset -> a=1.5; pulling the SE corner +600,+400 scales to 3600x2400.
    const se = dragCropRect('se', orig, 600, 400, W, H, '3:2', 0);
    expect(se.w * W).toBeCloseTo(3600, 3);
    expect(se.h * H).toBeCloseTo(2400, 3);
    expect((se.w * W) / (se.h * H)).toBeCloseTo(1.5, 6);
    // NW corner (cx - cw/2) is unchanged -> the opposite corner stayed fixed.
    const nwBefore = 0.5 * W - 0.5 * (0.5 * W);
    const nwAfter = se.x * W - se.w * W / 2;
    expect(nwAfter).toBeCloseTo(nwBefore, 3);
  });

  it('90° rotation flips the locked aspect', () => {
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    // 3:2 rotated 90° -> locked 2:3: a +1000,+1500 pull gives a 3000x4500 rect.
    const se = dragCropRect('se', orig, 1000, 1500, W, H, '3:2', 1);
    expect((se.w * W) / (se.h * H)).toBeCloseTo(2 / 3, 6);
  });

  it('free resize (original aspect) follows the pointer axis and never collapses', () => {
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    // 'original' aspect = no lock: an edge pull moves one axis only.
    const e = dragCropRect('e', orig, 600, 0, W, H, 'original', 0);
    expect(e.w * W).toBeCloseTo(3600, 3);
    expect(e.h * H).toBe(2000);
    // Shrinking below the 2% minimum width clamps to it.
    const s = dragCropRect('s', orig, 0, -100000, W, H, 'original', 0);
    expect(s.h * H).toBeCloseTo(Math.round(W * 0.02), 6);
  });

  it('w/n edge handles follow the pointer (opposite edge fixed)', () => {
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }; // 3000x2000 centered on 6000x4000
    // 'w' (left edge) dragged RIGHT +600: width shrinks, RIGHT edge stays put.
    const w = dragCropRect('w', orig, 600, 0, W, H, 'original', 0);
    expect(w.w * W).toBeCloseTo(2400, 3); // 3000 - 600
    expect(w.x * W + (w.w * W) / 2).toBeCloseTo(4500, 3); // right edge fixed (3000+1500)
    expect(w.x * W - (w.w * W) / 2).toBeCloseTo(2100, 3); // left edge followed the pointer
    // 'n' (top edge) dragged DOWN +400: height shrinks, BOTTOM edge stays put.
    const n = dragCropRect('n', orig, 0, 400, W, H, 'original', 0);
    expect(n.h * H).toBeCloseTo(1600, 3); // 2000 - 400
    expect(n.y * H + (n.h * H) / 2).toBeCloseTo(3000, 3); // bottom fixed (2000+1000)
    expect(n.y * H - (n.h * H) / 2).toBeCloseTo(1400, 3); // top followed the pointer
  });

  it('nw corner drag keeps the opposite (se) corner fixed', () => {
    const orig = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    // Grab NW, drag OUT (up-left: -400,-300): width+height grow, SE stays.
    const nw = dragCropRect('nw', orig, -400, -300, W, H, 'original', 0);
    expect(nw.w * W).toBeCloseTo(3400, 3); // 3000 + 400
    expect(nw.h * H).toBeCloseTo(2300, 3); // 2000 + 300
    expect(nw.x * W + (nw.w * W) / 2).toBeCloseTo(4500, 3); // SE x fixed
    expect(nw.y * H + (nw.h * H) / 2).toBeCloseTo(3000, 3); // SE y fixed
  });
});
