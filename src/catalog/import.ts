import type { FolderRecord, FileRecord } from './types';
import { listFolders } from './query';

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
  await importFolderFromHandle(db, dirHandle);
}

// Import from an existing directory handle (for drag & drop)
export async function importFolderFromHandle(db: IDBDatabase, dirHandle: FileSystemDirectoryHandle): Promise<void> {
  const folderId = await upsertFolder(db, dirHandle);
  for await (const { path, handle } of walk(dirHandle, '')) {
    await upsertFile(db, folderId, path, handle);
  }
}

// Imports one file under a folder handle. Tethered capture uses this for
// frames arriving one at a time; the batch path above covers whole folders.
// Path is the bare file name, matching what walk() yields at the top level.
export async function importSingleFile(
  db: IDBDatabase,
  dirHandle: FileSystemDirectoryHandle,
  fileHandle: FileSystemFileHandle,
): Promise<void> {
  const folderId = await upsertFolder(db, dirHandle);
  await upsertFile(db, folderId, fileHandle.name, fileHandle);
}
