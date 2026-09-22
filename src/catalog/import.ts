import type { FolderRecord, FileRecord } from './types';
import { listFolders } from './query';
import { identify } from '../raw/decode';
import { exifToRecordFields } from '../raw/exif';
import { duplicateKeyOf, type DuplicateKey } from './duplicates';

const RAW_EXTENSIONS = ['.dng', '.nef', '.cr3', '.arw', '.raf'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp', '.heic', '.heif'];

function isRawFile(name: string): boolean {
  const lower = name.toLowerCase();
  return RAW_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isSupportedFile(name: string): boolean {
  return isRawFile(name) || isImageFile(name);
}

export function isRawFileName(name: string): boolean {
  return isRawFile(name);
}

async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const [name, entry] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      yield* walk(entry, path);
    } else if (isRawFile(name) || isImageFile(name)) {
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

// Reads the files row for (folderId, path) outside the write transaction so
// upsertFile can decide EXIF work BEFORE composing the row. IndexedDB
// requests are event objects, not promises -- wrap both callbacks (same
// shape as addFolder()).
function getFileRow(
  db: IDBDatabase,
  folderId: number,
  path: string,
): Promise<FileRecord | undefined> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction('files', 'readonly')
      .objectStore('files')
      .index('folderPath')
      .get([folderId, path]);
    request.onsuccess = () => resolve(request.result as FileRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

// True when a re-import of this file should pay for the identify() byte
// read. The expensive part of EXIF-at-import is file.arrayBuffer() -- up to
// ~58MB per Fuji RAF -- so skip it when the row already has EXIF and the
// file is unchanged on disk (same size + mtime: the only cheap change
// signal available without reading the bytes at all). Also skip non-raw
// extensions: LibRaw's open_buffer rejects plain JPEG/TIFF outright, so the
// read could never gain anything there.
//
// Known limit: a file that fails identify permanently (corrupt EXIF) re-
// pays the read on every import until a field records "no EXIF available"
// -- an accepted cost (corrupt files are the exception, and the read is
// sequential) rather than a permanent no-EXIF row for a transient wasm
// failure.
export function shouldIdentify(
  path: string,
  record: FileRecord | undefined,
  size: number,
  lastModified: number,
): boolean {
  if (!isRawFile(path)) return false;
  if (!record) return true; // new row
  if (record.size !== size || record.lastModified !== lastModified) return true; // file changed
  // Rows from pre-EXIF catalogs carry no cameraModel -- backfill once. A row
  // WITH cameraModel is either complete or genuinely lens-less; re-probing
  // per import for the latter is exactly the cost this gate exists to stop.
  return !record.cameraModel;
}

// identify() mapped onto FileRecord field names, never throwing: an EXIF
// failure must not block an import (a folder of 10,000 files still imports
// if every identify throws), so swallow IdentifyError/wasm/IO errors and
// return {} -- the row stores no EXIF keys, exactly the pre-fix behaviour.
async function exifFieldsOrEmpty(file: File): Promise<Partial<FileRecord>> {
  try {
    const exif = await identify(await file.arrayBuffer());
    return exifToRecordFields(exif);
  } catch {
    return {};
  }
}

// Composes a re-import's row: OLD record first, then the fresh file data.
// Cull marks (flag/rating/color), keywords, edits-adjacent fields and any
// EXIF the new pass did NOT re-collect (gate said "unchanged") ride along;
// size/lastModified/handle are always the live values (later spread wins).
// `id` is taken from the old record -- store.put() keys on it, matching the
// old { ...data, id: record.id } behaviour. Without the old-first spread a
// re-import silently wiped every rating: { ...data, id } kept ONLY the six
// fields listed above.
export function mergeFileRow(record: FileRecord, data: Omit<FileRecord, 'id'>): FileRecord {
  const merged: FileRecord = { ...record, ...data, id: record.id };
  // The only caller merges AFTER a successful handle.getFile(), which is
  // "a successful read" in FileRecord.missing's sense (types.ts) -- a
  // restored file must lose its stale badge, exactly like the old row-
  // replacing spread did. Key omitted (not stored false) per missing.ts's
  // lean-row convention.
  delete merged.missing;
  return merged;
}

// ---- duplicate gate (gap P1-8) -------------------------------------------
//
// LrC's "Don't Import Suspected Duplicates": a file whose name+size(+capture
// time) already lives in the catalog is skipped instead of creating a second
// row that inflates cull counts. The engine owns the key FORMAT
// (duplicates.ts — never hand-roll the string here); this gate owns only the
// "existing set + batch-so-far set" membership test, kept pure so
// import.test.ts can exercise the skip rules without IndexedDB.
//
// The batch rule mirrors findSuspectedDuplicates: a candidate that passes
// ADDS its key, so a within-batch duplicate (the same card walked twice, or
// two subfolders holding a same-named copy) is caught too.
export interface DuplicateGate {
  /** true = this candidate is a duplicate of an existing row or of an
   * earlier KEPT row of the same batch, and must not be added. */
  test(candidate: DuplicateKey): boolean;
}

export function createDuplicateGate(existingRows: readonly DuplicateKey[]): DuplicateGate {
  const seen = new Set(existingRows.map((row) => duplicateKeyOf(row)));
  return {
    test(candidate: DuplicateKey): boolean {
      const key = duplicateKeyOf(candidate);
      if (seen.has(key)) return true;
      seen.add(key); // first kept copy claims the key for later rows
      return false;
    },
  };
}

// The row->key projection readExistingKeys uses, exported so the NAME+SIZE
// rule is unit-testable: a dated existing side silently disables the whole
// gate for RAW files (incoming candidates are undated at gate time, and
// duplicates.ts never collides dated with undated keys).
export function duplicateKeyForRow(row: Pick<FileRecord, 'name' | 'size'>): DuplicateKey {
  return { name: row.name, size: row.size };
}

// One getAll over the files store mapped to duplicate keys. A full scan is
// the same cost the keyword list and missing-view already accept (see
// query.ts); it runs ONCE per import, not per file.
//
// Keys are NAME+SIZE ONLY — dateTaken is deliberately stripped. The gate
// runs BEFORE the EXIF identify (that is the whole point: a duplicate must
// never pay the 58MB byte read), so an incoming RAW candidate is ALWAYS
// undated. duplicates.ts keeps dated and undated keys in separate
// namespaces (so a future dated-vs-dated caller can never false-positive),
// and with a dated existing side that namespace split turned every RAW
// duplicate into a miss: existing row dated by its first import's EXIF,
// candidate undated, keys can never collide — the QA loop caught a second
// copy of the Fuji RAF importing as a new row. Name+size on both sides is
// the deterministic rule LrC's 'Don't Import Suspected Duplicates' applies
// in practice, and exactness still beats recall: a same-name same-size
// false positive is a re-shot frame with an identical filename AND byte
// count, which does not happen on camera-sequential names.
function readExistingKeys(db: IDBDatabase): Promise<DuplicateKey[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').getAll();
    request.onsuccess = () =>
      resolve((request.result as FileRecord[]).map(duplicateKeyForRow));
    request.onerror = () => reject(request.error);
  });
}

export interface ImportResult {
  /** Rows the walk wrote: brand-new adds plus merged re-imports (a re-added
   * folder refreshes every row it still holds — counting them as imports is
   * what "N photos" means to the user who just clicked Add Folder). */
  imported: number;
  /** Rows skipped by the duplicate gate. */
  skippedDuplicates: number;
}

async function upsertFile(
  db: IDBDatabase,
  folderId: number,
  path: string,
  handle: FileSystemFileHandle,
  gate: DuplicateGate,
): Promise<'imported' | 'duplicate'> {
  const file = await handle.getFile();
  const record = await getFileRow(db, folderId, path);

  // Duplicate gate (gap P1-8), BEFORE any EXIF byte read: a row already at
  // this exact folder+path is a MERGE (re-adding a folder refreshes rows and
  // backfills EXIF on pre-feature catalogs — never gate that). A row only
  // matched by name+size is "a second copy of a shoot": skip it.
  //
  // Both sides key on NAME+SIZE ONLY (see readExistingKeys for why: the
  // candidate is undated at gate time — identify() has not run — and the
  // engine's dated/undated namespace split would make every RAW duplicate a
  // miss against a dated existing row).
  if (!record) {
    const candidate: DuplicateKey = { name: file.name, size: file.size };
    if (gate.test(candidate)) return 'duplicate';
  } else {
    // The merge refreshes the row's identity on the live file — keep the
    // batch key-set honest for a later same-name candidate in this walk.
    gate.test({ name: file.name, size: file.size });
  }

  // EXIF at import time. The fields below (cameraModel/lensModel/dateTaken/
  // iso/focalLength) are what main.ts's search and smartCollections'
  // camera/lens/date rules already read -- before this they were never
  // written, so those features silently matched zero photos. identify() is
  // the identify-only wasm path (no Bayer unpack; a full decode per file
  // costs ~1.6s, unacceptable across a 10k-file folder).
  //
  // Byte-read gate (shouldIdentify): file.arrayBuffer() of a 58MB RAF is
  // the real cost here, so we only pay it when the row gains something --
  // raw files (LibRaw rejects plain JPEG/TIFF outright), new rows, rows
  // with no EXIF yet (includes the one-time backfill for catalogs built
  // before this feature), and rows whose file changed on disk.
  const data: Omit<FileRecord, 'id'> = {
    folderId,
    path,
    name: file.name,
    handle,
    size: file.size,
    lastModified: file.lastModified,
    ...(shouldIdentify(path, record, file.size, file.lastModified)
      ? await exifFieldsOrEmpty(file)
      : {}),
  };

  return new Promise((resolve, reject) => {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    const putRequest = record ? store.put(mergeFileRow(record, data)) : store.add(data);
    putRequest.onsuccess = () => resolve('imported' as const);
    putRequest.onerror = () => reject(putRequest.error);
  });
}

// Opens the browser's folder picker, recursively finds every raw file
// under it, and upserts the folder + its files into the catalog.
// mode 'readwrite' (not 'read'): kept for existing-catalog compatibility.
// The sidecar write-back path that motivated it was removed (Export is
// download-only), but catalogs already hold readwrite handles and a
// handle's grant mode cannot be changed after import -- downgrading the
// picker would split old and new catalogs into two permission shapes for
// no gain (the read-only escalation pain behind user report 2026-09-18:
// both sidecar buttons did nothing -- stays impossible this way).
export async function importFolder(db: IDBDatabase): Promise<ImportResult> {
  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  return importFolderFromHandle(db, dirHandle);
}

// Import from an existing directory handle (for drag & drop)
export async function importFolderFromHandle(
  db: IDBDatabase,
  dirHandle: FileSystemDirectoryHandle,
): Promise<ImportResult> {
  const folderId = await upsertFolder(db, dirHandle);
  // One pass over the files store BEFORE the walk, not one per file: the
  // gate's existing-set must cover the whole catalog (a duplicate can live
  // in any folder), and reading it per file would make import quadratic on
  // the 10k-folder catalogs this product is for.
  const gate = createDuplicateGate(await readExistingKeys(db));
  let imported = 0;
  let skippedDuplicates = 0;
  for await (const { path, handle } of walk(dirHandle, '')) {
    if ((await upsertFile(db, folderId, path, handle, gate)) === 'imported') imported++;
    else skippedDuplicates++;
  }
  return { imported, skippedDuplicates };
}

// Imports one file under a folder handle. Tethered capture uses this for
// frames arriving one at a time; the batch path above covers whole folders.
// Path is the bare file name, matching what walk() yields at the top level.
export async function importSingleFile(
  db: IDBDatabase,
  dirHandle: FileSystemDirectoryHandle,
  fileHandle: FileSystemFileHandle,
): Promise<ImportResult> {
  const folderId = await upsertFolder(db, dirHandle);
  // Same duplicate gate as the folder path (a camera writing the same frame
  // twice into the watched folder must not double the catalog). One getAll
  // per captured frame is acceptable: frames arrive seconds apart and the
  // scan is the same single pass the keyword list already makes.
  const gate = createDuplicateGate(await readExistingKeys(db));
  const outcome = await upsertFile(db, folderId, fileHandle.name, fileHandle, gate);
  return {
    imported: outcome === 'imported' ? 1 : 0,
    skippedDuplicates: outcome === 'duplicate' ? 1 : 0,
  };
}
