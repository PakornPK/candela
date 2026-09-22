import { describe, it, expect } from 'vitest';
import {
  splitToggle,
  describeTarget,
  isQuickCollection,
  ensureQuickCollection,
  deleteCollection,
  toggleInTarget,
  QUICK_COLLECTION_NAME,
  type Collection,
} from './collections';

// The IDB half of this module (tray identity, the target marker row,
// toggleInTarget) runs against the in-memory fake at the bottom of this
// file — the same seam keywords.test.ts uses (no fake-indexeddb dep).

function collection(over: Partial<Collection> & { id: number; name: string }): Collection {
  return { fileIds: [], createdAt: 0, updatedAt: 0, ...over };
}

describe('splitToggle (the B key decision)', () => {
  it('adds ids that are not members', () => {
    expect(splitToggle([], [1, 2, 3])).toEqual({ added: [1, 2, 3], removed: [] });
  });

  it('removes ids that are already members — B is a toggle, not an add', () => {
    expect(splitToggle([1, 2, 3], [2])).toEqual({ added: [], removed: [2] });
  });

  it('mixes add and remove in one batch, preserving incoming order', () => {
    expect(splitToggle([10, 20], [20, 30, 10, 40])).toEqual({
      added: [30, 40],
      removed: [20, 10],
    });
  });

  it('collapses duplicate ids within the incoming batch to one decision', () => {
    // Pressing B "twice" on the same photo in one selection must not both
    // add and remove it.
    expect(splitToggle([5], [5, 5])).toEqual({ added: [], removed: [5] });
    expect(splitToggle([], [7, 7, 7])).toEqual({ added: [7], removed: [] });
  });

  it('empty incoming is a no-op', () => {
    expect(splitToggle([1, 2], [])).toEqual({ added: [], removed: [] });
  });

  it('empty members with empty incoming is a no-op', () => {
    expect(splitToggle([], [])).toEqual({ added: [], removed: [] });
  });

  it('never mutates its inputs', () => {
    const members = [1, 2];
    const incoming = [2, 3];
    splitToggle(members, incoming);
    expect(members).toEqual([1, 2]);
    expect(incoming).toEqual([2, 3]);
  });
});

describe('isQuickCollection', () => {
  it('recognises the quick flag', () => {
    expect(isQuickCollection(collection({ id: 1, name: QUICK_COLLECTION_NAME, quick: true }))).toBe(true);
  });

  it('a plain collection is not quick, even when it shares the name', () => {
    // Identity is the flag, not the name: a hand-made "Quick Collection"
    // imported into a catalog must not silently become undeletable/target.
    expect(isQuickCollection(collection({ id: 2, name: QUICK_COLLECTION_NAME }))).toBe(false);
    expect(isQuickCollection(collection({ id: 2, name: QUICK_COLLECTION_NAME, quick: false }))).toBe(false);
  });
});

describe('describeTarget', () => {
  const cols = [
    collection({ id: 5, name: 'Wedding selects' }),
    collection({ id: 9, name: QUICK_COLLECTION_NAME, quick: true }),
  ];

  it('null target reads as the default tray', () => {
    expect(describeTarget(cols, null)).toBe(`Target: ${QUICK_COLLECTION_NAME}`);
  });

  it('names the pointed-at collection', () => {
    expect(describeTarget(cols, 5)).toBe('Target: Wedding selects');
  });

  it('a dangling id falls back to the Quick Collection — what toggleInTarget actually feeds', () => {
    // The label must tell the truth about where B lands, not show a ghost.
    expect(describeTarget(cols, 404)).toBe(`Target: ${QUICK_COLLECTION_NAME}`);
    expect(describeTarget([], 404)).toBe(`Target: ${QUICK_COLLECTION_NAME}`);
  });
});

