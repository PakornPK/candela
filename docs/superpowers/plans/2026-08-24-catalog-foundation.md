# Catalog Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the spike's single-file picker with a persistent, IndexedDB-backed catalog (recursive folder import via the File System Access API) and a composable, undoable op graph for per-file edits.

**Architecture:** New `src/catalog/` modules own all catalog and persistence logic as a plain data API with no DOM references. `main.ts` stays the sole DOM-aware module — it renders the catalog list and wires slider/keyboard events into that data API. The existing GPU pipeline (`gpu/pipeline.ts`, shaders) is untouched; the op graph's only integration point is a pure `Op[] -> AdjustState` mapping, since `Pipeline.render()` already takes `AdjustState`.

**Tech Stack:** TypeScript (strict), IndexedDB, File System Access API (`showDirectoryPicker`, `FileSystemDirectoryHandle`/`FileSystemFileHandle`), Vitest for pure-logic unit tests.

**Spec:** [`docs/superpowers/specs/2026-08-24-catalog-foundation-design.md`](../specs/2026-08-24-catalog-foundation-design.md)

**Note on `EditState` shape vs. the spec:** the spec describes `EditState` as `{ ops, history, cursor }`. This plan drops the separate `ops` field — it was always redundant with `history[cursor]`, and keeping both risked them drifting out of sync. `EditState` here is `{ history: Op[][], cursor: number }`, with a `currentOps(state)` helper reading `history[cursor]`. Same behavior, one source of truth.

---

## Task 1: File System Access API type definitions

TypeScript's default DOM lib doesn't include `showDirectoryPicker`, `FileSystemDirectoryHandle`, `FileSystemFileHandle`, or their permission methods — this task adds the types package everything else in this plan depends on.

**Files:**
- Modify: `package.json`, `tsconfig.json`

- [ ] **Step 1: Install the types package**

Run:
```bash
npm install -D @types/wicg-file-system-access
```

- [ ] **Step 2: Register it in `tsconfig.json`**

Edit `tsconfig.json`, change the `types` array:

```json
"types": ["@webgpu/types", "node", "wicg-file-system-access"]
```

- [ ] **Step 3: Verify the project still type-checks**

Run: `npx tsc --noEmit`
Expected: no errors (nothing uses the new types yet — this just confirms the package resolves).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add File System Access API type definitions"
```

---

## Task 2: Move Kelvin↔shift conversion into `gpu/uniforms.ts`

`kelvinToShift` currently lives inline in `main.ts`. The catalog's `Op -> AdjustState` mapping (Task 6) needs it too, and it's pure conversion logic — it belongs next to `evToGain`/`wbShiftToGains` in `gpu/uniforms.ts`, not duplicated or left DOM-adjacent.

**Files:**
- Modify: `src/gpu/uniforms.ts`, `src/gpu/uniforms.test.ts`, `src/main.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/gpu/uniforms.test.ts` (after the existing `describe` blocks):

```ts
describe('kelvinToShift', () => {
  it('returns 0 at the neutral point', () => {
    expect(kelvinToShift(WB_NEUTRAL_KELVIN)).toBe(0);
  });

  it('scales to +1/-1 at the ends of the Kelvin range', () => {
    expect(kelvinToShift(9000)).toBeCloseTo(1);
    expect(kelvinToShift(2000)).toBeCloseTo(-1);
  });
});
```

Update the import at the top of the file:

```ts
import { evToGain, wbShiftToGains, packAdjustUniforms, packCfaPattern, kelvinToShift, WB_NEUTRAL_KELVIN } from './uniforms';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `kelvinToShift`/`WB_NEUTRAL_KELVIN` not exported from `./uniforms`

- [ ] **Step 3: Implement**

Add to `src/gpu/uniforms.ts` (after `packCfaPattern`):

```ts
export const WB_NEUTRAL_KELVIN = 5500;
const WB_KELVIN_HALF_RANGE = 3500;

// UI-facing conversion only: the WB slider is displayed in Kelvin, but the
// gain math above (wbShiftToGains) and the GPU uniform layout stay in their
// existing [-1, 1] shift space. Not a physically accurate color-temperature
// model.
export function kelvinToShift(kelvin: number): number {
  return (kelvin - WB_NEUTRAL_KELVIN) / WB_KELVIN_HALF_RANGE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `13 passed`

- [ ] **Step 5: Remove the now-duplicated definitions from `main.ts` and import from `uniforms.ts` instead**

In `src/main.ts`, delete these lines:

```ts
const WB_NEUTRAL_KELVIN = 5500;
const WB_KELVIN_HALF_RANGE = 3500;

