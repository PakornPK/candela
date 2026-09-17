import { describe, it, expect } from 'vitest';
import { defaultViewState, viewStateToCropFrac, zoomToward, panBy, isDefaultView, type ViewState } from './viewState';

describe('viewState', () => {
  describe('defaultViewState', () => {
    it('returns fit (zoom=1, centered)', () => {
      const vs = defaultViewState();
      expect(vs.zoom).toBe(1);
      expect(vs.panX).toBe(0.5);
      expect(vs.panY).toBe(0.5);
    });
  });

  describe('viewStateToCropFrac', () => {
    it('zoom=1 returns full image [0,0,1,1]', () => {
      const vs = defaultViewState();
      const [x, y, w, h] = viewStateToCropFrac(vs);
      expect(x).toBe(0);
      expect(y).toBe(0);
      expect(w).toBe(1);
      expect(h).toBe(1);
    });

    it('zoom=2 centered returns center quarter', () => {
      const vs: ViewState = { zoom: 2, panX: 0.5, panY: 0.5 };
      const [x, y, w, h] = viewStateToCropFrac(vs);
      expect(w).toBeCloseTo(0.5, 5);
      expect(h).toBeCloseTo(0.5, 5);
      expect(x).toBeCloseTo(0.25, 5);
      expect(y).toBeCloseTo(0.25, 5);
    });

    it('pan bounded by image edges (never shows outside)', () => {
      // Pan to top-left corner at zoom=4 (view is 0.25x0.25).
      const vs: ViewState = { zoom: 4, panX: 0, panY: 0 };
      const [x, y, w, h] = viewStateToCropFrac(vs);
      expect(w).toBeCloseTo(0.25, 5);
      expect(h).toBeCloseTo(0.25, 5);
      // Clamped: x=0, y=0 (can't go negative).
      expect(x).toBe(0);
      expect(y).toBe(0);
    });

    it('pan bounded by bottom-right edge', () => {
      const vs: ViewState = { zoom: 4, panX: 1, panY: 1 };
      const [x, y, w, h] = viewStateToCropFrac(vs);
      expect(w).toBeCloseTo(0.25, 5);
      expect(h).toBeCloseTo(0.25, 5);
      // Clamped: x=0.75, y=0.75 (can't go past 1-w).
      expect(x).toBeCloseTo(0.75, 5);
      expect(y).toBeCloseTo(0.75, 5);
    });
  });

  describe('zoomToward', () => {
    it('zoom toward center keeps center fixed', () => {
      const vs = defaultViewState();
      const result = zoomToward(vs, 0.5, 0.5, 2);
      expect(result.zoom).toBe(2);
      // Center should stay at 0.5, 0.5.
      expect(result.panX).toBeCloseTo(0.5, 5);
      expect(result.panY).toBeCloseTo(0.5, 5);
    });

    it('zoom toward top-left keeps cursor fixed', () => {
      const vs = defaultViewState();
      // Zoom toward (0.25, 0.25) at zoom=2.
      const result = zoomToward(vs, 0.25, 0.25, 2);
      expect(result.zoom).toBe(2);
      // The view should be centered such that (0.25, 0.25) is at the same
      // relative position as before (center of the view).
      const [vx, vy, vw, vh] = viewStateToCropFrac(result);
      expect(vw).toBeCloseTo(0.5, 5);
      expect(vh).toBeCloseTo(0.5, 5);
      // Cursor (0.25, 0.25) should be within the view.
      expect(0.25).toBeGreaterThanOrEqual(vx);
      expect(0.25).toBeLessThanOrEqual(vx + vw);
      expect(0.25).toBeGreaterThanOrEqual(vy);
      expect(0.25).toBeLessThanOrEqual(vy + vh);
    });
  });

  describe('panBy', () => {
    it('pan by positive dx moves right', () => {
      const vs: ViewState = { zoom: 2, panX: 0.5, panY: 0.5 };
      const result = panBy(vs, 0.1, 0);
      expect(result.panX).toBeCloseTo(0.6, 5);
      expect(result.panY).toBeCloseTo(0.5, 5);
    });

    it('pan bounded by image edges', () => {
      const vs: ViewState = { zoom: 4, panX: 0.5, panY: 0.5 };
      // Pan far right — should clamp so view doesn't go past edge.
      const result = panBy(vs, 10, 0);
      const [vx, , vw] = viewStateToCropFrac(result);
      // Right edge of view should be <= 1.
      expect(vx + vw).toBeLessThanOrEqual(1.0001);
    });
  });

  describe('isDefaultView', () => {
    it('returns true for default state', () => {
      expect(isDefaultView(defaultViewState())).toBe(true);
    });

    it('returns false when zoomed', () => {
      expect(isDefaultView({ zoom: 2, panX: 0.5, panY: 0.5 })).toBe(false);
    });

    it('returns false when panned', () => {
      expect(isDefaultView({ zoom: 1, panX: 0.6, panY: 0.5 })).toBe(false);
    });
  });
});
