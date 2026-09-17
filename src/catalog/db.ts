const DB_NAME = 'candela-catalog';
const DB_VERSION = 4;

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

      if (event.oldVersion < 3) {
        db.createObjectStore('presets', { keyPath: 'id', autoIncrement: true });
      }

      if (event.oldVersion < 4) {
        // Collections: virtual groupings of files (manual picks).
        db.createObjectStore('collections', { keyPath: 'id', autoIncrement: true });
        // Smart collections: auto-updating based on criteria.
        db.createObjectStore('smartCollections', { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);

    // A version bump can't start while another tab still holds the old schema,
    // and IndexedDB just fires `blocked` and waits -- without this the open()
    // never settles and the app comes up empty with no explanation.
    request.onblocked = () =>
      reject(new Error('Another Candela tab is holding an older catalog — close it and reload.'));
  });
}