function kelvinToShift(kelvin: number): number {
  return (kelvin - WB_NEUTRAL_KELVIN) / WB_KELVIN_HALF_RANGE;
}
```

Change the import line:

```ts
import type { AdjustState } from './gpu/uniforms';
```

to:

```ts
import { kelvinToShift, WB_NEUTRAL_KELVIN, type AdjustState } from './gpu/uniforms';
```

- [ ] **Step 6: Type-check and run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, `13 passed`

- [ ] **Step 7: Commit**

```bash
git add src/gpu/uniforms.ts src/gpu/uniforms.test.ts src/main.ts
git commit -m "refactor: move Kelvin/shift conversion into gpu/uniforms.ts"
```

---

## Task 3: Catalog types & Op guards

**Files:**
- Create: `src/catalog/types.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/types.ts`:

```ts
export interface FolderRecord {
  id: number;
  handle: FileSystemDirectoryHandle;
  name: string;
  addedAt: number;
}

export interface FileRecord {
  id: number;
  folderId: number;
  path: string; // relative to the folder root, e.g. "day1/img001.cr3"
  name: string;
  handle: FileSystemFileHandle;
  size: number;
  lastModified: number;
}

export type Op =
  | { kind: 'exposure'; ev: number }
  | { kind: 'whiteBalance'; kelvin: number };
  // future op kinds (crop, curve, ...) extend this union.

export function isExposureOp(op: Op): op is { kind: 'exposure'; ev: number } {
  return op.kind === 'exposure';
}

export function isWhiteBalanceOp(op: Op): op is { kind: 'whiteBalance'; kelvin: number } {
  return op.kind === 'whiteBalance';
}

export interface EditState {
  history: Op[][]; // one snapshot per commit, oldest first
  cursor: number;  // current state = history[cursor]
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/types.ts
git commit -m "feat: add catalog types (FolderRecord, FileRecord, Op, EditState)"
```

---

## Task 4: Pure edit-history reducer

**Files:**
- Create: `src/catalog/editHistory.ts`, `src/catalog/editHistory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/catalog/editHistory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createEditState, commitEdit, undo, redo, currentOps, MAX_HISTORY } from './editHistory';
import type { Op } from './types';

const exposure = (ev: number): Op[] => [{ kind: 'exposure', ev }];

describe('createEditState', () => {
  it('starts with one empty snapshot at cursor 0', () => {
    const state = createEditState();
    expect(state.history).toEqual([[]]);
    expect(state.cursor).toBe(0);
    expect(currentOps(state)).toEqual([]);
  });
});

