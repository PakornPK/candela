// Survey view (gap-analysis P1-5, LrC's N view) — geometry and interaction
// model only, pure and unit-tested; the parent renders tiles from it.
//
// LrC grows the grid to fill the view: 2 = 1 row x 2 cols, 3-4 = 2x2,
// 5-6 = 2 rows x 3 cols, 7-9 = 3x3, 10-12 = 3 rows x 4 cols, 13-16 = 4x4.
// The one rule that reproduces that table AND "best fills the box": score
// every grid that holds the count by the total photo area actually DISPLAYED
// (tiles minus the letterbox a 3:2 photo pays in a wrong-shaped tile) and
// take the winner, breaking ties toward more columns. Verified against the
// table: at 1600x900/gap 16 every count 2..16 picks the documented grid, and
// an extreme letterbox (e.g. 3000x200) sensibly collapses to fewer rows
// instead of stacking hairline slabs.

export interface TileLayout {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A survey tile below this size is useless for rapid culling: checking focus
// and nuking blinks — the whole job of N view — needs enough pixels to see
// the miss. 160px is half our 320px standard-preview tier, so below it the
// parent is UPSAMPLING — a quality cliff, not a nicety. surveyNeedsZoom
// reports the condition so the UI pages the set (fewer, bigger tiles)
// instead of rendering unreadable thumbs.
export const SURVEY_MIN_TILE = 160;

// Default gutter between survey tiles. surveyTileLayout takes gap as a
// parameter; this is the value surveyNeedsZoom measures the legibility floor
// with, kept in one place so the two cannot drift.
export const SURVEY_TILE_GAP = 16;

// The photo shape the letterbox is computed against: 3:2, native for the
// full-frame/APS-C RAWs this product targets.
const PHOTO_ASPECT = 3 / 2;

export function surveyTileLayout(count: number, boxW: number, boxH: number, gap: number): TileLayout {
  if (count <= 0 || boxW <= 0 || boxH <= 0) {
    return { cols: 0, rows: 0, tileW: 0, tileH: 0 };
  }
  let best: TileLayout | null = null;
  let bestArea = -1;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const tileW = (boxW - (cols - 1) * gap) / cols;
    const tileH = (boxH - (rows - 1) * gap) / rows;
    if (tileW <= 0 || tileH <= 0) continue; // gutters ate the box: unrenderable
    // Fraction of each tile the 3:2 photo actually fills after letterboxing.
    const ratio = tileW / tileH;
    const fill = ratio > PHOTO_ASPECT ? PHOTO_ASPECT / ratio : ratio / PHOTO_ASPECT;
    const area = count * tileW * tileH * fill;
    // '>=' with cols ascending: exact ties go to the WIDER grid — "prefer
    // more columns when the box is wide".
    if (area >= bestArea) {
      bestArea = area;
      best = { cols, rows, tileW, tileH };
    }
  }
  return best ?? { cols: 0, rows: 0, tileW: 0, tileH: 0 };
}

// Tile index -> rect inside the box, with the full tile group centered
// horizontally — the same "center the image in the available space" rule the
// print sheet uses. The signature carries no photo count, so centering is
// per the full cols-wide group: a short last row keeps its column slots
// instead of drifting, which is also how LrC's grid reads.
export function surveyTileRect(index: number, layout: TileLayout & { gap: number }, boxW: number): Rect {
  const { cols, tileW, tileH, gap } = layout;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const groupW = cols * tileW + (cols - 1) * gap;
  const x = (boxW - groupW) / 2 + col * (tileW + gap);
  const y = row * (tileH + gap);
  return { x, y, w: tileW, h: tileH };
}

// Remove a tile from the review set (the × on a Survey tile). LrC drops it
// from THIS survey pass WITHOUT touching its rating — the non-destructive
// reject that makes "clear the bad ones, then rate the keepers" safe: the
// photo keeps its stars, only the candidate page shrinks. The input array is
// never mutated; the rest reflow because the parent re-lays-out the result.
export function removeFromSurvey(ids: number[], removeId: number): number[] {
  return ids.filter((id) => id !== removeId);
}

// Arrow navigation. Wraps at both ends (LrC's Survey wraps), so holding →
// scans the whole set. An activeId outside the set (or null) starts at the
// first id going forward / the last going back.
export function nextSurveyActive(ids: number[], activeId: number | null, dir: 1 | -1): number | null {
  if (ids.length === 0) return null;
  const idx = activeId === null ? -1 : ids.indexOf(activeId);
  if (idx === -1) return dir === 1 ? ids[0] : ids[ids.length - 1];
  const next = (idx + dir + ids.length) % ids.length;
  return ids[next];
}

// True when tiling `count` photos in the box at the default gutter would drop
// a tile below SURVEY_MIN_TILE in either dimension — the parent pages the
// review set when this fires.
export function surveyNeedsZoom(count: number, boxW: number, boxH: number): boolean {
  const layout = surveyTileLayout(count, boxW, boxH, SURVEY_TILE_GAP);
  if (layout.cols === 0) return false; // nothing to render, nothing unreadable
  return layout.tileW < SURVEY_MIN_TILE || layout.tileH < SURVEY_MIN_TILE;
}
