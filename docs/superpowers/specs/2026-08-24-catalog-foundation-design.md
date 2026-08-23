# Catalog Foundation — Design

**Date:** 2026-08-24
**Scope:** First post-spike sub-project. Adds a persistent catalog (recursive folder import via the File System Access API, IndexedDB-backed) and a composable, undoable op graph for edits — replacing the spike's single-file picker as the only way to open an image.

**Deviation from [`CLAUDE.md`](../../../CLAUDE.md)'s stated "after the spike" order:** the brief lists composable op graph (1) before catalog/thumbnail cache (2). This spec does both together, catalog-first, because the op graph's undo/redo needs a stable per-file identity to persist against — and the catalog is what provides that identity. Building op graph persistence before catalog would mean building it twice. Explicit user decision, not an oversight.

Thumbnail generation (rendering a preview image per file) is **not** part of this sub-project — the catalog list is text-only (filename, path, size). Per brief, thumbnail cache is "tedious work" called out as its own concern.

## 1. IndexedDB schema

One database, `candela-catalog`, three object stores:

```ts
// folders: one row per imported root folder
{
  id: number;          // auto-increment key
  handle: FileSystemDirectoryHandle;  // structured-cloneable, stored directly
  name: string;
  addedAt: number;
}

// files: one row per raw file found under any folder
{
  id: number;           // auto-increment key
  folderId: number;
  path: string;         // full relative path from the folder root, e.g. "day1/img001.cr3"
  name: string;
  handle: FileSystemFileHandle;
  size: number;
  lastModified: number;
}
// index on `path` (per folderId) — enables prefix range queries for
// "all files under subfolder X" via IDBKeyRange.bound(prefix, prefix + '￿'),
// which is what a closure table would otherwise be used for. IndexedDB has
// no joins, so a closure table would add write amplification (one row per
// ancestor/descendant pair) without the payoff a JOIN normally gives it.

// edits: one row per file, its op graph
{
  fileId: number;       // keyPath, 1:1 with files.id
  history: Op[][];      // snapshots of the full op list, oldest first
  cursor: number;        // index into history; current state = history[cursor]
}
```

`history` is capped at 50 entries per file (drop the oldest on overflow) to bound storage growth — adjustable later if 50 proves too few in practice.

Re-importing a folder whose `path` already exists (same folder root re-selected) upserts over the existing `files`/`folders` rows rather than creating duplicates.

## 2. Op graph & undo model

```ts
type Op =
  | { kind: 'exposure'; ev: number }
  | { kind: 'whiteBalance'; kelvin: number };
  // future op kinds (crop, curve, ...) extend this union; each new kind is
  // additive here and, separately, wherever the GPU pipeline dispatches
  // per-op-kind passes — those two concerns are not coupled by this type.

interface EditState {
  ops: Op[];        // current value per active op kind
  history: Op[][];  // one snapshot per commit
  cursor: number;
}
```

- **Commit timing:** slider `input` events keep updating the live GPU render every tick (same as the spike — no change to interactivity). A slider's `change` event (fired on mouse-up / drag release) is what pushes a new snapshot onto `history` and writes it to IndexedDB. Dragging a slider for ten seconds is one undo step, not hundreds.
- **Undo/redo:** moves `cursor` within `history`, re-applies `history[cursor]` through the existing `pipeline.render()` — this still only touches the adjust+blit GPU stages (no re-demosaic, no CPU readback), same as any other slider move.
- **Persistence:** history persists across reloads and browser restarts (Approach B, explicit user choice over a session-only alternative) — reopening a file from the catalog restores its full undo stack, not just its latest value.
- **Relation to `AdjustState`/`pipeline.render()`:** the GPU pipeline's render call still takes the spike's `{ exposureEV, wbShift }` shape, unchanged. `Op[]` is the persisted/undoable representation; converting `history[cursor]` to an `AdjustState` (using the spike's existing `kelvinToShift()` for the `whiteBalance` op) is a pure mapping step that happens wherever a file is opened or an undo/redo fires — it does not replace or wrap `pipeline.render()`.

## 3. Import & permission flow

- "Add folder" button → `window.showDirectoryPicker()` → recursive walk via `handle.values()`, filtering entries by `.kind === 'directory'` (recurse) vs `.kind === 'file'` with an extension in `.dng`/`.nef`/`.cr3`/`.arw`/`.raf` → write one `folders` row for the root and one `files` row per matching file, with `path` built as the walk descends.
- **Permission re-grant (a File System Access API constraint, not a design choice):** stored handles are not guaranteed to keep read permission across browser restarts. On catalog load, call `handle.queryPermission({ mode: 'read' })` for each folder; anything not `'granted'` is shown in the UI as needing reauthorization, with a button that calls `requestPermission()` — this call requires a user gesture, so it cannot run automatically on page load.

## 4. Catalog UI

- Replaces the spike's `<input type="file">` entirely (per user decision — no dual single-file path to maintain).
- "Add folder" button + a flat list of files (name, path, size), grouped visually by folder.
- Clicking a row: `handle.getFile()` → `arrayBuffer()` → the existing `decode()` → `pipeline.load()` → `pipeline.render()` flow, unchanged from the spike.
- Before rendering, load that file's `EditState` from `edits` (if present) and use `history[cursor]` as the initial slider values instead of the neutral defaults.
- `main.ts` stays the only DOM-aware module, per the spike's boundary — catalog state management is a new module (`src/catalog/`) with a plain data API (`listFiles()`, `openFolder()`, `getEditState()`, `commitEdit()`), no DOM references inside it.

## 5. Error handling

- **`showDirectoryPicker()` unsupported or denied:** same pattern as the spike's WebGPU-unsupported path — short message in place of the catalog UI, rather than a silent no-op.
- **Permission not granted on reload:** per-folder banner in the list (see §3), not a blocking full-page error — other already-granted folders stay usable.
- **File no longer exists on disk** (deleted/moved since import): `handle.getFile()` throws; caught the same way `DecodeError` is caught today, surfaced near the file row rather than the global error area.

## 6. Testing

- Pure logic gets unit tests (Vitest), same TDD approach as the spike's `uniforms.ts`:
  - Op history reducer (`commitEdit`, `undo`, `redo`, cap-at-50 eviction) — no IndexedDB or File System Access API involved, plain array logic.
  - Path-prefix range construction for folder queries.
- `FileSystemDirectoryHandle`/`FileSystemFileHandle` and IndexedDB itself are not mockable in a way worth the effort here — verified manually in-browser (Chrome), same as the spike's GPU pipeline was.

## Out of scope (unchanged from brief unless noted above)

Thumbnail generation/cache, DCP/color profiles, masking/healing/lens correction/export presets, AI features, plugin API, UI framework. Op kinds beyond `exposure`/`whiteBalance` (the union is designed to extend, but no new kind ships in this sub-project).
