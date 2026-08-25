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
      cell.dataset.fileId = String(file.id); // lets selection paint in place (subscribe) without a rebuild
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

  // Selection changed (grid click, arrow keys, module switch). A full
  // renderVisible() rebuild on every click was the strip "reloading" jank,
  // so when the selected cell is already fully on screen, paint the
  // highlight in place (toggle .selected keyed by dataset.fileId) -- no
  // scroll, no rebuild. Any other case (cell off-screen or not yet rendered)
  // scrolls it into view and rebuilds synchronously, THIS frame: waiting for
  // the scroll event's onChange is a frame or more later and reads as a
  // selection lag.
  const unsubscribe = subscribe(() => {
    const { selectedId } = getState();
    const files = getFiles();
    const index = files.findIndex((f) => f.id === selectedId);
    if (index < 0) { renderVisible(); return; }
    virtualizer._willUpdate();
    const item = virtualizer.getVirtualItems().find((v) => v.index === index);
    if (item) {
      const start = item.start, end = start + CELL_WIDTH;
      const viewStart = scrollEl.scrollLeft, viewEnd = viewStart + scrollEl.clientWidth;
      if (start >= viewStart && end <= viewEnd) {
        for (const cell of trackEl.querySelectorAll<HTMLElement>('.filmstrip-cell')) {
          cell.classList.toggle('selected', cell.dataset.fileId === String(selectedId));
        }
        return; // no scroll, no rebuild
      }
    }
    virtualizer.scrollToIndex(index, { align: 'center' });
    renderVisible(); // synchronous: outline paints the same frame as the click
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
