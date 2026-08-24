import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import type { FileRecord } from '../catalog/types';
import { getState, subscribe } from './state';

const CELL_WIDTH = 96; // px, matches index.html's .filmstrip-cell

export interface FilmstripOptions {
  scrollEl: HTMLElement; // horizontal scroll container (#filmstrip)
  trackEl: HTMLElement; // absolutely-positioned cell container (#filmstrip-track)
  getFiles(): FileRecord[];
  getThumbnail(file: FileRecord): Promise<Blob | undefined>;
  onSelect(file: FileRecord): void;
}

export interface Filmstrip {
  setFiles(count: number): void;
  destroy(): void;
}

// Horizontal windowed strip -- same pattern as the virtualized grid in
// main.ts (one Virtualizer over "N items of a fixed size", absolutely
// positioned children), rotated to the horizontal axis. It shares the
// caller's thumbnail cache (getThumbnail) and decode path (onSelect), and
// follows the shared selection from state.ts: clicking a cell selects the
// file; any external selection change (grid click, arrow keys) scrolls the
// selected cell into view and re-renders the highlight.
export function createFilmstrip(opts: FilmstripOptions): Filmstrip {
  const { scrollEl, trackEl, getFiles, getThumbnail, onSelect } = opts;

  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => CELL_WIDTH,
    horizontal: true,
    overscan: 3,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => renderVisible(),
  });
  // Same headless-package pattern as the grid in main.ts: _didMount wires
  // the resize/scroll observers and returns cleanup; _willUpdate refreshes
  // measurements before reading sizes.
  const cleanup = virtualizer._didMount();
  virtualizer._willUpdate();

  function renderVisible(): void {
    virtualizer._willUpdate();
    trackEl.style.width = `${virtualizer.getTotalSize()}px`;
    trackEl.textContent = '';
    const files = getFiles();
    const selectedId = getState().selectedId;
    for (const item of virtualizer.getVirtualItems()) {
      const file = files[item.index];
      if (!file) continue;

      const cell = document.createElement('div');
      cell.className = 'filmstrip-cell' + (file.id === selectedId ? ' selected' : '');
      cell.style.left = `${item.start}px`;
      cell.title = file.name;
      cell.addEventListener('click', () => onSelect(file));
      trackEl.appendChild(cell);

      getThumbnail(file).then((blob) => {
        if (!blob) return; // extraction failed or not yet permitted -- placeholder stays
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        img.addEventListener('error', () => {
          URL.revokeObjectURL(img.src);
          img.remove();
        }, { once: true });
        cell.appendChild(img);
      });
    }
  }

  // Re-render on every state change: highlights the selected cell and
  // (when the selection changed) scrolls it into view. Re-rendering on
  // module switches too is harmless -- cells rebuild from the thumbnail
  // promise cache, no re-extraction.
  const unsubscribe = subscribe(() => {
    const { selectedId } = getState();
    const files = getFiles();
    const index = files.findIndex((f) => f.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    renderVisible();
  });

  return {
    setFiles(count: number): void {
      virtualizer.setOptions({ ...virtualizer.options, count });
      virtualizer.measure();
      renderVisible();
    },
    destroy(): void {
      unsubscribe();
      cleanup();
    },
  };
}
