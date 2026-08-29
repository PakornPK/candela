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
    // The FRAME is the largest chosen-aspect rect inside the rotated rect (the
    // LrC selection), distinct from the rotated-bbox mask it fits inside.
    expect(s3.frameHalfW).toBeCloseTo(2585.72, 2);
    expect(s3.frameHalfH).toBeCloseTo(1723.82, 2);
    expect(s3.frameHalfW / s3.frameHalfH).toBeCloseTo(1.5, 4);
    // Neutral geometry = the full mask at zoom 1 (identity pass).
    const identity = cropGeometry(crop({}), W, H);
    expect(identity.zoom).toBe(1);
    expect(identity.maskW).toBe(W);
    expect(identity.maskH).toBe(H);
    expect(identity.frameHalfW).toBe(W / 2);
    expect(identity.frameHalfH).toBe(H / 2);
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
    expect(r.w).toBeCloseTo(133.33, 2); expect(r.h).toBeCloseTo(200, 6);
    expect(r.x).toBeCloseTo(83.33, 2); expect(r.angle).toBe(0);
    // The frame is ALWAYS axis-aligned (LrC-correct): the 90° turn + straighten
    // rotate the IMAGE in the shader, never the frame. This is what keeps the
    // drawn handles on the axis-aligned hit-test -- a tilted frame put them
    // ~521px off at real-photo scale (the "Straighten แล้วเลื่อน ขนาด crop
    // ไม่ได้" report) and carried the 90° turn ("straighten mark หมุนตาม").
    // The frame is also ASPECT-PRESERVING: the 90°-turned 3:2 DISPLAYS 3:2, so
    // the straighten shrinks it inside the rotated rect rather than widening it
    // to the rotated bbox (119.8 vs the old 139.0 bbox width).
    const rt = cropOverlayRect(crop({ rotate90: 1, angle: 3 }), 300, 200);
    expect(rt.angle).toBe(0);
    expect(rt.w).toBeCloseTo(119.77, 2);
    expect(rt.h).toBeCloseTo(179.66, 2);
    const s = cropOverlayRect(crop({ angle: 3 }), W, H);
    expect(s.angle).toBe(0);
    expect(s.x).toBeCloseTo((W - s.w) / 2, 6);
  });

  it('keeps the chosen aspect under straighten (LrC frame fits inside the rotated image)', () => {
    // The mask bbox of a straighten is NOT the chosen aspect (a 15° straighten
    // of a 3:2 crop renders ~1.26:1) -- LrC shrinks the frame so it keeps the
    // chosen aspect inside the rotated image and trims/dims the corners beyond
    // it. This was the "ปรับสัดส่วนแล้วไม่ปรับตาม" report.
    const s3 = cropOverlayRect(crop({ angle: 3 }), W, H);
    expect(s3.w / s3.h).toBeCloseTo(1.5, 4); // 3:2 (the source is 3:2)
    const s15 = cropOverlayRect(crop({ angle: 15 }), W, H);
    expect(s15.w / s15.h).toBeCloseTo(1.5, 4);
    expect(s15.w).toBeCloseTo(3272.01, 2); // smaller than the source (corners trimmed)
    const sq = cropOverlayRect(crop({ aspect: '1:1', angle: 15 }), W, H);
    expect(sq.w / sq.h).toBeCloseTo(1, 4);
    // The frame fits the rotated FULL image (LrC loupe), not the pre-straighten
    // 4000x4000 crop rect -- so it shrinks with the image's height (2000/1.225
    // half) rather than locking at the crop's own 2000.
    expect(sq.w).toBeCloseTo(2411.83, 2);
    const wide = cropOverlayRect(crop({ aspect: '16:9', angle: 15 }), W, H);
    expect(wide.w / wide.h).toBeCloseTo(16 / 9, 4);
    // A 90°-turned 3:2 crop still DISPLAYS 3:2 (aspect restored, not the 2:3
    // source rect it captures).
    const r90 = cropOverlayRect(crop({ aspect: '3:2', rotate90: 1, angle: 5 }), W, H);
    expect(r90.w / r90.h).toBeCloseTo(1.5, 3);
    // At angle 0 the frame IS the crop rect (no shrink).
    const flat = cropOverlayRect(crop({ aspect: '1:1' }), W, H);
    expect(flat.w).toBe(4000);
    expect(flat.h).toBe(4000);
  });

  it('straighten shows the FULL image under the LrC frame (loupe), not the rotated crop', () => {
    // A 3:2 preset on a 4:3 source (bayer.dng is 64x48), 15° straighten. The
    // workbench mask = the rotated IMAGE's bbox (the WHOLE scene tilts; the
    // shader letterboxes the empty corners) -- the old mask was the rotated
    // CROP rect's bbox (72.86x57.78 -> 60.53x48), which hid the source's top/
    // bottom rows behind the crop ("ยังไม่เหมือนนะ ใช้ไม่ได้ของแบบ LRC").
    const g = cropGeometry(crop({ aspect: '3:2', angle: 15 }), 64, 48);
    expect(g.maskW).toBeCloseTo(56.63, 1); // full 64x48 image rotated -> 74.24x62.93 bbox / zoom 1.311
    expect(g.maskH).toBeCloseTo(48, 2);    // height binds
    // The LrC frame = the largest 3:2 inside the rotated FULL image (fits the
    // 48-tall image, corners on its edges) -- the old frame fit the rotated
    // 64x42.67 crop rect and was ~3% smaller. The export follows this frame.
    const o = cropOverlayRect(crop({ aspect: '3:2', angle: 15 }), 64, 48);
    expect(o.w / o.h).toBeCloseTo(1.5, 4);
    expect(o.w).toBeCloseTo(40.56, 2);
    expect(o.h).toBeCloseTo(27.04, 2);
    const [, , rw, rh] = cropRegion([{ kind: 'crop', aspect: '3:2', rotate90: 0, angle: 15 }], 64, 48);
    expect((rw * 64) / (rh * 48)).toBeCloseTo(1.5, 4);
    expect(rw * 64).toBeCloseTo(40.56, 2); // Done canvas = the LrC frame (was 39.26)
    expect(rh * 48).toBeCloseTo(27.04, 2); // (was 26.18)
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

  it('exports the aspect-preserving frame region under straighten', () => {
    const ops: Op[] = [{ kind: 'crop', aspect: '3:2', rotate90: 0, angle: 15 }];
    const [, , rw, rh] = cropRegion(ops, W, H);
    // cropRegion is normalized to the SOURCE, so the Done canvas aspect (the
    // chosen 3:2, not the normalized 1.0 square) is (rw·W)/(rh·H).
    expect((rw * W) / (rh * H)).toBeCloseTo(1.5, 4); // the Done canvas keeps the chosen aspect
    // At angle 0 it equals the preset rect (a 3:2 crop = full 6000x4000 here).
    const flat: Op[] = [{ kind: 'crop', aspect: '3:2', rotate90: 0, angle: 0 }];
    expect(cropRegion(flat, W, H)).toEqual([0, 0, 1, 1]);
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
