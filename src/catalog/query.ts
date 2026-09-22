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
// with `pathPrefix` (empty string = every file in the folder). Per
// pathPrefixRange's contract, a non-empty `pathPrefix` must end in "/"
// to correctly exclude sibling folders (e.g. "day10/").
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

// Every file whose handle stopped resolving (gap P0-3's 'Find All Missing
// Photos'). A full getAll with a truthy-`missing` filter, not an index query:
// the flag is an optional schemaless field (types.ts) with no index, and
// creating one would force a DB_VERSION bump for a query that runs when the
// user opens the Missing view — not on every scroll. The catalog scan is the
// same cost the keyword list already accepts (types.ts:22-25).
export function listMissingFiles(db: IDBDatabase): Promise<FileRecord[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').getAll();
    request.onsuccess = () =>
      resolve((request.result as FileRecord[]).filter((f) => f.missing === true));
    request.onerror = () => reject(request.error);
  });
}
