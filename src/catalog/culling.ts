import type { FileRecord } from './types';

// One cull mark change (flag/rating/color) on a file. get-merge-put keeps the
// full record -- including the `handle`, which a blind `put` of a partial
// patch would drop -- and reads-modifies-writes in a single readwrite
// transaction. `patch` uses the same merge semantics everywhere: setting a
// field writes it, and a rating of 0 / color of 0 clears the mark.
export function setCull(
  db: IDBDatabase,
  fileId: number,
  patch: Partial<Pick<FileRecord, 'flag' | 'rating' | 'color'>>,
): Promise<FileRecord> {
  return new Promise((resolve, reject) => {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    const request = store.get(fileId);
    request.onsuccess = () => {
      const record = request.result as FileRecord | undefined;
      if (!record) {
        reject(new Error(`File ${fileId} not in catalog`));
        return;
      }
      const merged = { ...record, ...patch };
      // Normalize "cleared" values back to absent (undefined) so rows stay
      // lean and `?? undefined` reads don't sprout zero-rating stars.
      if (merged.rating === 0) delete merged.rating;
      if (merged.color === 0) delete merged.color;
      const put = store.put(merged);
      put.onsuccess = () => resolve(merged);
      put.onerror = () => reject(put.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// Pushes a setCull result onto the in-memory record the grid renders from.
// A plain Object.assign is not enough: cleared marks are deleted from the row
// (see setCull), and Object.assign leaves keys it is not given, so the record
// would keep the old rating while the store has none -- the grid then paints
// stars for a photo the catalog no longer says are rated.
export function applyCullResult(target: FileRecord, saved: FileRecord): void {
  Object.assign(target, saved);
  if (!('rating' in saved)) delete target.rating;
  if (!('color' in saved)) delete target.color;
  if (!('flag' in saved)) delete target.flag;
}