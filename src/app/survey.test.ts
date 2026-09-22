import { describe, it, expect } from 'vitest';
import {
  surveyTileLayout,
  surveyTileRect,
  removeFromSurvey,
  nextSurveyActive,
  surveyNeedsZoom,
  SURVEY_MIN_TILE,
  SURVEY_TILE_GAP,
  type TileLayout,
} from './survey';

const BOX_W = 1600;
const BOX_H = 900;
const GAP = SURVEY_TILE_GAP;

describe('surveyTileLayout — the documented 2..16 grid table', () => {
  // LrC's Survey: 2 = 1x2, 3-4 = 2x2, 5-6 = 2x3, 7-9 = 3x3, 10-12 = 3x4,
  // 13-16 = 4x4 (rows x cols) on a normal wide view.
  const table: Array<[number, number, number]> = [
    [2, 2, 1], // cols, rows — count 2
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [8, 3, 3],
    [9, 3, 3],
    [10, 4, 3],
    [11, 4, 3],
    [12, 4, 3],
    [13, 4, 4],
    [14, 4, 4],
    [15, 4, 4],
    [16, 4, 4],
  ];

  it.each(table)('count %i -> %i cols x %i rows', (count, cols, rows) => {
    const l = surveyTileLayout(count, BOX_W, BOX_H, GAP);
    expect([l.cols, l.rows]).toEqual([cols, rows]);
    expect(l.cols * l.rows).toBeGreaterThanOrEqual(count); // the grid holds them all
  });

  it('count 1 is a single tile filling the box', () => {
    const l = surveyTileLayout(1, BOX_W, BOX_H, GAP);
    expect([l.cols, l.rows]).toEqual([1, 1]);
    expect(l.tileW).toBeCloseTo(BOX_W);
    expect(l.tileH).toBeCloseTo(BOX_H);
  });

  it('degenerate inputs produce an empty layout, never NaN tiles', () => {
    expect(surveyTileLayout(0, BOX_W, BOX_H, GAP)).toEqual({ cols: 0, rows: 0, tileW: 0, tileH: 0 });
    expect(surveyTileLayout(-3, BOX_W, BOX_H, GAP).cols).toBe(0);
    expect(surveyTileLayout(4, 0, BOX_H, GAP).cols).toBe(0);
    expect(surveyTileLayout(4, BOX_W, -10, GAP).cols).toBe(0);
  });

  it('every tile fits the box for counts 1..40 (cols*tileW + gaps <= boxW)', () => {
    for (let count = 1; count <= 40; count++) {
      const l = surveyTileLayout(count, BOX_W, BOX_H, GAP);
      const usedW = l.cols * l.tileW + (l.cols - 1) * GAP;
      const usedH = l.rows * l.tileH + (l.rows - 1) * GAP;
      expect(usedW).toBeLessThanOrEqual(BOX_W + 1e-9);
      expect(usedH).toBeLessThanOrEqual(BOX_H + 1e-9);
      expect(l.tileW).toBeGreaterThan(0);
      expect(l.tileH).toBeGreaterThan(0);
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(count);
    }
  });

  it('prefers more columns when the box is very wide (LrC fills the view)', () => {
    // A 3000x200 letterbox: 4 photos in 2x2 would be 70px-tall slabs; the
    // fill-the-box rule must pick the wide 4x1 strip instead.
    const l = surveyTileLayout(4, 3000, 200, GAP);
    expect([l.cols, l.rows]).toEqual([4, 1]);
  });

  it('tiles never spill past the box vertically even for large counts', () => {
    const l = surveyTileLayout(36, BOX_W, BOX_H, GAP);
    expect(l.rows * (l.tileH + GAP) - GAP).toBeLessThanOrEqual(BOX_H + 1e-9);
  });
});

