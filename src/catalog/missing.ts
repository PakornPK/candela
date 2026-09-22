// Missing-file detection, badge state and relink (gap P0-3).
// The target user keeps RAW files on external drives and reorganizes folders
// in Finder, so a stored FileSystemFileHandle regularly stops resolving.
// Lightroom Classic's answer is the `!` badge, 'Find All Missing Photos', and
// a Locate dialog whose 'find nearby missing photos' relinks a whole folder
// from one repair (https://helpx.adobe.com/lightroom-classic/help/locate-missing-photos.html).
// The edits survive a relink in LrC because they live in the catalog record,
// not the file — Candela already has that property (edits are a separate IDB
// store keyed by fileId), so this module adds only the *visibility* (badge)
// and the *repair* (relink), and every write here must preserve the rest of
// the row so a repair never eats a rating, flag, label, keyword or edit.

import type { FileRecord } from './types';

export type MissingReason = 'notfound' | 'denied' | 'unreadable';

export interface ProbeResult {
  ok: boolean;
  reason?: MissingReason;
}

export interface RelinkResult {
  ok: boolean;
  /** Human-readable failure copy, ready for a toast. Never throw at callers:
   * relink runs inside a user-gesture handler and a throw there is invisible. */
  error?: string;
}

export interface RelinkBatch {
  relinked: number;
  stillMissing: FileRecord[];
}

export interface RelinkSummary {
  relinked: number;
  stillMissing: number;
}

/** fileId -> the directory entry name that claims it. */
export type MatchMap = Map<number, string>;

// Classify a handle.getFile()/read failure. The three-way split matters:
// 'denied' is NOT a missing file, it is a lost permission grant, and the
// restore-access banner (main.ts's restoreBanner wiring, backed by
// permissions.ts) owns that case. A reload revokes every File System Access
// grant, so treating NotAllowedError as missing would paint the WHOLE catalog
// broken after one F5. Only 'notfound'/'unreadable' may set `missing`.
// Duck-typed on `.name` rather than `instanceof DOMException`: cross-realm
// exceptions and DOMException subclasses both carry the right name, and
// anything nameless falls through to 'unreadable'.
export function classifyHandleError(err: unknown): MissingReason {
  const name =
    typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'NotFoundError') return 'notfound'; // moved, renamed, or the volume went away
  if (name === 'NotAllowedError') return 'denied'; // permission problem — the banner's job
  return 'unreadable'; // disk offline mid-read, I/O error, anything exotic
}

// Try to actually read through a stored handle. Never throws — the caller
// decides what a failure means (badge it, retry it, or hand 'denied' to the
// restore banner).
export async function probeFileHandle(handle: FileSystemFileHandle): Promise<ProbeResult> {
  try {
    await handle.getFile();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classifyHandleError(err) };
  }
}

function relinkErrorText(reason: MissingReason): string {
  switch (reason) {
    case 'notfound':
      return 'That file could not be opened — it may have moved again. Pick the photo file itself, not a folder.';
    case 'denied':
      return 'Candela does not have permission to read the file you picked.';
    case 'unreadable':
      return 'Could not read the file you picked — check that its disk is online.';
  }
}

