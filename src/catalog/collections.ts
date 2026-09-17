// Collections: virtual groupings of files (manual picks).
// A collection is a named list of file IDs — like a playlist for photos.

export interface Collection {
  id?: number;
  name: string;
  fileIds: number[];
  createdAt: number;
  updatedAt: number;
}

export async function listCollections(db: IDBDatabase): Promise<Collection[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readonly');
    const store = tx.objectStore('collections');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createCollection(db: IDBDatabase, name: string, fileIds: number[] = []): Promise<Collection> {
  const now = Date.now();
  const collection: Collection = { name, fileIds, createdAt: now, updatedAt: now };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    const store = tx.objectStore('collections');
    const request = store.add(collection);
    request.onsuccess = () => {
      collection.id = request.result as number;
      resolve(collection);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function updateCollection(db: IDBDatabase, id: number, updates: Partial<Omit<Collection, 'id' | 'createdAt'>>): Promise<Collection> {
  const collection = await getCollection(db, id);
  if (!collection) throw new Error(`Collection ${id} not found`);
  const updated = { ...collection, ...updates, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    const store = tx.objectStore('collections');
    const request = store.put(updated);
    request.onsuccess = () => resolve(updated);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCollection(db: IDBDatabase, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    const store = tx.objectStore('collections');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCollection(db: IDBDatabase, id: number): Promise<Collection | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readonly');
    const store = tx.objectStore('collections');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function addFilesToCollection(db: IDBDatabase, collectionId: number, fileIds: number[]): Promise<Collection> {
  const collection = await getCollection(db, collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const uniqueIds = Array.from(new Set([...collection.fileIds, ...fileIds]));
  return updateCollection(db, collectionId, { fileIds: uniqueIds });
}

export async function removeFilesFromCollection(db: IDBDatabase, collectionId: number, fileIds: number[]): Promise<Collection> {
  const collection = await getCollection(db, collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const removeSet = new Set(fileIds);
  const filtered = collection.fileIds.filter((id) => !removeSet.has(id));
  return updateCollection(db, collectionId, { fileIds: filtered });
}