// --------------------------------------------------------------------------
// The IDB half against an in-memory collections store (the same fake seam
// keywords.test.ts uses — structured-clone on read/write, async settling).
// This is what caught the tray-duplication bug class in the browser:
// ensureQuickCollection's guards read the `quick` flag, and while create
// never wrote it EVERY ensure call minted another 'Quick Collection' row.
// Pure tests could not see it; these can.
// --------------------------------------------------------------------------

interface StoreRow {
  id: number | string;
  [k: string]: unknown;
}

function fakeCollectionsDb(initial: StoreRow[] = []) {
  const rows = new Map<number | string, StoreRow>();
  let autoId = 1;
  for (const r of initial) rows.set(r.id, structuredClone(r));
  if (initial.length) autoId = Math.max(...initial.map((r) => Number(r.id) || 0)) + 1;

  const makeRequest = (run: () => StoreRow | StoreRow[] | number | undefined) => {
    const req: {
      result?: StoreRow | StoreRow[] | number | undefined;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  };

  const store = {
    getAll: () => makeRequest(() => [...rows.values()].map((r) => structuredClone(r))),
    get: (id: number | string) => makeRequest(() => {
      const r = rows.get(id);
      return r ? structuredClone(r) : undefined;
    }),
    add: (v: StoreRow) => makeRequest(() => {
      const id = autoId++;
      rows.set(id, { ...structuredClone(v), id });
      return id;
    }),
    put: (v: StoreRow) => makeRequest(() => {
      rows.set(v.id, structuredClone(v));
      return v.id as number;
    }),
    delete: (id: number | string) => makeRequest(() => {
      rows.delete(id);
      return undefined;
    }),
  };

  const tx = {
    objectStore: () => store,
    // updateCollection awaits promises chained off request callbacks; a
    // complete handler nobody registers must not throw.
    oncomplete: null as (() => void) | null,
  };
  const db = { transaction: () => tx } as unknown as IDBDatabase;
  return { db, rows };
}

describe('ensureQuickCollection (IDB)', () => {
  it('creates the tray ONCE and stamps the quick flag', async () => {
    const { db, rows } = fakeCollectionsDb();
    const a = await ensureQuickCollection(db);
    const b = await ensureQuickCollection(db);
    expect(a.quick).toBe(true);
    expect(b.id).toBe(a.id); // idempotent — the bug minted a new row here
    expect(rows.size).toBe(1);
    expect(isQuickCollection(a)).toBe(true);
  });

  it('adopts an unflagged legacy row by the reserved name instead of duplicating', async () => {
    // Catalogs written by builds before the flag existed hold an unflagged
    // 'Quick Collection'; ensure must migrate that row in place.
    const { db, rows } = fakeCollectionsDb([
      { id: 7, name: QUICK_COLLECTION_NAME, fileIds: [3], createdAt: 1, updatedAt: 1 },
    ]);
    const tray = await ensureQuickCollection(db);
    expect(tray.id).toBe(7);
    expect(tray.quick).toBe(true);
    expect(tray.fileIds).toEqual([3]); // membership survives the adoption
    expect(rows.size).toBe(1);
    const again = await ensureQuickCollection(db);
    expect(again.id).toBe(7);
  });

  it('the adopted/created tray is then undeletable', async () => {
    const { db } = fakeCollectionsDb();
    const tray = await ensureQuickCollection(db);
    await expect(deleteCollection(db, tray.id!)).rejects.toThrow(/cannot be deleted/i);
  });

  it('toggleInTarget with no target lands in the tray and toggles both ways', async () => {
    const { db, rows } = fakeCollectionsDb();
    const added = await toggleInTarget(db, [1, 2]);
    expect(added).toEqual({ added: [1, 2], removed: [] });
    const removed = await toggleInTarget(db, [2, 3]);
    expect(removed).toEqual({ added: [3], removed: [2] });
    const tray = await ensureQuickCollection(db);
    expect(tray.fileIds.sort()).toEqual([1, 3]);
    expect(rows.size).toBe(1); // still exactly one tray row
  });
});