describe('commitEdit', () => {
  it('appends a snapshot and moves the cursor to it', () => {
    const state = commitEdit(createEditState(), exposure(1));
    expect(state.history).toEqual([[], exposure(1)]);
    expect(state.cursor).toBe(1);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('drops the redo branch when committing after an undo', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = commitEdit(state, exposure(2));
    state = undo(state); // back to exposure(1)
    state = commitEdit(state, exposure(3));
    expect(state.history).toEqual([[], exposure(1), exposure(3)]);
    expect(state.cursor).toBe(2);
  });

  it('caps history at MAX_HISTORY entries, dropping the oldest', () => {
    let state = createEditState();
    for (let i = 1; i <= MAX_HISTORY + 10; i++) {
      state = commitEdit(state, exposure(i));
    }
    expect(state.history.length).toBe(MAX_HISTORY);
    expect(state.cursor).toBe(MAX_HISTORY - 1);
    expect(currentOps(state)).toEqual(exposure(MAX_HISTORY + 10));
    expect(state.history[0]).toEqual(exposure(11));
  });
});

describe('undo/redo', () => {
  it('undo moves the cursor back one snapshot', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = commitEdit(state, exposure(2));
    state = undo(state);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('undo at the oldest snapshot is a no-op', () => {
    const state = createEditState();
    expect(undo(state)).toEqual(state);
  });

  it('redo moves the cursor forward one snapshot', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = undo(state);
    state = redo(state);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('redo at the newest snapshot is a no-op', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    expect(redo(state)).toEqual(state);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './editHistory'`

- [ ] **Step 3: Implement**

Create `src/catalog/editHistory.ts`:

```ts
import type { Op, EditState } from './types';

export const MAX_HISTORY = 50;

export function createEditState(): EditState {
  return { history: [[]], cursor: 0 };
}

export function currentOps(state: EditState): Op[] {
  return state.history[state.cursor];
}

export function commitEdit(state: EditState, ops: Op[]): EditState {
  const truncated = state.history.slice(0, state.cursor + 1); // drop any redo branch
  const history = [...truncated, ops];
  const overflow = history.length - MAX_HISTORY;
  const trimmed = overflow > 0 ? history.slice(overflow) : history;
  return { history: trimmed, cursor: trimmed.length - 1 };
}

export function undo(state: EditState): EditState {
  if (state.cursor === 0) return state;
  return { ...state, cursor: state.cursor - 1 };
}

export function redo(state: EditState): EditState {
  if (state.cursor === state.history.length - 1) return state;
  return { ...state, cursor: state.cursor + 1 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `21 passed`

- [ ] **Step 5: Commit**

```bash
git add src/catalog/editHistory.ts src/catalog/editHistory.test.ts
git commit -m "feat: add pure undo/redo edit-history reducer"
```

---

## Task 5: Pure path-prefix-range helper

Answers "how do we query files under a given folder" without a closure table — IndexedDB has no joins, so a closure table (one row per ancestor/descendant pair) would add write cost with no payoff. A prefix range on the stored `path` string does the same job in one query.

**Files:**
- Create: `src/catalog/paths.ts`, `src/catalog/paths.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/catalog/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pathPrefixRange } from './paths';

describe('pathPrefixRange', () => {
  it('returns the prefix as the lower bound and prefix+\\uffff as the upper bound', () => {
    expect(pathPrefixRange('day1/')).toEqual({ lower: 'day1/', upper: 'day1/￿' });
  });

  it('excludes a sibling folder whose name starts with the same characters', () => {
    const { upper } = pathPrefixRange('day1/');
    expect('day10/photo.cr3' > upper).toBe(true);
  });

  it('matches every path when the prefix is empty', () => {
    const { lower, upper } = pathPrefixRange('');
    expect('anything.cr3' >= lower && 'anything.cr3' < upper).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './paths'`

- [ ] **Step 3: Implement**

Create `src/catalog/paths.ts`:

```ts
export interface PathRange {
  lower: string;
  upper: string;
}

// Bounds for an IDBKeyRange matching every path starting with `prefix` --
// e.g. prefix "day1/" matches "day1/a.cr3" and "day1/sub/b.cr3" but not
// "day10/a.cr3". '￿' is the highest UTF-16 code unit IndexedDB will
// compare against, so appending it to the prefix gives an upper bound
// above every string that starts with that prefix.
export function pathPrefixRange(prefix: string): PathRange {
  return { lower: prefix, upper: `${prefix}￿` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `24 passed`

- [ ] **Step 5: Commit**

```bash
git add src/catalog/paths.ts src/catalog/paths.test.ts
git commit -m "feat: add path-prefix-range helper for folder queries"
```

---

## Task 6: `Op[] -> AdjustState` mapping

**Files:**
- Create: `src/catalog/adjust.ts`, `src/catalog/adjust.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/catalog/adjust.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { opsToAdjustState } from './adjust';
import { WB_NEUTRAL_KELVIN } from '../gpu/uniforms';

describe('opsToAdjustState', () => {
  it('defaults to neutral when there are no ops', () => {
    expect(opsToAdjustState([])).toEqual({ exposureEV: 0, wbShift: 0 });
  });

  it('reads exposureEV from the exposure op', () => {
    const state = opsToAdjustState([{ kind: 'exposure', ev: 1.5 }]);
    expect(state.exposureEV).toBe(1.5);
    expect(state.wbShift).toBe(0);
  });

  it('converts the whiteBalance op kelvin to a shift', () => {
    const state = opsToAdjustState([{ kind: 'whiteBalance', kelvin: 9000 }]);
    expect(state.exposureEV).toBe(0);
    expect(state.wbShift).toBeCloseTo(1);
  });

  it('reads both ops together, independent of array order', () => {
    const state = opsToAdjustState([
      { kind: 'whiteBalance', kelvin: WB_NEUTRAL_KELVIN },
      { kind: 'exposure', ev: -2 },
    ]);
    expect(state).toEqual({ exposureEV: -2, wbShift: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './adjust'`

- [ ] **Step 3: Implement**

Create `src/catalog/adjust.ts`:

```ts
import { kelvinToShift, type AdjustState } from '../gpu/uniforms';
import { isExposureOp, isWhiteBalanceOp, type Op } from './types';

export function opsToAdjustState(ops: Op[]): AdjustState {
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  return {
    exposureEV: exposureOp?.ev ?? 0,
    wbShift: wbOp ? kelvinToShift(wbOp.kelvin) : 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `28 passed`

- [ ] **Step 5: Commit**

```bash
git add src/catalog/adjust.ts src/catalog/adjust.test.ts
git commit -m "feat: add Op[] -> AdjustState mapping"
```

---

## Task 7: IndexedDB schema

No automated test — `indexedDB` isn't available outside a browser and isn't worth polyfilling here (per spec §6). Verified manually in Task 14.

**Files:**
- Create: `src/catalog/db.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/db.ts`:

```ts
const DB_NAME = 'candela-catalog';
const DB_VERSION = 1;

export function openCatalogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      const folders = db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
      folders.createIndex('name', 'name');

      const files = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
      files.createIndex('folderId', 'folderId');
      files.createIndex('folderPath', ['folderId', 'path']);

      db.createObjectStore('edits', { keyPath: 'fileId' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/db.ts
git commit -m "feat: add IndexedDB schema (folders, files, edits)"
```

---

## Task 8: Catalog query functions

**Files:**
- Create: `src/catalog/query.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/query.ts`:

```ts
import type { FolderRecord, FileRecord } from './types';
import { pathPrefixRange } from './paths';

export function listFolders(db: IDBDatabase): Promise<FolderRecord[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('folders', 'readonly').objectStore('folders').getAll();
    request.onsuccess = () => resolve(request.result as FolderRecord[]);
    request.onerror = () => reject(request.error);
  });
}

// Lists files under `folderId`, optionally restricted to paths starting
// with `pathPrefix` (empty string = every file in the folder).
export function listFiles(db: IDBDatabase, folderId: number, pathPrefix = ''): Promise<FileRecord[]> {
  const { lower, upper } = pathPrefixRange(pathPrefix);
  const range = IDBKeyRange.bound([folderId, lower], [folderId, upper]);
  return new Promise((resolve, reject) => {
    const request = db
      .transaction('files', 'readonly')
      .objectStore('files')
      .index('folderPath')
      .getAll(range);
    request.onsuccess = () => resolve(request.result as FileRecord[]);
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/query.ts
git commit -m "feat: add catalog query functions (listFolders, listFiles)"
```

---

## Task 9: Permission helper

Both `FileSystemFileHandle` and `FileSystemDirectoryHandle` implement `FileSystemHandle`'s permission methods, so one function covers both.

**Files:**
- Create: `src/catalog/permissions.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/permissions.ts`:

```ts
// Works for both FileSystemFileHandle and FileSystemDirectoryHandle.
// requestPermission() requires an active user gesture (e.g. this being
// called from a click handler) -- calling it outside one will reject or
// silently stay at 'prompt' depending on the browser.
export async function ensureReadPermission(handle: FileSystemHandle): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/permissions.ts
git commit -m "feat: add lazy read-permission helper"
```

---

## Task 10: Recursive folder import

**Files:**
- Create: `src/catalog/import.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/import.ts`:

```ts
import type { FolderRecord, FileRecord } from './types';
import { listFolders } from './query';

const RAW_EXTENSIONS = ['.dng', '.nef', '.cr3', '.arw', '.raf'];

function isRawFile(name: string): boolean {
  const lower = name.toLowerCase();
  return RAW_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const [name, entry] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      yield* walk(entry, path);
    } else if (isRawFile(name)) {
      yield { path, handle: entry };
    }
  }
}

// Folder identity has no stable string key across separate
// showDirectoryPicker() calls -- isSameEntry() is the only reliable way to
// tell "this is the same folder picked before" from "a different folder
// that happens to share a name".
async function findExistingFolder(
  db: IDBDatabase,
  handle: FileSystemDirectoryHandle,
): Promise<FolderRecord | undefined> {
  for (const folder of await listFolders(db)) {
    if (await handle.isSameEntry(folder.handle)) return folder;
  }
  return undefined;
}

function addFolder(db: IDBDatabase, handle: FileSystemDirectoryHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('folders', 'readwrite').objectStore('folders').add({
      handle,
      name: handle.name,
      addedAt: Date.now(),
    });
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
  });
}

async function upsertFolder(db: IDBDatabase, handle: FileSystemDirectoryHandle): Promise<number> {
  const existing = await findExistingFolder(db, handle);
  return existing ? existing.id : addFolder(db, handle);
}

async function upsertFile(
  db: IDBDatabase,
  folderId: number,
  path: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  const file = await handle.getFile();
  const data: Omit<FileRecord, 'id'> = {
    folderId,
    path,
    name: file.name,
    handle,
    size: file.size,
    lastModified: file.lastModified,
  };
  return new Promise((resolve, reject) => {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    const existing = store.index('folderPath').get([folderId, path]);
    existing.onsuccess = () => {
      const record = existing.result as FileRecord | undefined;
      const putRequest = record ? store.put({ ...data, id: record.id }) : store.add(data);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    existing.onerror = () => reject(existing.error);
  });
}

// Opens the browser's folder picker, recursively finds every raw file
// under it, and upserts the folder + its files into the catalog.
export async function importFolder(db: IDBDatabase): Promise<void> {
  const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  const folderId = await upsertFolder(db, dirHandle);
  for await (const { path, handle } of walk(dirHandle, '')) {
    await upsertFile(db, folderId, path, handle);
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/import.ts
git commit -m "feat: add recursive folder import with upsert dedup"
```

---

## Task 11: Edit-state persistence (IndexedDB I/O)

**Files:**
- Create: `src/catalog/editsStore.ts`

- [ ] **Step 1: Implement**

Create `src/catalog/editsStore.ts`:

```ts
import type { EditState } from './types';
import { createEditState } from './editHistory';

interface EditRow {
  fileId: number;
  history: EditState['history'];
  cursor: number;
}

export function loadEditState(db: IDBDatabase, fileId: number): Promise<EditState> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('edits', 'readonly').objectStore('edits').get(fileId);
    request.onsuccess = () => {
      const row = request.result as EditRow | undefined;
      resolve(row ? { history: row.history, cursor: row.cursor } : createEditState());
    };
    request.onerror = () => reject(request.error);
  });
}

export function saveEditState(db: IDBDatabase, fileId: number, state: EditState): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: EditRow = { fileId, history: state.history, cursor: state.cursor };
    const request = db.transaction('edits', 'readwrite').objectStore('edits').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/catalog/editsStore.ts
git commit -m "feat: persist edit history per file in IndexedDB"
```

---

## Task 12: Catalog UI markup

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the file input with a folder-import button and catalog list**

In `index.html`, replace:

```html
      <label for="file">Raw file</label>
      <input type="file" id="file" accept=".dng,.nef,.cr3,.arw,.raf" />
```

with:

```html
      <button id="add-folder">Add folder</button>
      <ul id="catalog-list"></ul>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: replace single-file picker with catalog UI markup"
```

---

## Task 13: Wire it all together in `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Replace `src/main.ts` in full**

```ts
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
import { isExposureOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord } from './catalog/types';

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const catalogList = document.querySelector<HTMLUListElement>('#catalog-list')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;

function showError(message: string): void {
  errorEl.textContent = message;
}

function clearError(): void {
  errorEl.textContent = '';
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

// Interactive listeners are attached only after init() succeeds -- same
// boundary the spike used for Pipeline.create(), extended to also cover
// opening the catalog database, so neither failure mode can leave a
// half-wired UI behind.
async function init(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openCatalogDb();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to open the catalog database.');
    addFolderButton.disabled = true;
    return;
  }

  let pipeline: Pipeline;
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'WebGPU is not available.');
    addFolderButton.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
    return;
  }

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;

  function renderOps(ops: Op[]): void {
    pipeline.render(opsToAdjustState(ops));
  }

  async function renderCatalog(): Promise<void> {
    catalogList.textContent = '';
    const folders = await listFolders(db);
    for (const folder of folders) {
      const folderItem = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = folder.name;
      folderItem.appendChild(heading);

      const fileList = document.createElement('ul');
      const files = await listFiles(db, folder.id);
      for (const file of files) {
        const fileItem = document.createElement('li');
        fileItem.textContent = `${file.path} (${file.size} bytes)`;
        fileItem.addEventListener('click', () => openFile(file));
        fileList.appendChild(fileItem);
      }
      folderItem.appendChild(fileList);
      catalogList.appendChild(folderItem);
    }
  }

  async function openFile(record: FileRecord): Promise<void> {
    clearError();
    // requestPermission() (inside ensureReadPermission) needs a user
    // gesture -- this click handler is that gesture, so permission is
    // requested lazily here rather than via a separate reauth button.
    if (!(await ensureReadPermission(record.handle))) {
      showError(`Permission needed to read "${record.name}" -- click it again to retry.`);
      return;
    }
    try {
      const start = performance.now();
      const file = await record.handle.getFile();
      const decoded = await decode(await file.arrayBuffer());
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      pipeline.load(decoded);
      await pipeline.waitForGPU();
      const elapsed = performance.now() - start;
      console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);

      currentFileId = record.id;
      currentEditState = await loadEditState(db, record.id);
      const ops = currentOps(currentEditState);
      applyOpsToSliders(ops);
      renderOps(ops);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError(`Couldn't read this file (LibRaw error ${err.code}).`);
      } else {
        showError(err instanceof Error ? err.message : 'Failed to open file.');
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
    await saveEditState(db, currentFileId, currentEditState);
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
    await saveEditState(db, currentFileId, currentEditState);
    const ops = currentOps(currentEditState);
    applyOpsToSliders(ops);
    renderOps(ops);
  });

  addFolderButton.addEventListener('click', async () => {
    await importFolder(db);
    await renderCatalog();
  });

  await renderCatalog();
}

init();
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run the full test suite (nothing here should have broken pure-logic tests)**

Run: `npm test`
Expected: `28 passed`

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire catalog, op graph, and undo/redo into main.ts"
```

---

## Task 14: Manual end-to-end verification

Not automatable — needs a real folder of raw files, a real browser, and a real reload. Use `npm run dev`.

**Files:** none (verification only)

- [ ] **Step 1: Import a folder**

Run `npm run dev`, open in Chrome. Click "Add folder", pick a folder containing at least one subfolder with raw files in it (to exercise the recursive walk). Confirm every raw file appears in the list, grouped under its folder, including ones in subfolders.

- [ ] **Step 2: Open a file and edit it**

Click a file. Confirm it decodes and renders (same as the spike). Drag the exposure and WB sliders; confirm the image updates live.

- [ ] **Step 3: Undo/redo**

Press Ctrl+Z (Cmd+Z on macOS) after a few slider commits (release the drag between each, so each drag is one commit). Confirm the sliders and image step back through prior values. Press Ctrl+Shift+Z to redo forward again.

- [ ] **Step 4: Persistence across reload**

Reload the page. Click "Add folder" is not needed -- confirm the previously imported folder(s) and files still appear (loaded from IndexedDB, not re-imported). Open the same file again; confirm the slider values match wherever you left them (not neutral). Press Ctrl+Z; confirm undo history also survived the reload.

- [ ] **Step 5: Permission reauthorization**

After the reload in Step 4, if Chrome dropped read permission for the folder (varies by Chrome version/profile settings), clicking a file should show the "Permission needed... click it again to retry" message on the first click, then open normally on the second click (the click that shows a browser permission prompt).

- [ ] **Step 6: Re-import the same folder**

Click "Add folder" again and pick the exact same folder. Confirm the catalog list does not show duplicate entries for it.

- [ ] **Step 7: Record results**

Note the outcome of Steps 1-6 (pass/fail, and Chrome version tested) as a short addition to this plan file's bottom, or mention it back in conversation -- whichever the user prefers.

---

## Self-Review Notes

- **Spec coverage:** §1 schema → Task 7. §2 op graph/undo model → Tasks 3, 4, 6 (with the `EditState` simplification noted in the header). §3 import/permissions → Tasks 9, 10. §4 catalog UI → Tasks 12, 13. §5 error handling → Task 13 (db-open failure, permission-denied, `DecodeError`, generic catch). §6 testing → Tasks 4, 5, 6 unit-test the pure logic; Tasks 7-11 are manually verified in Task 14, matching the spec's stated testing boundary.
- **Type consistency checked:** `EditState`/`Op`/`FolderRecord`/`FileRecord` defined once in Task 3 and imported everywhere else. `currentOps`, `commitEdit`, `undo`, `redo` signatures (Task 4) match their call sites in Task 13. `opsToAdjustState` (Task 6) matches how Task 13 calls it inside `renderOps`. The `folderPath` compound index name is consistent across Task 7 (`db.ts`), Task 8 (`query.ts`), and Task 10 (`import.ts`).
