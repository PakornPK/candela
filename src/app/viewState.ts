// View state for the Develop module's loupe: zoom level and pan position.
// Zoom > 1 means the canvas shows a cropped region of the image; zoom = 1
// means the full image fits the canvas (letterboxed). Pan is the normalized
// center of the view (0.5, 0.5 = image center).

export interface ViewState {
  zoom: number;      // 1.0 = fit, >1 = zoomed in
  panX: number;      // normalized 0..1, horizontal center of view
  panY: number;      // normalized 0..1, vertical center of view
}

// Default: fit the full image (zoom = 1, centered).
export function defaultViewState(): ViewState {
  return { zoom: 1, panX: 0.5, panY: 0.5 };
}

// Convert viewState to the cropFrac uniform blit.wgsl expects:
// [left, top, width, height] in normalized texture coordinates.
// zoom = 1 → [0, 0, 1, 1] (full image)
// zoom = 2, pan = (0.5, 0.5) → [0.25, 0.25, 0.5, 0.5] (center quarter)
export function viewStateToCropFrac(vs: ViewState): [number, number, number, number] {
  const w = 1 / vs.zoom;
  const h = 1 / vs.zoom;
  const x = vs.panX - w / 2;
  const y = vs.panY - h / 2;
  // Clamp so the view never shows outside the image (pan bounded by edges).
  const cx = Math.max(0, Math.min(1 - w, x));
  const cy = Math.max(0, Math.min(1 - h, y));
  return [cx, cy, w, h];
}

// Zoom toward a cursor position: the cursor stays fixed in the image as zoom
// changes. cursorNorm is the normalized position (0..1) within the image.
export function zoomToward(
  vs: ViewState,
  cursorNormX: number,
  cursorNormY: number,
  newZoom: number,
): ViewState {
  // Current view extents (normalized).
  const oldW = 1 / vs.zoom;
  const oldH = 1 / vs.zoom;
  const oldLeft = vs.panX - oldW / 2;
  const oldTop = vs.panY - oldH / 2;

  // Cursor position relative to the old view (0..1 within the view).
  const relX = (cursorNormX - oldLeft) / oldW;
  const relY = (cursorNormY - oldTop) / oldH;

  // New view extents.
  const newW = 1 / newZoom;
  const newH = 1 / newZoom;

  // New pan: cursor should stay at the same relative position in the new view.
  const newLeft = cursorNormX - relX * newW;
  const newTop = cursorNormY - relY * newH;
  const newPanX = newLeft + newW / 2;
  const newPanY = newTop + newH / 2;

  return { zoom: newZoom, panX: newPanX, panY: newPanY };
}

// Pan by a delta (normalized image coordinates). Bounded so the view never
// shows outside the image.
export function panBy(vs: ViewState, dx: number, dy: number): ViewState {
  const w = 1 / vs.zoom;
  const h = 1 / vs.zoom;
  const newPanX = Math.max(w / 2, Math.min(1 - w / 2, vs.panX + dx));
  const newPanY = Math.max(h / 2, Math.min(1 - h / 2, vs.panY + dy));
  return { zoom: vs.zoom, panX: newPanX, panY: newPanY };
}

// Check if the view is at the default (fit, centered).
export function isDefaultView(vs: ViewState): boolean {
  return vs.zoom === 1 && vs.panX === 0.5 && vs.panY === 0.5;
}
