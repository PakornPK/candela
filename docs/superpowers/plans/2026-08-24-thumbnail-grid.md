# Thumbnail Grid & Virtual Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the catalog's text-only file list with an LrC Library-style thumbnail grid: embedded-JPEG thumbnail extraction (no demosaic), lazy generation tied to virtual scrolling, IndexedDB persistence.

**Architecture:** A new native `extract_thumbnail()` WASM export (alongside the existing `decode()`) pulls the camera-embedded JPEG preview straight out of the raw file. `src/catalog/thumbnails.ts` wraps that with an IndexedDB-backed cache (`getOrExtractThumbnail`). `main.ts`'s `renderCatalog()` is rewritten around `@tanstack/virtual-core` (this project's first runtime dependency) to render only the grid rows currently in view, requesting thumbnails only for cells that scroll into range.

**Tech Stack:** TypeScript (strict), C++17/LibRaw (WASM), IndexedDB (schema v1→v2 migration), `@tanstack/virtual-core`.

**Spec:** [`docs/superpowers/specs/2026-08-24-thumbnail-grid-design.md`](../specs/2026-08-24-thumbnail-grid-design.md)

**Known simplification carried from the spec:** a fixed `COLUMNS_PER_ROW` constant, not responsive to container width -- matches this project's established "hardcode it, refactor later" style (`CLAUDE.md`: "Do not design a clean op graph... Refactor later"), same reasoning applied to grid layout. LrC's grid-density zoom slider is also not built now, per the spec.

---

## Task 1: Native thumbnail extraction (`extract_thumbnail`) + WASM rebuild

**Files:**
- Modify: `native/libraw-wrapper/wrapper.cpp`

- [ ] **Step 1: Add `ThumbnailResult` and `extract_thumbnail()` to `wrapper.cpp`**

Read the current `native/libraw-wrapper/wrapper.cpp` first -- add the following inside the existing `extern "C" { ... }` block, after `free_decoded()` and before the closing `}`:

```cpp
// Ownership/lifecycle mirrors DecodeResult/decode() above -- see that
// struct's comment for the full contract. JS must call free_thumbnail()
// exactly once per extract_thumbnail() call, except when
// extract_thumbnail() itself returns nullptr (nothing to free).
struct ThumbnailResult {
    uint8_t* data = nullptr;
    uint32_t length = 0;
    // 0 = success, LibRaw error codes otherwise (open_buffer/unpack_thumb
    // failures), -1000 = embedded thumbnail exists but isn't JPEG format
    // (LIBRAW_THUMBNAIL_JPEG required -- wrapper-detected, not a LibRaw
    // code, kept clear of LibRaw's own range same as DecodeResult's -1000),
    // -1001 = allocation/exception raised by the wrapper's own code.
    int error_code = 0;
};

EMSCRIPTEN_KEEPALIVE
ThumbnailResult* extract_thumbnail(const uint8_t* file_bytes, uint32_t length) {
    ThumbnailResult* result = nullptr;

    try {
        result = new ThumbnailResult{};

        LibRaw processor;

        int ret = processor.open_buffer(const_cast<uint8_t*>(file_bytes), length);
        if (ret != LIBRAW_SUCCESS) {
            result->error_code = ret;
            return result;
        }

        ret = processor.unpack_thumb();
        if (ret != LIBRAW_SUCCESS) {
            result->error_code = ret;
            return result;
        }

        const auto& thumb = processor.imgdata.thumbnail;
        if (thumb.tformat != LIBRAW_THUMBNAIL_JPEG || thumb.thumb == nullptr || thumb.tlength == 0) {
            result->error_code = -1000;
            return result;
        }

        auto data_owned = std::make_unique<uint8_t[]>(thumb.tlength);
        std::memcpy(data_owned.get(), thumb.thumb, thumb.tlength);

        result->data = data_owned.release(); // ownership crosses to JS; freed via free_thumbnail()
        result->length = static_cast<uint32_t>(thumb.tlength);
        result->error_code = 0;
    } catch (const std::exception&) {
        if (result == nullptr) {
            return nullptr;
        }
        result->error_code = -1001;
    }

    return result;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* thumbnail_result_data_ptr(ThumbnailResult* r) { return r->data; }

EMSCRIPTEN_KEEPALIVE
uint32_t thumbnail_result_length(ThumbnailResult* r) { return r->length; }

EMSCRIPTEN_KEEPALIVE
int thumbnail_result_error_code(ThumbnailResult* r) { return r->error_code; }

EMSCRIPTEN_KEEPALIVE
void free_thumbnail(ThumbnailResult* r) {
    if (!r) return;
    delete[] r->data;
    delete r;
}
```

