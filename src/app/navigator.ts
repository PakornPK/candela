import { viewStateToCropFrac, type ViewState } from './viewState';

// The loupe's visible rectangle INSIDE the navigator's image, which is the
// crop region itself (exportImage renders the crop, so the navigator bitmap
// is already crop-relative). zoom <= 1 -> the whole image; zoom > 1 -> the
// same viewStateToCropFrac the canvas blit uses. Returns [x, y, w, h]
// normalized 0..1 over the navigator bitmap.
export function loupeRectInImage(vs: ViewState): [number, number, number, number] {
  if (vs.zoom <= 1) return [0, 0, 1, 1];
  return viewStateToCropFrac(vs);
}

// object-fit: contain letterbox -- the rect an image of ratio imgRatio (w/h)
// occupies inside a box of ratio boxRatio. Same geometry the develop canvas
// uses (aspect-fitted inside its CSS box), so a normalized image point maps
// to the same pixel position in the navigator.
export function containBox(imgRatio: number, boxRatio: number): { x: number; y: number; w: number; h: number } {
  if (imgRatio >= boxRatio) {
    // Image wider than the box: full width, letterboxed vertically.
    const h = boxRatio / imgRatio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = imgRatio / boxRatio;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

// CSS layout for the view rectangle over the navigator box, in normalized
// units of the box (multiply by box px in main.ts). The rect is clamped to
// the image's contain-box so it never overlays the letterband, and never
// renders smaller than a visible sliver (min 6% of the box).
export function navigatorRectCss(
  vs: ViewState,
  imgRatio: number,
  boxRatio: number,
): { left: number; top: number; width: number; height: number } {
  const box = containBox(imgRatio, boxRatio);
  const [rx, ry, rw, rh] = loupeRectInImage(vs);
  const left = box.x + rx * box.w;
  const top = box.y + ry * box.h;
  const w = Math.max(0.06, rw * box.w);
  const h = Math.max(0.06, rh * box.h);
  return { left, top, width: w, height: h };
}

// A click/drag point on the navigator box (normalized to the box) becomes the
// new pan center for the loupe: the image-space point under the cursor (undo
// the contain letterbox), then viewStateToCropFrac clamps the view to the
// edges. A click on the letterband maps to the nearest image edge.
export function panToNavigatorPoint(vs: ViewState, boxX: number, boxY: number, imgRatio: number, boxRatio: number): ViewState {
  const box = containBox(imgRatio, boxRatio);
  const imgX = Math.min(1, Math.max(0, (boxX - box.x) / box.w));
  const imgY = Math.min(1, Math.max(0, (boxY - box.y) / box.h));
  return { zoom: vs.zoom, panX: imgX, panY: imgY };
}

// The image-space point (normalized to the CROP region view, the same space
// ViewState's pan lives in) under a cursor point (normalized 0..1 inside the
// loupe canvas). One owner for the mapping the wheel-zoom and dblclick
// handlers and the navigator's frame-drag all need.
export function imagePointUnderCursor(
  vs: ViewState,
  cursorX: number,
  cursorY: number,
): [number, number] {
  const [vx, vy, vw, vh] = viewStateToCropFrac(vs);
  return [vx + cursorX * vw, vy + cursorY * vh];
}
