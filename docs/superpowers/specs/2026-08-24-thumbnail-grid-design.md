# Thumbnail Grid & Virtual Scroll — Design

**Date:** 2026-08-24
**Scope:** Continues [`CLAUDE.md`](../../../CLAUDE.md)'s post-spike roadmap item 2 ("Catalog, thumbnail cache, virtual scroll"). [`2026-08-24-catalog-foundation-design.md`](2026-08-24-catalog-foundation-design.md) shipped folder import and a text-only file list; this closes the rest — an LrC Library-style thumbnail grid with lazy, cached thumbnail extraction and virtualized rendering, replacing the text list entirely.

**Explicit goal, per user direction:** match Lightroom Classic's Library grid view as the reference model — this app's whole premise is being a fast replacement for it.

## 1. Thumbnail extraction (native, WASM)

Raw files embed a JPEG preview (used by the camera's own LCD) that LibRaw can extract directly via `unpack_thumb()`, without running demosaic. This is dramatically cheaper than the existing `decode()` path (which does full Bayer decode for editing) and is how real cataloging apps generate grid thumbnails.

New wrapper function in `native/libraw-wrapper/wrapper.cpp`, alongside the existing `decode()`:

```cpp
struct ThumbnailResult {
    uint8_t* data = nullptr;   // raw JPEG bytes, if format is JPEG
    uint32_t length = 0;
    int error_code = 0;        // 0 = success, LIBRAW_THUMBNAIL_UNSUPPORTED = thumb isn't JPEG, other = LibRaw error
};

ThumbnailResult* extract_thumbnail(const uint8_t* file_bytes, uint32_t length);
uint8_t* thumbnail_result_data_ptr(ThumbnailResult* r);
uint32_t thumbnail_result_length(ThumbnailResult* r);
int thumbnail_result_error_code(ThumbnailResult* r);
void free_thumbnail(ThumbnailResult* r);
```

`imgdata.thumbnail.tformat == LIBRAW_THUMBNAIL_JPEG` is the only case handled — the JPEG bytes (`imgdata.thumbnail.thumb`, length `imgdata.thumbnail.tlength`) are copied out and returned as-is; the browser's own JPEG decoder (via `Blob`/`<img>`/`createImageBitmap`) does the rest, no image processing needed on our side. A non-JPEG embedded thumbnail (rare — some older/unusual raw formats) returns an error code; the UI shows a placeholder cell rather than failing the whole grid.

Same RAII/bounds-checking conventions as `decode()` (Task 3/4 of the spike plan): validate `length`/`error_code` before touching output, `std::unique_ptr`/`std::span` internally, ownership crosses the JS boundary as a raw pointer freed exactly once via `free_thumbnail()`.

`src/raw/thumbnail.ts` mirrors `src/raw/decode.ts`'s existing `ccall`/`HEAPU8` marshalling pattern:

```ts
export class ThumbnailUnavailableError extends Error { constructor(public readonly code: number) { ... } }
export async function extractThumbnail(fileBytes: ArrayBuffer): Promise<Blob> // throws ThumbnailUnavailableError
```

Returns a `Blob` (`type: 'image/jpeg'`) built directly from the copied bytes.

## 2. Thumbnail persistence (IndexedDB)

New object store in `src/catalog/db.ts` (bumps `DB_VERSION` to 2 — the first schema migration since the catalog foundation shipped):

```ts
// thumbnails: one row per file that has had its thumbnail extracted
{
  fileId: number;   // keyPath, 1:1 with files.id
  blob: Blob;        // the JPEG bytes, stored directly -- IndexedDB supports Blob natively
  extractedAt: number;
}
```

`src/catalog/thumbnails.ts`:

```ts
// undefined = no row yet (never attempted); null = attempted and failed
// (negative cache); Blob = extracted successfully.
export function loadThumbnail(db: IDBDatabase, fileId: number): Promise<Blob | null | undefined>;
export function saveThumbnail(db: IDBDatabase, fileId: number, blob: Blob | null): Promise<void>;

// Checks the cache first; only calls into WASM (extractThumbnail) and persists
// on a cache miss. This is the one function the grid UI calls per cell.
export async function getOrExtractThumbnail(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  const cached = await loadThumbnail(db, record.id);
  if (cached !== undefined) return cached ?? undefined; // hit (Blob) or negative-cache (null -> undefined)
  try {
    const file = await record.handle.getFile();
    const blob = await extractThumbnail(await file.arrayBuffer());
    await saveThumbnail(db, record.id, blob);
    return blob;
  } catch {
    await saveThumbnail(db, record.id, null); // remember the failure, don't retry every scroll
    return undefined;
  }
}
```

A miss that fails extraction (non-JPEG embedded thumb, corrupt file) is not retried on every scroll -- the `null` row above means a permanently-unextractable file doesn't repeatedly hit the WASM/file-read path every time its cell scrolls back into view.

## 3. Lazy loading tied to virtual scroll

`@tanstack/virtual`'s vanilla adapter (`@tanstack/virtual-core`) reports which grid cells are currently in the rendered range (visible + overscan). The grid rendering code (§4) calls `getOrExtractThumbnail` only for cells entering that range, not for the whole catalog up front -- this is what keeps folder import (already fast, per the catalog foundation's IndexedDB-only writes) decoupled from thumbnail cost, and what keeps a 10,000-file folder from trying to decode 10,000 JPEGs at once.

