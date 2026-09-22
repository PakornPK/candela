import { describe, expect, it } from 'vitest';
import { containBox, imagePointUnderCursor, loupeRectInImage, navigatorRectCss, panToNavigatorPoint } from './navigator';
import { defaultViewState } from './viewState';

describe('loupeRectInImage', () => {
  it('fit view covers the whole navigator image', () => {
    expect(loupeRectInImage(defaultViewState())).toEqual([0, 0, 1, 1]);
  });

  it('zoom 2 centered maps to the center quarter', () => {
    const [x, y, w, h] = loupeRectInImage({ zoom: 2, panX: 0.5, panY: 0.5 });
    expect(x).toBeCloseTo(0.25);
    expect(y).toBeCloseTo(0.25);
    expect(w).toBeCloseTo(0.5);
    expect(h).toBeCloseTo(0.5);
  });

  it('clamps pan so the rect stays inside the image', () => {
    const [x, , w] = loupeRectInImage({ zoom: 4, panX: 0, panY: 0 });
    expect(x).toBe(0);
    expect(w).toBeCloseTo(0.25);
  });
});

describe('containBox', () => {
  it('landscape image in a square box letterboxes top and bottom', () => {
    const b = containBox(1.5, 1);
    expect(b.x).toBe(0);
    expect(b.w).toBe(1);
    expect(b.h).toBeCloseTo(2 / 3);
    expect(b.y).toBeCloseTo((1 - 2 / 3) / 2);
  });

  it('portrait image in a square box pillarboxes left and right', () => {
    const b = containBox(2 / 3, 1);
    expect(b.y).toBe(0);
    expect(b.h).toBe(1);
    expect(b.w).toBeCloseTo(2 / 3);
    expect(b.x).toBeCloseTo((1 - 2 / 3) / 2);
  });

  it('matching ratios fill the box', () => {
    expect(containBox(1, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('navigatorRectCss', () => {
  it('fit view spans the whole image inside the letterbox', () => {
    const css = navigatorRectCss(defaultViewState(), 1.5, 1);
    expect(css.left).toBeCloseTo(0);
    expect(css.width).toBeCloseTo(1);
    expect(css.top).toBeCloseTo(1 / 6);
    expect(css.height).toBeCloseTo(2 / 3);
  });

  it('a never-invisible sliver: even an 8x zoom stays >= 6% of the box', () => {
    const css = navigatorRectCss({ zoom: 8, panX: 0.5, panY: 0.5 }, 1.5, 1);
    expect(css.width).toBeGreaterThanOrEqual(0.06);
    expect(css.height).toBeGreaterThanOrEqual(0.06);
  });

  it('zoomed rect sits inside the image area, not the letterband', () => {
    const css = navigatorRectCss({ zoom: 2, panX: 0.75, panY: 0.75 }, 1.5, 1);
    expect(css.left + css.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(css.top).toBeGreaterThanOrEqual(1 / 6 - 1e-9);
    expect(css.top + css.height).toBeLessThanOrEqual(1 / 6 + 2 / 3 + 1e-9);
  });
});

describe('panToNavigatorPoint', () => {
  it('center of the box pans to image center', () => {
    const vs = panToNavigatorPoint({ zoom: 2, panX: 0.1, panY: 0.1 }, 0.5, 0.5, 1, 1);
    expect(vs.panX).toBeCloseTo(0.5);
    expect(vs.panY).toBeCloseTo(0.5);
    expect(vs.zoom).toBe(2); // panning never changes zoom
  });

  it('a letterband click clamps to the nearest edge', () => {
    // image 1.5:1 in a square box: y below the bottom band edge maps to 1.
    const vs = panToNavigatorPoint({ zoom: 2, panX: 0.5, panY: 0.5 }, 0.5, 0.98, 1.5, 1);
    expect(vs.panY).toBe(1);
    expect(vs.panX).toBeCloseTo(0.5);
  });
});

describe('imagePointUnderCursor', () => {
  it('at fit, the cursor maps 1:1', () => {
    const [x, y] = imagePointUnderCursor(defaultViewState(), 0.3, 0.7);
    expect(x).toBeCloseTo(0.3);
    expect(y).toBeCloseTo(0.7);
  });

  it('zoomed, a cursor at the view center maps to the pan point', () => {
    const vs = { zoom: 2, panX: 0.6, panY: 0.4 };
    const [x, y] = imagePointUnderCursor(vs, 0.5, 0.5);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.4);
  });
});
