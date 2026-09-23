// Collections: virtual groupings of files (manual picks).
// A collection is a named list of file IDs — like a playlist for photos.
//
// The target-collection layer (gap analysis P1-4): LrC's Quick Collection is
// the scratch tray of a first culling pass — B toggles membership from any
// module, and any collection can be made the target so B feeds it instead.
// The target pointer is stored as a single reserved row ('__target__')
// INSIDE this same `collections` store rather than a new object store: a new
// store needs a DB_VERSION bump, which fails to open while another tab holds
// the old schema (see db.ts's onblocked), while an extra row is schemaless
// and free (types.ts:16-18 makes the same argument for FileRecord fields).
// listCollections filters the marker out so the UI never renders it.

export interface Collection {
  id?: number;
  name: string;
  fileIds: number[];
  createdAt: number;
  updatedAt: number;
  // Marks the permanent Quick Collection row. Optional and schemaless — old
  // rows load unchanged, no version bump.
  quick?: boolean;
}

// The reserved marker row: { id: '__target__', targetId: number | null }.
// Kept out of Collection's shape on purpose — a marker is not a collection.
const TARGET_ROW_ID = '__target__';
interface TargetMarker {
  id: typeof TARGET_ROW_ID;
  targetId: number | null;
}

export const QUICK_COLLECTION_NAME = 'Quick Collection';

// The tray's name is RESERVED: adoption-by-name (ensureQuickCollection) and
// the user's own mental model both treat 'Quick Collection' as the one
// built-in tray. Letting a second row claim the name is how a catalog ends
// up showing a pile of Quick Collections (measured in a real dogfood
// catalog) — block it at the data layer so EVERY caller is protected,
// not just the two prompts in main.ts.
export function isReservedTrayName(name: string): boolean {
  return name.trim().toLowerCase() === QUICK_COLLECTION_NAME.toLowerCase();
}

// --------------------------------------------------------------------------
// Pure layer (unit-tested in collections.test.ts)
// --------------------------------------------------------------------------

export interface ToggleReport {
  added: number[];
  removed: number[];
}

// The B key's whole add/remove decision: an incoming id already in the
// collection comes OUT (that's what makes B a toggle), everything else goes
// in. Duplicates within `incoming` collapse — pressing B on the same photo
// twice in one batch is one toggle, not two.
export function splitToggle(currentMembers: number[], incoming: number[]): ToggleReport {
  const current = new Set(currentMembers);
  const added: number[] = [];
  const removed: number[] = [];
  const decided = new Set<number>();
  for (const id of incoming) {
    if (decided.has(id)) continue;
    decided.add(id);
    if (current.has(id)) removed.push(id);
    else added.push(id);
  }
  return { added, removed };
}

// The always-present tray every LrC user reaches for with B. Identified by
// the `quick` flag, not the name — the name is data the user could edit in a
// future release; the flag is the identity.
export function isQuickCollection(c: Collection): boolean {
  return c.quick === true;
}

// The label the UI shows next to the B-key affordance. A null target means
// the default tray — LrC's Quick Collection — and so does a dangling id
// (collection deleted out from under the pointer): the label tells the truth
// about where B will actually land, which is what toggleInTarget does too.
export function describeTarget(collections: Collection[], targetId: number | null): string {
  if (targetId === null) return `Target: ${QUICK_COLLECTION_NAME}`;
  const found = collections.find((c) => c.id === targetId);
  return `Target: ${found ? found.name : QUICK_COLLECTION_NAME}`;
}

// --------------------------------------------------------------------------
// Existing CRUD (main.ts depends on these signatures — do not change them)
// --------------------------------------------------------------------------

export async function listCollections(db: IDBDatabase): Promise<Collection[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readonly');
    const store = tx.objectStore('collections');
    const request = store.getAll();
    // Drop the reserved target marker — it shares this store (see header).
    request.onsuccess = () =>
      resolve((request.result as (Collection | TargetMarker)[]).filter((r) => r.id !== TARGET_ROW_ID) as Collection[]);
    request.onerror = () => reject(request.error);
  });
}