This is the **first runtime dependency** this project has ever added -- `package.json`'s `dependencies` has been empty through the spike and the catalog foundation (only `devDependencies`). Explicit, deliberate choice (user preferred a proven library over hand-rolled windowing) worth flagging as a first for this codebase, not a silent scope change.

## 4. Grid UI

Replaces `renderCatalog()`'s text-list rendering in `main.ts` entirely -- the catalog is grid-only now, per user direction (no dual list/grid mode).

- Fixed-size cells (e.g. 160x160px) for this pass -- LrC's grid-density zoom slider is not built now (cheap to add later on top of `@tanstack/virtual`'s configurable item size, once the fixed-size version is working and reviewed).
- Each cell: an `<img>` populated once `getOrExtractThumbnail` resolves (a lightweight CSS placeholder -- solid background, no skeleton animation -- shown until then), filename as a `title` attribute (tooltip) rather than always-visible text, matching LrC's image-forward grid cell.
- Click behavior unchanged from the catalog foundation: opens the file via the existing `openFile()` flow.
- Folder grouping: still grouped under each imported root folder (a heading per folder above its section of the grid), matching the existing catalog structure -- `@tanstack/virtual` virtualizes within/across this grouped layout the same way it would a flat list, since it works off a total item count and an index-to-item mapping, not a specific DOM shape.

## 5. Error handling

- **Thumbnail extraction failure** (non-JPEG embedded thumb, corrupt file): cell shows a static placeholder (a generic file/broken-image icon), not an error banner -- one bad thumbnail shouldn't interrupt browsing the rest of the grid, and a per-file failure like this is exactly what the negative-cache row (§2) exists to remember instead of surfacing. The `#error` banner (per-`showError()`, plain-language message + a "See detail" `<details>` toggle with the raw technical error -- landed after the catalog foundation shipped) stays reserved for catalog-level failures (folder import, DB open), consistent with that existing boundary. Any error this feature does route through `showError()` (there currently isn't one on the happy path -- extraction failures are cell-local, not banner-worthy) follows that same friendly-message/detail-toggle shape, not a raw `err.message`.
- **IndexedDB schema migration (`DB_VERSION` 1 → 2)**: the catalog foundation's `onupgradeneeded` handler unconditionally calls `createObjectStore` for all three existing stores -- run unchanged against an existing v1 database, that throws `ConstraintError` (store already exists). The handler must branch on `event.oldVersion` (available on the `IDBVersionChangeEvent`, not just the `IDBOpenDBRequest`) so a v1→v2 upgrade only creates the new `thumbnails` store:
  ```ts
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (event.oldVersion < 1) {
      // existing folders/files/edits creation, unchanged
    }
    if (event.oldVersion < 2) {
      db.createObjectStore('thumbnails', { keyPath: 'fileId' });
    }
  };
  ```
  A brand-new database (`oldVersion === 0`) runs both blocks and ends up with all four stores in one pass, same as today's behavior for a first-time user. Existing catalogs upgrade in place, no data loss, no user-visible migration step.

## 6. Testing

None of this feature's core logic is pure in the way `editHistory.ts`/`paths.ts` were: extraction is WASM+IO, caching is IndexedDB+IO, `getOrExtractThumbnail`'s hit/miss/negative-cache branching is two `if`s wrapping those IO calls, not independently meaningful to isolate. Manually verified in-browser, consistent with the project's established testing boundary (IndexedDB/File-System-Access-API/WASM aren't mockable in this repo's Vitest setup) -- same boundary `db.ts`/`query.ts`/`import.ts`/`permissions.ts` already sit on.

## Out of scope (unchanged from prior specs unless noted above)

LrC's grid-density zoom slider, DCP/color profiles, masking/healing/lens correction/export presets, AI features, plugin API, tone curve work (roadmap item 3), any UI framework (this feature adds one runtime *library*, `@tanstack/virtual-core`, not a UI framework -- no component model, no app-level state management).
