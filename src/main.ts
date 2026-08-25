import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError } from './raw/decode';
import { WB_NEUTRAL_KELVIN } from './gpu/uniforms';
import { openCatalogDb } from './catalog/db';
import { listFolders, listFiles } from './catalog/query';
import { importFolder } from './catalog/import';
import { ensureReadPermission } from './catalog/permissions';
import { loadEditState, saveEditState } from './catalog/editsStore';
import { commitEdit, undo, redo, currentOps } from './catalog/editHistory';
import { opsToAdjustState } from './catalog/adjust';
import { getOrExtractThumbnail } from './catalog/thumbnails';
import { isExposureOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord, type FolderRecord } from './catalog/types';
import { getState, selectFile, subscribe, type ModuleId } from './app/state';
import { registerModule, switchModule } from './app/modules';
import { createFilmstrip } from './app/filmstrip';
import { keyToAction } from './app/shortcuts';

const COLUMNS_PER_ROW = 6; // fixed for this pass -- see plan header
const CELL_SIZE = 160; // px, matches index.html's .catalog-cell
const HEADING_HEIGHT = 24; // px, matches index.html's .catalog-heading

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const libraryScroll = document.querySelector<HTMLDivElement>('#library-scroll')!;
const libraryGrid = document.querySelector<HTMLDivElement>('#library-grid')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLDivElement>('#error')!;
const errorMessageEl = document.querySelector<HTMLParagraphElement>('#error-message')!;
const errorDetailEl = document.querySelector<HTMLPreElement>('#error-detail')!;
const folderListEl = document.querySelector<HTMLDivElement>('#folder-list')!;
const metadataEl = document.querySelector<HTMLDivElement>('#metadata-panel')!;
const historyListEl = document.querySelector<HTMLDivElement>('#history-list')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const redoButton = document.querySelector<HTMLButtonElement>('#redo-btn')!;
const filmstripScroll = document.querySelector<HTMLElement>('#filmstrip')!;
const filmstripTrack = document.querySelector<HTMLDivElement>('#filmstrip-track')!;

