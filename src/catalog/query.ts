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