export async function createCollection(db: IDBDatabase, name: string, fileIds: number[] = [], quick = false): Promise<Collection> {
  // Reserved-name guard (see isReservedTrayName). `quick = true` is the
  // engine's own tray-creation path and is the only caller allowed past it.
  if (!quick && isReservedTrayName(name)) {
    throw new Error(
      `"${QUICK_COLLECTION_NAME}" is reserved — it is the built-in B-key tray and always exists. Choose another name (photos go into it with the B key).`,
    );
  }
  const now = Date.now();
  const collection: Collection = { name, fileIds, createdAt: now, updatedAt: now, ...(quick ? { quick: true } : {}) };
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

// Rejects deleting the Quick Collection: it is LrC's default B-key tray, and
// a user who culls with B must never be able to lose it (their collection
// menu should grey the item out, per LrC). Also clears the target pointer if
// the collection being deleted IS the target, so the pointer can't dangle.
export async function deleteCollection(db: IDBDatabase, id: number): Promise<void> {
  const existing = await getCollection(db, id);
  if (existing && isQuickCollection(existing)) {
    throw new Error(
      `The ${QUICK_COLLECTION_NAME} cannot be deleted — it is the default target for the B key. Empty it instead (select all and press B).`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    const store = tx.objectStore('collections');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const targetId = await getTargetCollectionId(db);
  if (targetId === id) await setTargetCollection(db, null);
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

// --------------------------------------------------------------------------
// Target collection / Quick Collection layer (P1-4)
// --------------------------------------------------------------------------

// null means "the default tray": callers treat a missing target as the Quick
// Collection (describeTarget and toggleInTarget both do), matching LrC where
// B always has somewhere to land.
export async function getTargetCollectionId(db: IDBDatabase): Promise<number | null> {
  const marker = await new Promise<TargetMarker | undefined>((resolve, reject) => {
    const tx = db.transaction('collections', 'readonly');
    const request = tx.objectStore('collections').get(TARGET_ROW_ID);
    request.onsuccess = () => resolve(request.result as TargetMarker | undefined);
    request.onerror = () => reject(request.error);
  });
  return marker && typeof marker.targetId === 'number' ? marker.targetId : null;
}

// Setting a target that doesn't exist would silently feed B into nothing
// (smart collections live in a different store with overlapping ids, so a
// numeric id alone does not prove a manual collection is there) — reject it.
export async function setTargetCollection(db: IDBDatabase, id: number | null): Promise<void> {
  if (id !== null) {
    const target = await getCollection(db, id);
    if (!target) throw new Error(`Cannot target collection ${id}: no such collection`);
  }
  const marker: TargetMarker = { id: TARGET_ROW_ID, targetId: id };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    const request = tx.objectStore('collections').put(marker);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Created on first use, never deletable (see deleteCollection). A concurrent
// double-call could race two creates; culling is single-pointer work and the
// second row is harmless (one is simply ignored) — not worth a lock.
//
// The tray is IDENTIFIED by its `quick` flag, and its name is RESERVED
// (isReservedTrayName). This function is the single owner of the invariant
// "exactly one Quick Collection tray exists":
//   - no candidate         -> create one (flagged);
//   - one candidate        -> adopt/return it (stamping the flag if a legacy
//                             unflagged row bore the reserved name);
//   - SEVERAL candidates   -> consolidate: fold every duplicate's members
//     into the survivor and delete the rest.
// The consolidation is why a catalog polluted by the old mint-a-row-per-
// ensure bug (measured 1 -> 3 -> 5 trays, and real dogfood catalogs that
// ran that build) heals itself on the next boot instead of showing a pile
// of Quick Collections forever. After the first clean boot it is a no-op.
export async function ensureQuickCollection(db: IDBDatabase): Promise<Collection> {
  const all = await listCollections(db);
  // A tray candidate is a flagged row OR any row bearing the reserved name
  // (legacy rows predate the flag).
  const candidates = all.filter((c) => isQuickCollection(c) || isReservedTrayName(c.name));
  if (candidates.length === 0) {
    return createCollection(db, QUICK_COLLECTION_NAME, [], true);
  }
  // Survivor: prefer an already-flagged row, else the first candidate
  // (listCollections returns store order, so the oldest-created row wins).
  const survivor = candidates.find(isQuickCollection) ?? candidates[0];
  const dupes = candidates.filter((c) => c.id !== survivor.id);
  // Nothing to do when there is exactly one candidate and it is already the
  // flagged tray — the steady state every boot after the first hits.
  if (dupes.length === 0 && survivor.quick === true) return survivor;
  const members = new Set<number>(survivor.fileIds);
  for (const d of dupes) for (const id of d.fileIds) members.add(id);
  const merged = await updateCollection(db, survivor.id!, { quick: true, fileIds: Array.from(members) });
  // Delete the absorbed duplicates. deleteCollection refuses a FLAGGED row
  // (it cannot know the survivor already took over the identity), so unflag
  // each dupe first — a duplicate only carries the flag in pathological
  // states (a restored backup containing several trays), but the
  // consolidation must not throw there either.
  for (const d of dupes) {
    if (d.quick) await updateCollection(db, d.id!, { quick: false });
    await deleteCollection(db, d.id!);
  }
  return merged;
}

// The B key's whole behaviour against the current target: toggle each id —
// non-members are added, existing members REMOVED. Falls back to the Quick
// Collection when no target is set or the pointer dangles.
export async function toggleInTarget(db: IDBDatabase, fileIds: number[]): Promise<ToggleReport> {
  const targetId = await getTargetCollectionId(db);
  let target = targetId !== null ? await getCollection(db, targetId) : null;
  if (!target) target = await ensureQuickCollection(db);

  const report = splitToggle(target.fileIds, fileIds);
  if (report.added.length === 0 && report.removed.length === 0) return report;

  const members = new Set(target.fileIds);
  for (const id of report.added) members.add(id);
  for (const id of report.removed) members.delete(id);
  await updateCollection(db, target.id as number, { fileIds: Array.from(members) });
  return report;
}
