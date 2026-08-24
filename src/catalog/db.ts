const DB_NAME = 'candela-catalog';
const DB_VERSION = 2;

export function openCatalogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (event.oldVersion < 1) {
        const folders = db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
        folders.createIndex('name', 'name');

        const files = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
        files.createIndex('folderId', 'folderId');
        files.createIndex('folderPath', ['folderId', 'path']);

        db.createObjectStore('edits', { keyPath: 'fileId' });
      }

      if (event.oldVersion < 2) {
        db.createObjectStore('thumbnails', { keyPath: 'fileId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