// get-merge-put in ONE readwrite transaction, mirroring setCull
// (src/catalog/culling.ts): the store lock spans get→put, so a rating/flag/
// colour/keywords written by a concurrent keypress is read back into `record`
// or lands after this transaction — it can never be clobbered by a blind put
// of a patch. `missing: false` DELETES the key instead of storing false: an
// absent key is the normal state (see the FileRecord comment in types.ts),
// so rows stay lean and `record.missing` reads never distinguish false from
// never-set for no reason.
export function markMissing(
  db: IDBDatabase,
  fileId: number,
  missing: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    const request = store.get(fileId);
    request.onsuccess = () => {
      const record = request.result as FileRecord | undefined;
      if (!record) {
        reject(new Error(`File ${fileId} not in catalog`));
        return;
      }
      const merged: FileRecord = { ...record };
      if (missing) merged.missing = true;
      else delete merged.missing;
      const put = store.put(merged);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// Internal relink; the two public entry points differ only in how they get
// `path`. Returns the saved row so callers can push it onto the in-memory
// records the grid renders from (same reason applyCullResult exists).
// `newPath` is the walked relative path when the directory batch knows it;
// for a lone Locate pick a handle cannot reveal its absolute path (web
// security), so `file.name` is the only truthful refresh of `path` — the
// photo is then treated as living at the folder root, which beats keeping a
// stale subpath that points at where the file used to be.
async function applyRelink(
  db: IDBDatabase,
  fileId: number,
  newHandle: FileSystemFileHandle,
  newPath?: string,
): Promise<RelinkResult & { saved?: FileRecord }> {
  let file: File;
  try {
    file = await newHandle.getFile();
  } catch (err) {
    return { ok: false, error: relinkErrorText(classifyHandleError(err)) };
  }
  return new Promise((resolve) => {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    const request = store.get(fileId);
    request.onsuccess = () => {
      const record = request.result as FileRecord | undefined;
      if (!record) {
        resolve({ ok: false, error: 'That photo is no longer in the catalog.' });
        return;
      }
      // Spread-first merge: everything the row carries (rating/flag/color/
      // keywords/EXIF) survives untouched, the identity fields follow the new
      // file, and `missing` goes back to absent. The `edits` store is keyed
      // by fileId, which does not change — the look comes back on its own.
      const merged: FileRecord = {
        ...record,
        handle: newHandle,
        path: newPath ?? file.name,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      };
      delete merged.missing;
      const put = store.put(merged);
      put.onsuccess = () => resolve({ ok: true, saved: merged });
      put.onerror = () => resolve({ ok: false, error: 'The catalog could not be updated.' });
    };
    request.onerror = () => resolve({ ok: false, error: 'The catalog could not be read.' });
  });
}

// Push a saved relink row onto the in-memory record. Object.assign alone
// would leave a stale `missing: true` behind (the key is deleted, not
// written false — see markMissing), exactly the bug applyCullResult
// documents for cleared ratings.
function syncRecordFrom(target: FileRecord, saved: FileRecord): void {
  Object.assign(target, saved);
  if (!('missing' in saved)) delete target.missing;
}

// Locate one photo (LrC's per-file Locate dialog). Never throws; failures
// come back as display-ready copy.
export async function relinkFile(
  db: IDBDatabase,
  fileId: number,
  newHandle: FileSystemFileHandle,
): Promise<RelinkResult> {
  return applyRelink(db, fileId, newHandle);
}

// Recursive file listing for the directory relink. Local on purpose:
// import.ts's walk() filters to known image extensions, and importing a
// shared walker would either force that filter onto relink (a relink can
// legitimately point at a file whose extension the user changed) or mean
// editing a file this task does not own. The File System Access API does not
// follow symlinks, so recursion is bounded by the real tree depth.
async function* walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') yield* walkFiles(entry, path);
    else yield { path, handle: entry };
  }
}

// The pure matching rule behind relinkFromDirectory, extracted so it is
// unit-testable without a filesystem:
// - compare the FULL basename (name incl. extension), case-insensitively —
//   case-insensitivity matches how exFAT/APFS/NTFS resolve names and how LrC
//   matches; including the extension is what stops a .RAF from ever claiming
//   its .jpg sibling, which is a different file (embedded JPEG vs RAW).
// - first match wins: `missing` is iterated in caller order and an entry,
//   once claimed, cannot be claimed again. If two catalog rows legitimately
//   share a name (two subfolders, one picked as the relink source), the
//   earlier row gets the entry and the later one stays missing for the user
//   to Locate by hand — silently cross-relinking would be worse.
export function matchByBasename(missing: FileRecord[], entryNames: string[]): MatchMap {
  const map: MatchMap = new Map();
  const claimed = new Set<string>();
  for (const record of missing) {
    const want = record.name.toLowerCase();
    for (const entry of entryNames) {
      const lower = entry.toLowerCase();
      if (lower !== want || claimed.has(lower)) continue;
      claimed.add(lower);
      map.set(record.id, entry);
      break;
    }
  }
  return map;
}