No `CMakeLists.txt` change needed -- `EMSCRIPTEN_KEEPALIVE` alone exports a symbol for `ccall`; `EXPORTED_FUNCTIONS` in `CMakeLists.txt` only lists `_malloc`/`_free` today and the existing `decode_result_*` functions already prove this (they're `ccall`-only too, not in that list).

- [ ] **Step 2: Rebuild the WASM module**

Run:
```bash
./native/libraw-wrapper/build.sh
```
Expected: rebuilds `src/wasm/libraw.js`/`.wasm` with the new exports included. (If the submodule isn't initialized or Emscripten isn't on `PATH`, see the catalog foundation plan's Task 14 setup notes -- `git submodule update --init --recursive`, then this script.)

- [ ] **Step 3: Sanity-check the native test suite still passes (unrelated to this change, but cheap to confirm)**

Run: `./native/libraw-wrapper/build-test.sh`
Expected: `100% tests passed, 0 tests failed out of 1` (this only covers `validate_dimensions`, untouched by this task -- confirms the build environment itself is healthy before moving on).

- [ ] **Step 4: Commit**

```bash
git add native/libraw-wrapper/wrapper.cpp
git commit -m "feat: add extract_thumbnail() WASM export for embedded JPEG previews"
```

---

## Task 2: TS thumbnail decode wrapper + integration test

**Files:**
- Create: `src/raw/thumbnail.ts`, `src/raw/thumbnail.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/raw/thumbnail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractThumbnail, ThumbnailError } from './thumbnail';

function loadFixture(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('extractThumbnail', () => {
  it('extracts a JPEG-format embedded thumbnail from a real raw fixture', async () => {
    const blob = await extractThumbnail(loadFixture('sample.raf'));
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(0);
    // A real JPEG always starts with the SOI marker 0xFFD8.
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(Array.from(header)).toEqual([0xff, 0xd8]);
  });

  it('rejects a garbage buffer with a ThumbnailError', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(extractThumbnail(garbage)).rejects.toBeInstanceOf(ThumbnailError);
  });
});
```

This reuses the same `src/raw/__fixtures__/sample.raf` fixture `decode.test.ts` already depends on (gitignored, copied locally per the catalog foundation plan's Task 14 setup) -- no new fixture needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL -- `Cannot find module './thumbnail'`

- [ ] **Step 3: Implement**

Create `src/raw/thumbnail.ts`:

```ts
// @ts-expect-error -- Emscripten glue has no bundled types
import createLibRawModule from '../wasm/libraw.js';

interface LibRawModule {
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => number;
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
}

let modulePromise: Promise<LibRawModule> | null = null;

function getModule(): Promise<LibRawModule> {
  if (!modulePromise) {
    modulePromise = createLibRawModule() as Promise<LibRawModule>;
  }
  return modulePromise;
}

export class ThumbnailError extends Error {
  constructor(public readonly code: number) {
    super(`LibRaw thumbnail extraction failed with code ${code}`);
    this.name = 'ThumbnailError';
  }
}

export async function extractThumbnail(fileBytes: ArrayBuffer): Promise<Blob> {
  const module = await getModule();
  const bytes = new Uint8Array(fileBytes);

  const inputPtr = module._malloc(bytes.length);
  if (inputPtr === 0) {
    throw new ThumbnailError(-1003);
  }
  module.HEAPU8.set(bytes, inputPtr);

  const resultPtr = module.ccall('extract_thumbnail', 'number', ['number', 'number'], [inputPtr, bytes.length]);
  module._free(inputPtr);

  if (resultPtr === 0) {
    throw new ThumbnailError(-1002);
  }

  const errorCode = module.ccall('thumbnail_result_error_code', 'number', ['number'], [resultPtr]);
  if (errorCode !== 0) {
    module.ccall('free_thumbnail', null, ['number'], [resultPtr]);
    throw new ThumbnailError(errorCode);
  }

  const length = module.ccall('thumbnail_result_length', 'number', ['number'], [resultPtr]);
  const dataPtr = module.ccall('thumbnail_result_data_ptr', 'number', ['number'], [resultPtr]);

  // Copies the bytes out of wasm memory before free_thumbnail() releases
  // them -- same pattern as decode.ts's bayerData handling.
  const jpegBytes = module.HEAPU8.slice(dataPtr, dataPtr + length);

  module.ccall('free_thumbnail', null, ['number'], [resultPtr]);

  return new Blob([jpegBytes], { type: 'image/jpeg' });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `48 passed` (46 pre-existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/raw/thumbnail.ts src/raw/thumbnail.test.ts
git commit -m "feat: add extractThumbnail() TS wrapper with real-fixture integration test"
```

---

## Task 3: IndexedDB schema migration (v1 → v2, `thumbnails` store)

**Files:**
- Modify: `src/catalog/db.ts`

- [ ] **Step 1: Implement the migration**

Replace `src/catalog/db.ts` in full:

```ts
const DB_NAME = 'candela-catalog';
const DB_VERSION = 2;

export function openCatalogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (event.oldVersion < 1) {
        const folders = db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
        folders.createIndex('name', 'name');

        const files = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
        files.createIndex('folderId', 'folderId');
        files.createIndex('folderPath', ['folderId', 'path']);

        db.createObjectStore('edits', { keyPath: 'fileId' });
      }

      if (event.oldVersion < 2) {
        db.createObjectStore('thumbnails', { keyPath: 'fileId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

A brand-new database (`event.oldVersion === 0`) runs both blocks and ends up with all four stores in one pass -- same end state as before for a first-time user. An existing v1 database only runs the second block, adding `thumbnails` without re-touching (and erroring on) the three stores that already exist.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/db.ts
git commit -m "feat: add thumbnails object store (IndexedDB schema v1->v2)"
```

---

## Task 4: Thumbnail cache (`src/catalog/thumbnails.ts`)

**Files:**
- Create: `src/catalog/thumbnails.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/thumbnails.ts`:

```ts
import type { FileRecord } from './types';
import { extractThumbnail } from '../raw/thumbnail';
import { ensureReadPermission } from './permissions';

interface ThumbnailRow {
  fileId: number;
  blob: Blob | null;
  extractedAt: number;
}

// undefined = no row yet (never attempted); null = attempted and failed
// (negative cache, so a permanently-broken thumbnail isn't retried on
// every scroll); Blob = extracted successfully.
export function loadThumbnail(db: IDBDatabase, fileId: number): Promise<Blob | null | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('thumbnails', 'readonly').objectStore('thumbnails').get(fileId);
    request.onsuccess = () => {
      const row = request.result as ThumbnailRow | undefined;
      resolve(row ? row.blob : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

export function saveThumbnail(db: IDBDatabase, fileId: number, blob: Blob | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: ThumbnailRow = { fileId, blob, extractedAt: Date.now() };
    const request = db.transaction('thumbnails', 'readwrite').objectStore('thumbnails').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Checks the cache first; only touches the file/WASM on a cache miss, and
// only persists a negative-cache row for a genuine extraction failure --
// not for a missing permission grant, which is retryable (e.g. once the
// user has clicked another file and re-granted access this session), not
// permanent like a corrupt file or a non-JPEG embedded thumbnail.
export async function getOrExtractThumbnail(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  const cached = await loadThumbnail(db, record.id);
  if (cached !== undefined) return cached ?? undefined;

  if (!(await ensureReadPermission(record.handle))) {
    return undefined; // not yet permitted -- don't negative-cache, may succeed later this session
  }

  try {
    const file = await record.handle.getFile();
    const blob = await extractThumbnail(await file.arrayBuffer());
    await saveThumbnail(db, record.id, blob);
    return blob;
  } catch {
    await saveThumbnail(db, record.id, null);
    return undefined;
  }
}
```

## Context

`ensureReadPermission` (from `src/catalog/permissions.ts`, already built) is reused here rather than duplicated -- `getOrExtractThumbnail` will typically be called from a scroll-driven context, not a click, so `requestPermission()`'s user-gesture requirement (its own doc comment) will often fail there; this function treats that as "try again later," not a failure worth remembering.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/thumbnails.ts
git commit -m "feat: add IndexedDB-backed thumbnail cache with permission-aware negative caching"
```

---

## Task 5: Add `@tanstack/virtual-core` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run:
```bash
npm install @tanstack/virtual-core
```

This is the project's first entry under `dependencies` (everything installed through the spike and the catalog foundation was a `devDependency` -- type packages, the test runner, the bundler). Confirm after install that `package.json` now has a top-level `"dependencies"` key with `@tanstack/virtual-core` in it (not `devDependencies` -- `npm install` without `-D` places it correctly, but double-check the diff).

- [ ] **Step 2: Verify the project still type-checks and tests still pass**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, `48 passed` (nothing about installing a dependency should change test count -- this just confirms the install didn't break anything before building on top of it)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @tanstack/virtual-core for grid virtualization"
```

---

## Task 6: Grid markup & styles (`index.html`)

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the catalog list markup with a scrollable grid container**

In `index.html`, replace:

```html
      <button id="add-folder">Add folder</button>
      <ul id="catalog-list"></ul>
```

with:

```html
      <button id="add-folder">Add folder</button>
      <div id="catalog-scroll">
        <div id="catalog-grid"></div>
      </div>
```

- [ ] **Step 2: Add grid CSS to the existing `<style>` block**

Add, alongside the existing rules (after the `#error-detail` rule):

```css
      #catalog-scroll {
        height: 400px;
        overflow-y: auto;
        position: relative;
      }
      #catalog-grid {
        position: relative;
        width: 100%;
      }
      .catalog-heading {
        position: absolute;
        left: 0;
        right: 0;
      }
      .catalog-row {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        gap: 4px;
      }
      .catalog-cell {
        width: 160px;
        height: 160px;
        background: #ddd;
        cursor: pointer;
        overflow: hidden;
        flex-shrink: 0;
      }
      .catalog-cell img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
```

Absolute positioning (`top` set per-element in Task 7, from the virtualizer) is how `@tanstack/virtual-core` places only the currently-rendered rows at their correct scroll offset within `#catalog-grid`, whose own height is set to the *full* virtual content height (also computed in Task 7) so the scrollbar reflects the true, un-virtualized size of the catalog.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add thumbnail grid markup and styles"
```

---

## Task 7: Wire the virtualized grid into `main.ts`

**Files:**
- Modify: `src/main.ts`

This is the largest task in this plan -- it replaces `renderCatalog()`'s list rendering with a virtualized grid, and is the one place `@tanstack/virtual-core`'s exact API is exercised. The shape below (`Virtualizer` constructor options, `observe()`, `getVirtualItems()`, `getTotalSize()`) matches `@tanstack/virtual-core`'s documented vanilla-JS usage as of the version installed in Task 5. **Before writing this file, read the type definitions actually installed** (`node_modules/@tanstack/virtual-core/dist/**/*.d.ts`, or your editor's hover/go-to-definition on `Virtualizer`) and confirm the constructor option names and instance methods below match -- if the installed version differs in a specific method/option name, use the real one and note the discrepancy in your self-review; don't guess further than that one adjustment.

- [ ] **Step 1: Read the current `src/main.ts`, `src/catalog/query.ts`, and `src/catalog/types.ts`**

The `FolderRecord`/`FileRecord` types and `listFolders`/`listFiles` functions this task builds on already exist -- read them first so the grid-building code below lines up with their actual current shape (it should, based on the catalog foundation plan, but confirm rather than assume).

- [ ] **Step 2: Replace `src/main.ts` in full**

```ts
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
import { isExposureOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord } from './catalog/types';

const COLUMNS_PER_ROW = 6; // fixed for this pass -- see plan header
const CELL_SIZE = 160; // px, matches index.html's .catalog-cell
const HEADING_HEIGHT = 24; // px, matches index.html's .catalog-heading

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const catalogScroll = document.querySelector<HTMLDivElement>('#catalog-scroll')!;
const catalogGrid = document.querySelector<HTMLDivElement>('#catalog-grid')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLDivElement>('#error')!;
const errorMessageEl = document.querySelector<HTMLParagraphElement>('#error-message')!;
const errorDetailEl = document.querySelector<HTMLPreElement>('#error-detail')!;

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

async function buildGridEntries(db: IDBDatabase): Promise<GridEntry[]> {
  const entries: GridEntry[] = [];
  for (const folder of await listFolders(db)) {
    entries.push({ kind: 'heading', folderName: folder.name });
    const files = await listFiles(db, folder.id);
    for (const row of chunkIntoRows(files)) {
      entries.push({ kind: 'row', files: row });
    }
  }
  return entries;
}

// Interactive listeners are attached only after init() succeeds -- same
// boundary the spike used for Pipeline.create(), extended to also cover
// opening the catalog database, so neither failure mode can leave a
// half-wired UI behind.
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
  let openRequestId = 0;
  let gridEntries: GridEntry[] = [];

  function renderOps(ops: Op[]): void {
    pipeline.render(opsToAdjustState(ops));
  }

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => catalogScroll,
    estimateSize: (index) => (gridEntries[index]?.kind === 'heading' ? HEADING_HEIGHT : CELL_SIZE),
    overscan: 3,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => renderVisibleRows(),
  });
  const unobserve = virtualizer.observe();

  // Renders only the grid rows the virtualizer currently reports as
  // in-range -- this is the function that keeps a 10,000-file catalog from
  // creating 10,000 DOM nodes or requesting 10,000 thumbnails up front.
  function renderVisibleRows(): void {
    catalogGrid.style.height = `${virtualizer.getTotalSize()}px`;
    catalogGrid.textContent = '';
    for (const virtualItem of virtualizer.getVirtualItems()) {
      const entry = gridEntries[virtualItem.index];
      if (!entry) continue;

      if (entry.kind === 'heading') {
        const heading = document.createElement('strong');
        heading.className = 'catalog-heading';
        heading.style.top = `${virtualItem.start}px`;
        heading.textContent = entry.folderName;
        catalogGrid.appendChild(heading);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'catalog-row';
      row.style.top = `${virtualItem.start}px`;
      for (const file of entry.files) {
        const cell = document.createElement('div');
        cell.className = 'catalog-cell';
        cell.title = file.path;
        cell.addEventListener('click', () => openFile(file));
        row.appendChild(cell);

        getOrExtractThumbnail(db, file).then((blob) => {
          if (!blob) return; // extraction failed or not yet permitted -- placeholder stays
          const img = document.createElement('img');
          img.src = URL.createObjectURL(blob);
          img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
          cell.appendChild(img);
        });
      }
      catalogGrid.appendChild(row);
    }
  }

  async function renderCatalog(): Promise<void> {
    gridEntries = await buildGridEntries(db);
    virtualizer.setOptions({ ...virtualizer.options, count: gridEntries.length });
    virtualizer.measure();
    renderVisibleRows();
  }

  // Permission-checking lives inside this try block (not before it) so a
  // rejection from ensureReadPermission (e.g. requestPermission() called
  // without an active user gesture) is caught the same way a decode
  // failure is, instead of becoming an unhandled rejection.
  async function openFile(record: FileRecord): Promise<void> {
    clearError();
    const requestId = ++openRequestId;
    try {
      if (!(await ensureReadPermission(record.handle))) {
        showError(`Permission needed to read "${record.name}" -- click it again to retry.`);
        return;
      }

      const start = performance.now();
      const file = await record.handle.getFile();
      const decoded = await decode(await file.arrayBuffer());
      if (requestId !== openRequestId) return; // superseded during decode -- skip the wasted edit-state load

      const editState = await loadEditState(db, record.id);
      if (requestId !== openRequestId) return; // superseded while loading edit state

      // Everything above only touched local variables (decoded, editState) --
      // no shared state has been written yet. From here everything is
      // synchronous with no `await` in between, so this whole block commits
      // atomically: canvas, GPU pipeline, and catalog state all move together,
      // and nothing else can interleave a stale write partway through.
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      pipeline.load(decoded);
      currentFileId = record.id;
      currentEditState = editState;
      const ops = currentOps(currentEditState);
      applyOpsToSliders(ops);
      renderOps(ops);

      // waitForGPU() is awaited only for the perf log below -- it doesn't
      // gate anything, since nothing after it touches shared state.
      await pipeline.waitForGPU();
      const elapsed = performance.now() - start;
      console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);
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

  window.addEventListener('keydown', async (e) => {
    if (currentFileId === null || !currentEditState) return;
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    currentEditState = e.shiftKey ? redo(currentEditState) : undo(currentEditState);
    const ops = currentOps(currentEditState);
    applyOpsToSliders(ops);
    renderOps(ops);
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save your undo/redo.", errorDetail(err));
    }
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

  window.addEventListener('beforeunload', () => unobserve(), { once: true });
}

init();
```

## Context

Compared to the catalog foundation's `renderCatalog()` (a plain nested-`<ul>` walk), this version:
1. Flattens folders+files into `GridEntry[]` (one heading entry, one entry per row of up to `COLUMNS_PER_ROW` files) -- this is the array `Virtualizer` indexes into.
2. Creates one `Virtualizer` once (in `init()`, alongside `pipeline`), not per render -- `renderCatalog()` only updates its `count` (via `setOptions`) and calls `measure()` when the underlying data changes (new folder imported), while `onChange` (fired by the virtualizer itself on scroll) drives `renderVisibleRows()` continuously.
3. `renderVisibleRows()` is the only place that touches `catalogGrid`'s DOM -- it clears and rebuilds just the in-range rows/headings on every virtualizer change, positioning each via `virtualItem.start` (absolute `top`, per the CSS in Task 6).
4. Each cell kicks off `getOrExtractThumbnail` independently and attaches the `<img>` when (if) it resolves -- cells that scroll out of range before their thumbnail resolves simply never get the image appended (the cell itself may already be gone from the DOM by then, in which case the orphaned `.then()` callback's `cell.appendChild` is a harmless no-op on a detached node).

`unobserve()` (the cleanup function `Virtualizer.observe()` returns) is called on `beforeunload` -- mirrors this file's existing pattern of not leaving handles open past their needed lifetime (e.g. why `Pipeline.load()` destroys old textures), even though in practice a page unload would tear this down regardless.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If `Virtualizer`'s constructor options or instance methods don't match what's used above (see this task's opening note), fix the specific mismatched name(s) against the actual installed types before treating this as a real type error to chase further.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: `48 passed` (nothing in this task touches test files)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: replace catalog list with a virtualized thumbnail grid"
```

---

## Task 8: Manual end-to-end verification

Not automatable -- needs a real folder of raw files and a real browser. Use `npm run dev`.

**Files:** none (verification only)

- [ ] **Step 1: Upgrade a real v1 database (the migration path, not just a fresh install)**

Every other step in this task runs against a database created fresh by the new (v2) code, which never exercises the `event.oldVersion === 1` branch added in Task 3 -- that branch only runs when an existing v1 database (created by the code that shipped *before* this plan) is opened by the new build. Test that specific path once, deliberately:

1. `git stash` any uncommitted work, then `git checkout c969a70` (the last commit before Task 3's migration) in this worktree.
2. `npm run dev`, import a folder with a few files, open one and adjust a slider (so `folders`/`files`/`edits` all have real data, not just an empty schema).
3. Stop the dev server. `git checkout thumbnail-grid` (back to the tip of this branch) -- do **not** clear IndexedDB / site data in the browser between steps 3 and 4.
4. `npm run dev` again, reload the page pointed at the same origin (same `localhost` port, so it's the same IndexedDB).
5. Confirm: the folder/files/edit you set up in step 2 still appear correctly (nothing lost or corrupted), no console error about `ConstraintError` or a failed upgrade, and thumbnails now load for that folder's files -- confirming `thumbnails` was added on top of the existing v1 data rather than the upgrade failing or wiping the database.

- [ ] **Step 2: Grid renders with thumbnails**

Import the same folder used in the catalog foundation's verification (or any folder with several raw files). Confirm the grid appears (not the old text list), grouped by folder with headings, and that thumbnails appear on cells as you scroll -- not all at once on import.

- [ ] **Step 3: Scrolling behavior**

Scroll down through a folder with more files than fit on screen. Confirm: the scrollbar reflects the true total size (not just what's rendered), cells render smoothly as you scroll (no visible gap/flash where a row should be), and thumbnails for newly-visible cells load in shortly after scrolling to them.

- [ ] **Step 4: Cache hit on re-scroll**

Scroll down past a section, then back up to it. Confirm thumbnails that were already loaded appear immediately (no re-fetch delay) -- this is `loadThumbnail`'s IndexedDB hit path, not `extractThumbnail` running again. (Optional: open the browser's Network/Performance tooling or just watch the console -- a re-scroll should feel instant compared to the first pass.)

- [ ] **Step 5: Reload persistence**

Reload the page, re-open the same folder from the catalog (already imported, from IndexedDB). Confirm thumbnails appear immediately on scroll without needing to re-extract -- this confirms the `thumbnails` IndexedDB store survived the reload, same as `folders`/`files`/`edits` already do.

- [ ] **Step 6: Click-to-open still works**

Click a grid cell. Confirm it still opens the file into the editor (canvas + sliders), same as the pre-grid list did. Confirm the atomic-commit fix from the catalog foundation plan still holds -- click several different cells in quick succession and confirm the editor ends up showing the last one clicked, not a stale earlier one.

- [ ] **Step 7: A file with a non-JPEG or missing embedded thumbnail**

If you have (or can find) a raw file with no embedded JPEG preview or an unusual thumbnail format, confirm its cell shows the placeholder background (not a broken-image icon, not a crash, not an error banner) and that browsing the rest of the grid is unaffected.

- [ ] **Step 8: Record results**

Note the outcome of Steps 1-7 (pass/fail, Chrome version tested) as a short addition to this plan file's bottom or back in conversation, matching the catalog foundation plan's Task 14 convention.

---

## Self-Review Notes

- **Spec coverage:** §1 extraction -> Tasks 1-2. §2 persistence -> Tasks 3-4. §3 lazy loading -> Task 7 (`getOrExtractThumbnail` called per-cell inside `renderVisibleRows`). §4 grid UI -> Tasks 6-7. §5 error handling -> Task 7 (`showError` calls carry the friendly-message/detail shape; cell-local extraction failures never reach `showError` at all, per spec). §6 testing -> Task 2 unit/integration-tests the one WASM-adjacent piece worth testing (real JPEG magic-byte assertion); everything IndexedDB/DOM/virtualizer-dependent is manually verified in Task 8, consistent with the established boundary.
- **Type consistency checked:** `GridEntry`/`chunkIntoRows`/`buildGridEntries` (Task 7) consume `FolderRecord`/`FileRecord` and `listFolders`/`listFiles` exactly as the catalog foundation plan defined them -- no signature drift. `getOrExtractThumbnail`'s `Blob | undefined` return (Task 4) matches how Task 7's `renderVisibleRows` consumes it (`if (!blob) return;`). `ThumbnailError`/`extractThumbnail` (Task 2) match how Task 4's `getOrExtractThumbnail` calls them (no args/return-shape drift).
- **First runtime dependency:** flagged explicitly in Task 5 and the spec -- not a silent change to this project's dependency profile.
