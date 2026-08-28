import { describe, it, expect } from 'vitest';
import {
  ASPECT_RATIO,
  cropGeometry,
  cropOverlayRect,
  cropRect,
  cropRegion,
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
    // the landscape 300x200 texture -> mask 133.3x200, rect re-orients (PI/2).
    const r = cropOverlayRect(crop({ rotate90: 1 }), 300, 200);
    expect(r.w).toBeCloseTo(133.33, 2); expect(r.h).toBe(200);
    expect(r.x).toBeCloseTo(83.33, 2); expect(r.angle).toBeCloseTo(Math.PI / 2, 6);
    // Straighten tilts the overlay rect, same angle the shader applies.
    const s = cropOverlayRect(crop({ angle: 3 }), W, H);
    expect(s.angle).toBeCloseTo((3 * Math.PI) / 180, 6);
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
});
