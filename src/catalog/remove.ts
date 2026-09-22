// Remove vs Delete-from-disk (gap analysis P0-4).
//
// Culling IS the act of removing: a user who rejects 300 frames must be able
// to drop them without leaving the app, or the catalog desyncs (turning into
// the missing-file problem, P0-3). LrC's safety pattern is two clearly
// separate verbs — Remove (catalog row only, file untouched) vs Delete From
// Disk (the file goes to the OS trash) — and the two must never be conflated.
// The destructive one states exactly what it will destroy.
//
// The safety lives in the pure layer below (confirmMessage / deleteKeyVerb),
// exhaustively tested in remove.test.ts. This file has no DOM imports (the IDB
// and File System Access types come from tsconfig's `lib`), so it loads under
// vitest's node environment like every other catalog module.

export type RemoveVerb = 'remove-from-catalog' | 'delete-from-disk';

export interface ConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
  // true only for the destructive verb, so the UI styles the button red;
  // the safe verb can never accidentally borrow the destructive styling.
  destructive: boolean;
}

// Decision layer ---------------------------------------------------------
//
// LrC semantics for the Delete/Backspace key
// (https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/photos.html):
//   - inside a collection view it removes MEMBERSHIP only — no dialog;
//   - anywhere else it opens the two-verb dialog whose default is the safe
//     verb (Remove from Catalog), so an Enter-key slip never touches a file.
export type DeleteKeyOutcome = RemoveVerb | 'remove-membership';

export function deleteKeyVerb(context: { inCollection: boolean }): DeleteKeyOutcome {
  if (context.inCollection) return 'remove-membership';
  // The dialog is rendered from confirmMessage() per verb; main.ts starts it
  // on this safe default so the destructive verb is always an explicit choice.
  return 'remove-from-catalog';
}

export function confirmMessage(verb: RemoveVerb, count: number, sampleName: string): ConfirmCopy {
  // Bodies are built so the two verbs can NEVER collapse to one string (the
  // trust boundary): delete-from-disk names the trash, remove-from-catalog
  // says in its first words that the files stay on disk.
  if (verb === 'delete-from-disk') {
    const plural = count === 1 ? 'file' : 'files';
    return {
      title: `Delete ${count} ${plural} from disk?`,
      body:
        `${count} ${plural} will be deleted from disk, for example "${sampleName}". ` +
        'Each file is moved to the system trash (recoverable from the trash, not from Candela). ' +
        'Its edits, rating, flag, and color label leave the catalog and cannot be restored from it.',
      confirmLabel: `Delete ${count} ${plural} from disk`,
      destructive: true,
    };
  }
  const plural = count === 1 ? 'photo' : 'photos';
  return {
    title: `Remove ${count} ${plural} from catalog?`,
    body:
      `${count} ${plural} will be removed from the catalog only. ` +
      'The files stay on disk, untouched. ' +
      'Their edits, ratings, flags, color labels, keywords, and collection memberships leave the catalog with them.',
    confirmLabel: `Remove ${count} from catalog`,
    destructive: false,
  };
}

// IDB layer ---------------------------------------------------------------

// Removes the files rows plus everything keyed to them. One transaction —
// IndexedDB commits it atomically — but requests are still issued
// dependents-first with the files rows LAST, and the membership scrub in
// between: any refactor that ever splits this into per-store transactions
// inherits the safe order, where the worst partial state is a file row with
// missing caches (self-healing on next render) rather than an orphaned edit
// row pointing at a file that no longer exists (a permanent catalog rot that
// every later scan would have to hunt).
//
// Store keys (src/catalog/db.ts v5): edits/thumbnails/editedThumbnails are
// keyed by 'fileId', so delete(id) hits them directly. `folders` is
// deliberately untouched: dropping photos must not evict a folder grant —
// folders outlive their photos (and re-import would duplicate work).
// Returns how many file rows actually went away.
export async function removeFilesFromCatalog(db: IDBDatabase, fileIds: number[]): Promise<number> {
  const ids = Array.from(new Set(fileIds));
  if (ids.length === 0) return 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['edits', 'thumbnails', 'editedThumbnails', 'collections', 'files'],
      'readwrite',
    );

    for (const storeName of ['edits', 'thumbnails', 'editedThumbnails'] as const) {
      const store = tx.objectStore(storeName);
      for (const id of ids) store.delete(id);
    }

    // Scrub the ids out of every real collection row. The reserved
    // '__target__' marker (collections.ts) shares this store but carries no
    // fileIds array, so the shape check skips it — no cross-module magic.
    const cursorReq = tx.objectStore('collections').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const row = cursor.value as { fileIds?: unknown };
      if (Array.isArray(row.fileIds)) {
        const gone = new Set(ids);
        const filtered = (row.fileIds as number[]).filter((fid) => !gone.has(fid));
        if (filtered.length !== (row.fileIds as number[]).length) {
          cursor.update({ ...row, fileIds: filtered });
        }
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);

    // Files last. delete() on a missing key succeeds as a no-op, so probe
    // with get() to count only rows that were really there. Both requests
    // are queued synchronously (no await between them) so the transaction
    // never goes idle and auto-commits early.
    const files = tx.objectStore('files');
    let deletedRows = 0;
    for (const id of ids) {
      const probe = files.get(id);
      probe.onsuccess = () => {
        if (probe.result !== undefined) deletedRows++;
      };
      probe.onerror = () => reject(probe.error);
      files.delete(id);
    }

    tx.oncomplete = () => resolve(deletedRows);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

// Disk layer ---------------------------------------------------------------

export interface DeleteFailure {
  name: string;
  reason: string;
}

export interface DeleteReport {
  deleted: number;
  failed: DeleteFailure[];
}

// Minimal structural shape of what we call on a handle: tests pass plain
// objects and main.ts passes real FileSystemFileHandles — same pattern as
// KeyEventLike in app/shortcuts.ts.
export interface FileHandleLike {
  name: string;
  kind: 'file' | 'directory';
  remove?: () => Promise<void>;
}

// Per-file remove(), collecting failures instead of throwing: one locked or
// absent file must not abort the rest of a 300-frame batch. The caller gets a
// report and can scope the catalog step to what actually went to the trash.
//
// Directories are REFUSED with a reason, never recursed into: LrC
// deliberately has no delete-from-disk for folders, because the catalog may
// not have fully indexed everything inside — destroying unindexed content is
// off-limits regardless of what the caller selected.
export async function deleteFilesFromDisk(handles: FileHandleLike[]): Promise<DeleteReport> {
  let deleted = 0;
  const failed: DeleteFailure[] = [];
  for (const h of handles) {
    if (!h) {
      failed.push({ name: '(unknown)', reason: 'No file handle is stored for this photo.' });
      continue;
    }
    if (h.kind !== 'file') {
      failed.push({
        name: h.name,
        reason: 'Candela never deletes folders from disk — only individual files.',
      });
      continue;
    }
    if (typeof h.remove !== 'function') {
      failed.push({
        name: h.name,
        reason: 'This browser cannot delete files — the File System Access remove() API is missing.',
      });
      continue;
    }
    try {
      await h.remove();
      deleted++;
    } catch (err) {
      failed.push({ name: h.name, reason: errMessage(err) });
    }
  }
  return { deleted, failed };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