// LrC's 'Find nearby missing photos': point at the folder the files were
// moved to and every basename match is relinked in one pass. Successful
// records are updated in place (syncRecordFrom) so the grid stops badging
// them without a catalog refetch; failures are returned untouched.
export async function relinkFromDirectory(
  db: IDBDatabase,
  missingFiles: FileRecord[],
  dirHandle: FileSystemDirectoryHandle,
): Promise<RelinkBatch> {
  const byLowerName = new Map<string, { path: string; handle: FileSystemFileHandle }>();
  const entryNames: string[] = [];
  for await (const found of walkFiles(dirHandle, '')) {
    const lower = found.handle.name.toLowerCase();
    // First occurrence wins, mirroring matchByBasename's first-match rule
    // when the same name exists in two subfolders of the picked tree.
    if (!byLowerName.has(lower)) {
      byLowerName.set(lower, found);
      entryNames.push(found.handle.name);
    }
  }
  const matches = matchByBasename(missingFiles, entryNames);
  let relinked = 0;
  const stillMissing: FileRecord[] = [];
  for (const record of missingFiles) {
    const entryName = matches.get(record.id);
    const found = entryName ? byLowerName.get(entryName.toLowerCase()) : undefined;
    if (!found) {
      stillMissing.push(record);
      continue;
    }
    const result = await applyRelink(db, record.id, found.handle, found.path);
    if (result.ok && result.saved) {
      syncRecordFrom(record, result.saved);
      relinked++;
    } else {
      stillMissing.push(record);
    }
  }
  return { relinked, stillMissing };
}

// One copy of the badge text so the grid cell, the filmstrip cell and any
// future hover layer can never disagree (user data goes in via textContent
// / title assignment only — never innerHTML).
export function missingBadgeTitle(name: string): string {
  return `${name} is missing — its edits are safe; relink the file to render it again.`;
}

// Paint/erase the `!` badge on every catalog/filmstrip cell under `root`
// whose data-file-id appears in `records`. Idempotent (re-running with the
// same state is a no-op) and purely additive to the DOM: the badge is its
// own child span so the cell's thumbnail <img> and star row are never
// touched. Cells whose id is not in `records` are left alone — `records` is
// the visible slice the caller rendered, and clearing a badge we have no
// opinion about would fight another view sharing the document.
export function applyMissingBadges(records: FileRecord[], root: ParentNode): void {
  const missing = new Map<number, string>();
  const known = new Set<number>();
  for (const record of records) {
    known.add(record.id);
    if (record.missing === true) missing.set(record.id, record.name);
  }
  const cells = root.querySelectorAll<HTMLElement>(
    '.catalog-cell[data-file-id], .filmstrip-cell[data-file-id]',
  );
  for (const cell of cells) {
    const id = Number(cell.dataset.fileId);
    if (!missing.has(id)) {
      // Present-but-not-missing: erase a badge from a relink or a cleared
      // flag. Absent-from-records: no opinion, leave it.
      if (known.has(id)) cell.querySelector(':scope > .cell-missing')?.remove();
      continue;
    }
    let badge = cell.querySelector<HTMLElement>(':scope > .cell-missing');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'cell-missing';
      badge.textContent = '!';
      cell.appendChild(badge);
    }
    badge.title = missingBadgeTitle(missing.get(id) ?? '');
  }
}

// The Locate flow's decision core. `pick` is INJECTED — main.ts binds it to
// showOpenFilePicker / showDirectoryPicker with its own options, because the
// native picker must be called synchronously from a user gesture and this
// module must stay testable without one. The returned handle's `kind` picks
// the path: a file relinks the single photo (LrC's Locate dialog), a
// directory runs the batch repair (LrC's 'find nearby missing photos').
// A null pick (dialog cancelled) is a no-op, not a failure.
export async function promptRelink(
  missingFiles: FileRecord[],
  pick: () => Promise<FileSystemHandle | null>,
  db: IDBDatabase,
): Promise<RelinkSummary> {
  if (missingFiles.length === 0) return { relinked: 0, stillMissing: 0 };
  const handle = await pick();
  if (!handle) return { relinked: 0, stillMissing: missingFiles.length };
  // `pick`'s contract is the base FileSystemHandle, so TS has no discriminated
  // union to narrow; the picker APIs themselves hand out exactly these two
  // concrete kinds, so asserting the union back restores proper narrowing.
  const chosen = handle as FileSystemFileHandle | FileSystemDirectoryHandle;
  if (chosen.kind === 'directory') {
    const batch = await relinkFromDirectory(db, missingFiles, chosen);
    return { relinked: batch.relinked, stillMissing: batch.stillMissing.length };
  }
  // Single-file path: one handle can only be one photo. Callers locate ONE
  // photo at a time here (pass a one-element array); if handed more, only
  // the first is repaired and the rest report back as still missing.
  const [first, ...rest] = missingFiles;
  const result = await applyRelink(db, first.id, chosen);
  if (result.ok && result.saved) syncRecordFrom(first, result.saved);
  const relinked = result.ok ? 1 : 0;
  return { relinked, stillMissing: rest.length + (result.ok ? 0 : 1) };
}
