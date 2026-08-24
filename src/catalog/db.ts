const DB_NAME = 'candela-catalog';
const DB_VERSION = 1;

export function openCatalogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      const folders = db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
      folders.createIndex('name', 'name');

      const files = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
      files.createIndex('folderId', 'folderId');
      files.createIndex('folderPath', ['folderId', 'path']);

      db.createObjectStore('edits', { keyPath: 'fileId' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