describe('surveyTileRect', () => {
  const layout: TileLayout & { gap: number } = { ...surveyTileLayout(4, BOX_W, BOX_H, GAP), gap: GAP };

  it('maps index to (row, col) positions with the gutter between tiles', () => {
    const r0 = surveyTileRect(0, layout, BOX_W);
    const r1 = surveyTileRect(1, layout, BOX_W);
    const r2 = surveyTileRect(2, layout, BOX_W); // first tile of row 2
    expect(r1.x).toBeCloseTo(r0.x + layout.tileW + GAP);
    expect(r1.y).toBeCloseTo(r0.y);
    expect(r2.x).toBeCloseTo(r0.x);
    expect(r2.y).toBeCloseTo(r0.y + layout.tileH + GAP);
    for (const r of [r0, r1, r2]) {
      expect(r.w).toBeCloseTo(layout.tileW);
      expect(r.h).toBeCloseTo(layout.tileH);
    }
  });

  it('centers the tile group horizontally in the box', () => {
    // Hand-built narrow tiles inside a wide box: the group must sit centered.
    const l = { cols: 2, rows: 1, tileW: 100, tileH: 100, gap: 10 };
    const boxW = 500;
    const a = surveyTileRect(0, l, boxW);
    const b = surveyTileRect(1, l, boxW);
    // group = 2*100 + 10 = 210 -> left margin = (500-210)/2 = 145
    expect(a.x).toBeCloseTo(145);
    expect(b.x).toBeCloseTo(145 + 110);
    expect(a.y).toBeCloseTo(0);
  });

  it('a full-width layout fills the box edge to edge (centering is a no-op)', () => {
    const r = surveyTileRect(0, layout, BOX_W);
    expect(r.x).toBeCloseTo(0);
    const last = surveyTileRect(layout.cols - 1, layout, BOX_W);
    expect(last.x + last.w).toBeCloseTo(BOX_W);
  });
});

describe('removeFromSurvey — the non-destructive x', () => {
  it('drops only the removed id and keeps order', () => {
    expect(removeFromSurvey([7, 3, 9, 4], 9)).toEqual([7, 3, 4]);
  });

  it('never mutates the input array', () => {
    const ids = [1, 2, 3];
    const out = removeFromSurvey(ids, 2);
    expect(ids).toEqual([1, 2, 3]);
    expect(out).not.toBe(ids);
  });

  it('removing an id not in the set returns an equal copy (idempotent ×)', () => {
    const ids = [1, 2];
    const out = removeFromSurvey(ids, 99);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(ids);
  });

  it('removing the last tile leaves an empty set (parent exits Survey)', () => {
    expect(removeFromSurvey([5], 5)).toEqual([]);
  });
});

describe('nextSurveyActive — wrapped arrow navigation', () => {
  const ids = [10, 20, 30];

  it('steps forward and wraps past the end', () => {
    expect(nextSurveyActive(ids, 10, 1)).toBe(20);
    expect(nextSurveyActive(ids, 30, 1)).toBe(10); // wrap
  });

  it('steps backward and wraps before the start', () => {
    expect(nextSurveyActive(ids, 20, -1)).toBe(10);
    expect(nextSurveyActive(ids, 10, -1)).toBe(30); // wrap
  });

  it('null starts at the first going forward / last going back', () => {
    expect(nextSurveyActive(ids, null, 1)).toBe(10);
    expect(nextSurveyActive(ids, null, -1)).toBe(30);
  });

  it('an active id outside the set (removed via x) re-enters at the ends', () => {
    expect(nextSurveyActive([20, 30], 10, 1)).toBe(20);
    expect(nextSurveyActive([20, 30], 10, -1)).toBe(30);
  });

  it('single tile loops to itself; empty set has no next', () => {
    expect(nextSurveyActive([7], 7, 1)).toBe(7);
    expect(nextSurveyActive([7], 7, -1)).toBe(7);
    expect(nextSurveyActive([], null, 1)).toBeNull();
    expect(nextSurveyActive([], 3, -1)).toBeNull();
  });
});

describe('surveyNeedsZoom — legibility floor', () => {
  it('large box, few tiles: no zoom needed', () => {
    expect(surveyNeedsZoom(4, BOX_W, BOX_H)).toBe(false);
    expect(surveyNeedsZoom(1, BOX_W, BOX_H)).toBe(false);
  });

  it('many tiles in a small box crosses the 160px floor', () => {
    // 16 tiles in 600x400: ~138px wide tiles -> unreadable.
    expect(surveyNeedsZoom(16, 600, 400)).toBe(true);
  });

  it('matches the layout function at the boundary', () => {
    // Whatever the layout decides, the flag equals min(tile) < floor.
    for (const count of [1, 6, 9, 12, 16, 25]) {
      const l = surveyTileLayout(count, 800, 600, GAP);
      const expectZoom = Math.min(l.tileW, l.tileH) < SURVEY_MIN_TILE;
      expect(surveyNeedsZoom(count, 800, 600)).toBe(expectZoom);
    }
  });

  it('count 0 is not "needs zoom" (nothing to render)', () => {
    expect(surveyNeedsZoom(0, 100, 100)).toBe(false);
  });
});
