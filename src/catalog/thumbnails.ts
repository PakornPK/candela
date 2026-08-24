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
  } catch (err) {
    console.warn(`Thumbnail extraction failed for "${record.path}":`, err);
    await saveThumbnail(db, record.id, null);
    return undefined;
  }
}