function showError(message: string, detail?: string): void {
  errorMessageEl.textContent = message;
  errorDetailEl.textContent = detail ?? '';
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.hidden = true;
  errorMessageEl.textContent = '';
  errorDetailEl.textContent = '';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Colors the slider track from its neutral point toward the thumb,
// matching Lightroom's fill-from-zero style instead of the browser
// default fill-from-left-edge.
function updateSliderFill(slider: HTMLInputElement, neutral = 0): void {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const neutralPct = ((neutral - min) / (max - min)) * 100;
  const valuePct = ((Number(slider.value) - min) / (max - min)) * 100;
  slider.style.setProperty('--from', `${Math.min(neutralPct, valuePct)}%`);
  slider.style.setProperty('--to', `${Math.max(neutralPct, valuePct)}%`);
}

function updateReadout(output: HTMLOutputElement, value: number, decimals: number): void {
  output.textContent = (value >= 0 ? '+' : '') + value.toFixed(decimals);
}

function currentOpsFromSliders(): Op[] {
  return [
    { kind: 'exposure', ev: Number(exposureSlider.value) },
    { kind: 'whiteBalance', kelvin: Number(wbSlider.value) },
  ];
}

function applyOpsToSliders(ops: Op[]): void {
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  exposureSlider.value = String(exposureOp?.ev ?? 0);
  wbSlider.value = String(wbOp?.kelvin ?? WB_NEUTRAL_KELVIN);
  updateSliderFill(exposureSlider);
  updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
  updateReadout(exposureValue, Number(exposureSlider.value), 2);
  wbValue.textContent = `${Number(wbSlider.value)}K`;
}

updateSliderFill(exposureSlider);
updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
updateReadout(exposureValue, Number(exposureSlider.value), 2);
wbValue.textContent = `${Number(wbSlider.value)}K`;

// The flattened, virtualizer-facing shape of the catalog: one entry per
// folder heading, one entry per row of up to COLUMNS_PER_ROW files. This
// is what lets a single Virtualizer (which only understands "N items,
// each with a size") represent a grid grouped by folder.
type GridEntry =
  | { kind: 'heading'; folderName: string }
  | { kind: 'row'; files: FileRecord[] };

function chunkIntoRows(files: FileRecord[]): FileRecord[][] {
  const rows: FileRecord[][] = [];
  for (let i = 0; i < files.length; i += COLUMNS_PER_ROW) {
    rows.push(files.slice(i, i + COLUMNS_PER_ROW));
  }
  return rows;
}

function opsToLabel(ops: Op[]): string {
  if (ops.length === 0) return 'Import';
  return ops
    .map((op) => {
      if (isExposureOp(op)) return `Exposure ${op.ev >= 0 ? '+' : ''}${op.ev.toFixed(2)}`;
      return `WB ${op.kelvin}K`;
    })
    .join(' · ');
}

async function init(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openCatalogDb();
  } catch (err) {
    showError("Couldn't open your photo catalog.", errorDetail(err));
    addFolderButton.disabled = true;
    return;
  }

  let pipeline: Pipeline;
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError("This browser can't run the editor (WebGPU is required).", errorDetail(err));
    addFolderButton.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
    return;
  }

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;
  let lastDecoded: { width: number; height: number } | null = null;
  // Which file's Bayer data currently lives in the GPU pipeline. Selecting a
  // file in Library no longer decodes it (decode is deferred to Develop
  // entry), so this is how Develop knows whether it needs to decode first or
  // can just re-render from the existing textures.
  let loadedFileId: number | null = null;
  let openRequestId = 0;
  let folders: FolderRecord[] = [];
  let allFiles: FileRecord[] = [];
  let folderFilter: number | null = null;
  let gridEntries: GridEntry[] = [];

  // Caches the in-flight or resolved thumbnail request per file id, so
  // re-rendering the same visible cell across multiple virtualizer
  // range-changes (a normal scroll produces many) doesn't re-issue a fresh
  // getOrExtractThumbnail call each time -- callers just await the same
  // promise. This is a permanent per-session cache, including a
  // resolved-to-undefined ("not available") result -- retrying on every
  // scroll-driven miss would mean every visible cell re-running
  // loadThumbnail + queryPermission + requestPermission on every scroll
  // frame while permission is missing (the normal state right after a
  // reload, since File System Access grants don't persist), which is
  // exactly the per-frame cost a virtualized grid exists to avoid. The one
  // place permission actually changes is a real user gesture, so openFile
  // (below) is what busts this cache and asks for one fresh retry pass,
  // not scroll. The filmstrip shares this same cache (via getThumbnail).
  const thumbnailRequests = new Map<number, Promise<Blob | undefined>>();

  function getThumbnail(file: FileRecord): Promise<Blob | undefined> {
    let promise = thumbnailRequests.get(file.id);
    if (!promise) {
      promise = getOrExtractThumbnail(db, file).catch(() => undefined);
      thumbnailRequests.set(file.id, promise);
    }
    return promise;
  }

  function renderOps(ops: Op[]): void {
    pipeline.render(opsToAdjustState(ops));
  }

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => libraryScroll,
    estimateSize: (index) => (gridEntries[index]?.kind === 'heading' ? HEADING_HEIGHT : CELL_SIZE),
    overscan: 3,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => renderVisibleRows(),
  });
  // @tanstack/virtual-core's headless package (not a framework adapter --
  // confirmed against the installed v3.17.8 types) has no `.observe()`.
  // `_didMount()` wires up the resize/scroll observers and returns the
  // cleanup function; `_willUpdate()` must be called before reading
  // `getTotalSize()`/`getVirtualItems()` to refresh measurements -- done
  // once here for the initial render, and again at the top of
  // `renderVisibleRows()` since that's also what `onChange` re-invokes on
  // every scroll/resize.
  const cleanupGrid = virtualizer._didMount();
  virtualizer._willUpdate();

  // Renders only the grid rows the virtualizer currently reports as
  // in-range -- this is the function that keeps a 10,000-file catalog from
  // creating 10,000 DOM nodes or requesting 10,000 thumbnails up front.
  function renderVisibleRows(): void {
    virtualizer._willUpdate();
    libraryGrid.style.height = `${virtualizer.getTotalSize()}px`;
    libraryGrid.textContent = '';
    const selectedId = getState().selectedId;
    for (const virtualItem of virtualizer.getVirtualItems()) {
      const entry = gridEntries[virtualItem.index];
      if (!entry) continue;

      if (entry.kind === 'heading') {
        const heading = document.createElement('strong');
        heading.className = 'catalog-heading';
        heading.style.top = `${virtualItem.start}px`;
        heading.textContent = entry.folderName;
        libraryGrid.appendChild(heading);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'catalog-row';
      row.style.top = `${virtualItem.start}px`;
      for (const file of entry.files) {
        const cell = document.createElement('div');
        cell.className = 'catalog-cell' + (file.id === selectedId ? ' selected' : '');
        cell.title = file.path;
        cell.addEventListener('click', () => openFile(file));
        cell.addEventListener('dblclick', () => switchModule('develop'));
        row.appendChild(cell);

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
      libraryGrid.appendChild(row);
    }
  }

  // Rebuilds the flattened catalog (folders, allFiles, gridEntries) from
  // the database, honoring folderFilter, then refreshes grid, folder
  // list, and filmstrip. Called on import and on folder-filter clicks.
  async function renderCatalog(): Promise<void> {
    folders = await listFolders(db);
    allFiles = [];
    gridEntries = [];
    for (const folder of folders) {
      if (folderFilter !== null && folder.id !== folderFilter) continue;
      const files = await listFiles(db, folder.id);
      allFiles.push(...files);
      gridEntries.push({ kind: 'heading', folderName: folder.name });
      for (const row of chunkIntoRows(files)) {
        gridEntries.push({ kind: 'row', files: row });
      }
    }
    virtualizer.setOptions({ ...virtualizer.options, count: gridEntries.length });
    virtualizer.measure();
    renderVisibleRows();
    renderFolderList();
    filmstrip.setFiles(allFiles.length);
  }

  function renderFolderList(): void {
    folderListEl.textContent = '';
    appendFolderRow(null, 'All folders');
    for (const folder of folders) {
      appendFolderRow(folder.id, folder.name);
    }
  }

  function appendFolderRow(id: number | null, name: string): void {
    const row = document.createElement('button');
    row.className = 'folder-row' + (folderFilter === id ? ' active' : '');
    row.textContent = name;
    row.addEventListener('click', () => {
      folderFilter = id;
      renderCatalog(); // also re-renders the folder list active state
    });
    folderListEl.appendChild(row);
  }

  function renderMetadata(): void {
    metadataEl.textContent = '';
    const file = allFiles.find((f) => f.id === currentFileId);
    if (!file) return;
    appendMeta('Name', file.name);
    appendMeta('Dimensions', lastDecoded ? `${lastDecoded.width} × ${lastDecoded.height}` : '—');
    appendMeta('Size', `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    appendMeta('Modified', new Date(file.lastModified).toLocaleString());
  }

  function appendMeta(label: string, value: string): void {
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('span');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'meta-value';
    v.textContent = value;
    row.append(l, v);
    metadataEl.appendChild(row);
  }

  function renderHistory(): void {
    historyListEl.textContent = '';
    if (!currentEditState) return;
    const { history, cursor } = currentEditState;
    history.forEach((ops, index) => {
      const row = document.createElement('button');
      row.className = 'history-row' + (index === cursor ? ' active' : '');
      row.textContent = opsToLabel(ops);
      row.addEventListener('click', () => {
        if (!currentEditState) return;
        currentEditState = { ...currentEditState, cursor: index };
        const opsAtCursor = currentOps(currentEditState);
        applyOpsToSliders(opsAtCursor);
        renderOps(opsAtCursor);
        renderHistory();
        saveEditState(db, currentFileId!, currentEditState).catch((err) =>
          showError("Couldn't save your edit.", errorDetail(err)),
        );
      });
      historyListEl.appendChild(row);
    });
  }

  // Permission-checking lives inside this try block (not before it) so a
  // rejection from ensureReadPermission (e.g. requestPermission() called
  // without an active user gesture) is caught the same way a decode
  // failure is, instead of becoming an unhandled rejection.
  async function openFile(record: FileRecord): Promise<void> {
    clearError();
    // Temporary perf probe (click-jank investigation): every selection
    // synchronously notifies subscribers -- the filmstrip scrolls the
    // selected cell into view and re-renders its visible cells. Log how long
    // that sync block takes so the jank can be attributed or ruled out.
    const selStart = performance.now();
    selectFile(record.id);
    console.log(`[app] selectFile sync block: ${(performance.now() - selStart).toFixed(1)}ms`);
    const requestId = ++openRequestId;
    try {
      // Checked separately from ensureReadPermission() below so we know
      // whether THIS call is what granted access, vs. access already having
      // been granted (the common case for every click after the first).
      // Clearing/re-rendering the thumbnail grid is not free (it re-fetches
      // every visible cell) -- doing that on every single file click, not
      // just the one that actually changed permission state, was visibly
      // janky (competing with this very decode() call for the shared WASM
      // module) and added nothing once permission was already settled.
      const alreadyGranted = (await record.handle.queryPermission({ mode: 'read' })) === 'granted';

      if (!(await ensureReadPermission(record.handle))) {
        showError(`Permission needed to read "${record.name}" -- click it again to retry.`);
        return;
      }

      // Only the transition from not-granted to granted needs a thumbnail
      // retry pass -- see the comment above. Once permission is already
      // settled, every later click skips straight to decoding.
      if (!alreadyGranted) {
        thumbnailRequests.clear();
        renderVisibleRows();
      }

      const editState = await loadEditState(db, record.id);
      if (requestId !== openRequestId) return; // superseded while loading edit state

      currentFileId = record.id;
      currentEditState = editState;
      const ops = currentOps(editState);
      applyOpsToSliders(ops);

      // The full raw decode is the slow synchronous LibRaw step (~1.6s), so
      // it runs only when the image is about to be shown -- i.e. the loupe is
      // already on screen. A Library grid click just selects: culling stays
      // responsive, and Develop entry (onShow) decodes on demand. When we
      // skip the decode, lastDecoded is cleared so metadata can't show a
      // previous file's dimensions.
      if (getState().module === 'develop') {
        const ok = await loadIntoPipeline(record, requestId);
        if (ok) renderOps(currentOps(currentEditState));
      } else {
        lastDecoded = null;
      }
      renderMetadata();
      renderHistory();
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }
  }

  // Decodes `record` (LibRaw -- the slow synchronous step), sizes the canvas,
  // and uploads the Bayer data to the GPU. Callers own the render. Returns
  // false if a newer selection superseded this one mid-decode.
  async function loadIntoPipeline(record: FileRecord, requestId: number): Promise<boolean> {
    const start = performance.now();
    const file = await record.handle.getFile();
    const decoded = await decode(await file.arrayBuffer());
    if (requestId !== openRequestId) return false; // superseded during decode
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    // Re-create the WebGPU surface at the just-set size. Chrome 151 ties the
    // drawing buffer to the canvas size at configure() time -- a configure
    // left over from a different-size file would leave the blit target
    // mismatched with the loaded image.
    pipeline.show();
    pipeline.load(decoded);
    loadedFileId = record.id;
    lastDecoded = { width: decoded.width, height: decoded.height };
    // waitForGPU() is awaited only for the perf log below -- it doesn't gate
    // anything, since nothing after it touches shared state.
    await pipeline.waitForGPU();
    console.log(`decode+demosaic: ${(performance.now() - start).toFixed(1)}ms (${decoded.width}x${decoded.height})`);
    return true;
  }

  // Decodes + loads the current selection if its Bayer data isn't already in
  // the pipeline. Called on Develop entry for a file that was selected from
  // Library (which no longer decodes eagerly).
  async function ensureDevelopImage(): Promise<void> {
    if (loadedFileId === currentFileId) return;
    const record = allFiles.find((f) => f.id === currentFileId);
    if (!record) return;
    try {
      await loadIntoPipeline(record, openRequestId);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }
  }

  async function onSliderInput(): Promise<void> {
    if (currentFileId === null) return;
    const start = performance.now();
    renderOps(currentOpsFromSliders());
    await pipeline.waitForGPU();
    const elapsed = performance.now() - start;
    console.log(`slider->frame: ${elapsed.toFixed(1)}ms`);
  }

  // Fires on slider release (the 'change' event), not on every 'input'
  // tick -- one drag from end to end is one undo step, not hundreds.
  async function commitCurrentEdit(): Promise<void> {
    if (currentFileId === null || !currentEditState) return;
    currentEditState = commitEdit(currentEditState, currentOpsFromSliders());
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save your edit.", errorDetail(err));
    }
    renderHistory();
  }

  async function applyUndoRedo(isRedo: boolean): Promise<void> {
    if (currentFileId === null || !currentEditState) return;
    currentEditState = isRedo ? redo(currentEditState) : undo(currentEditState);
    const ops = currentOps(currentEditState);
    applyOpsToSliders(ops);
    renderOps(ops);
    renderHistory();
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save your undo/redo.", errorDetail(err));
    }
  }

  exposureSlider.addEventListener('input', () => {
    updateSliderFill(exposureSlider);
    updateReadout(exposureValue, Number(exposureSlider.value), 2);
    onSliderInput();
  });
  exposureSlider.addEventListener('change', () => {
    commitCurrentEdit();
  });

  wbSlider.addEventListener('input', () => {
    updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
    wbValue.textContent = `${Number(wbSlider.value)}K`;
    onSliderInput();
  });
  wbSlider.addEventListener('change', () => {
    commitCurrentEdit();
  });

  undoButton.addEventListener('click', () => applyUndoRedo(false));
  redoButton.addEventListener('click', () => applyUndoRedo(true));

  // Temporary diagnostic (Develop-mode black-image investigation): reports
  // whether the GPU compute chain produced a non-black image (adjustedTexture
  // readback) and what the canvas actually displays (1x1 pixel readback at the
  // image center). Output goes to the browser console.
  function runDevelopDiagnostics(): void {
    pipeline
      .diagnostic()
      .then((s) => console.log('[app]', s))
      .catch((e) => console.error('[app] diagnostic readback failed:', e));
    try {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const p2d = probe.getContext('2d', { willReadFrequently: true })!;
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);
      p2d.drawImage(canvas, cx, cy, 1, 1, 0, 0, 1, 1);
      const px = p2d.getImageData(0, 0, 1, 1).data;
      console.log(`[app] canvas pixel at (${cx},${cy}) = rgba(${px[0]},${px[1]},${px[2]},${px[3]})`);
    } catch (e) {
      console.error('[app] canvas pixel probe failed:', e);
    }
  }

  // ---- module wiring ----
  registerModule({
    id: 'library',
    root: document.querySelector('#module-library')!,
    onShow: () => {},
    onHide: () => {},
  });
  registerModule({
    id: 'develop',
    root: document.querySelector('#module-develop')!,
    onShow: () => {
      // The canvas sits inside a display:none section while Library is
      // active; the WebGPU drawing buffer's contents are undefined after
      // the surface is hidden/re-shown, so re-render from the existing
      // textures (cheap -- no decode; the pipeline already holds them).
      if (currentFileId === null || !currentEditState) return;
      // The render is deferred to the next animation frame so layout has run
      // on the now-visible canvas first (switchModule calls onShow()
      // synchronously right after unhiding).
      requestAnimationFrame(() => {
        // Files selected from Library are decoded lazily (see openFile), so
        // on first Develop entry the Bayer data may not be in the pipeline
        // yet -- decode + load it, then render from the existing textures
        // (cheap: no re-decode when the data is already loaded).
        ensureDevelopImage().then(() => {
          // show() re-creates the surface at the canvas's current size. The
          // surface was configured while the canvas was display:none or for
          // a previous file, and Chrome 151 ties the drawing buffer to the
          // canvas size at configure() time, so this must happen after the
          // canvas has been resized to the loaded image (loadIntoPipeline
          // already did, if it ran).
          pipeline.show();
          renderOps(currentOps(currentEditState!));
          runDevelopDiagnostics();
        });
      });
    },
    onHide: () => {},
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-module]')) {
    button.addEventListener('click', () => switchModule(button.dataset.module as ModuleId));
  }

  // Keeps the topbar tab highlight in sync with the active module,
  // whichever path changed it (click or G/E shortcut).
  subscribe(() => {
    const module = getState().module;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-module]')) {
      button.classList.toggle('active', button.dataset.module === module);
    }
  });

  // ---- shortcuts ----
  window.addEventListener('keydown', async (e) => {
    const action = keyToAction(e);
    if (!action) return;

    if (action === 'grid' || action === 'loupe') {
      e.preventDefault();
      // Shortcut actions are named for the target workspace; module ids
      // are 'library'/'develop'.
      switchModule(action === 'grid' ? 'library' : 'develop');
      return;
    }
    if (action === 'undo' || action === 'redo') {
      e.preventDefault();
      await applyUndoRedo(action === 'redo');
      return;
    }

    // prev/next walk the flat, folder-ordered file list; with no selection
    // yet, the first arrow selects the first file (Lightroom-ish).
    e.preventDefault();
    const index = allFiles.findIndex((f) => f.id === getState().selectedId);
    const nextIndex = index === -1 ? 0 : action === 'next' ? index + 1 : index - 1;
    const file = allFiles[nextIndex];
    if (file) await openFile(file);
  });

  // ---- filmstrip ----
  const filmstrip = createFilmstrip({
    scrollEl: filmstripScroll,
    trackEl: filmstripTrack,
    getFiles: () => allFiles,
    getThumbnail,
    onSelect: (file) => openFile(file),
  });

  // AbortError means the user opened the folder picker and dismissed it --
  // the single most common outcome of clicking this button. That's not an
  // error worth surfacing; anything else (a real I/O failure, a rejected
  // permission request during the walk) goes through showError like every
  // other failure path in this file.
  addFolderButton.addEventListener('click', async () => {
    addFolderButton.disabled = true;
    try {
      await importFolder(db);
      await renderCatalog();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showError("Couldn't import that folder.", errorDetail(err));
    } finally {
      addFolderButton.disabled = false;
    }
  });

  await renderCatalog();

  window.addEventListener(
    'beforeunload',
    () => {
      cleanupGrid();
      filmstrip.destroy();
    },
    { once: true },
  );
}

init();
