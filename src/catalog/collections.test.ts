import { describe, it, expect } from 'vitest';
import {
  splitToggle,
  describeTarget,
  isQuickCollection,
  collectionNudge,
  NUDGE_PICK_THRESHOLD,
  createCollection,
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

describe('collectionNudge (post-cull teaching moment)', () => {
  it('nudges at and above the threshold when the tray is empty and nothing was nudged', () => {
    expect(collectionNudge(NUDGE_PICK_THRESHOLD, 0, false)).toBeTypeOf('string');
    expect(collectionNudge(500, 0, false)).toBeTypeOf('string');
  });

  it('stays silent BELOW the threshold — a few picks are not a cull pass', () => {
    expect(collectionNudge(NUDGE_PICK_THRESHOLD - 1, 0, false)).toBeNull();
    expect(collectionNudge(0, 0, false)).toBeNull();
    expect(collectionNudge(19, 0, false)).toBeNull(); // boundary: one short
  });

  it('the boundary is inclusive: 19 silent, 20 nudges', () => {
    expect(NUDGE_PICK_THRESHOLD).toBe(20);
    expect(collectionNudge(19, 0, false)).toBeNull();
    expect(collectionNudge(20, 0, false)).not.toBeNull();
  });

  it('a NON-EMPTY tray suppresses it — B is already in use there', () => {
    expect(collectionNudge(500, 1, false)).toBeNull();
    expect(collectionNudge(500, 30, false)).toBeNull();
  });

  it('alreadyNudged suppresses it — one teaching moment per session', () => {
    expect(collectionNudge(500, 0, true)).toBeNull();
  });

  it('the message names the B key and the Quick Collection (the wiring flashes it verbatim)', () => {
    const msg = collectionNudge(24, 0, false)!;
    expect(msg).toContain('B');
    expect(msg).toContain(QUICK_COLLECTION_NAME);
    expect(msg).toContain('Quick Collection');
  });

  it('returns null, never an empty string, when not applicable', () => {
    // The caller does `msg && flash(msg)`; '' would be falsy anyway, but the
    // contract is `string | null` and a test locks it so a refactor to
    // `return ''` cannot slip through.
    expect(collectionNudge(5, 0, false)).toBeNull();
    expect(collectionNudge(5, 2, false)).toBeNull();
    expect(collectionNudge(5, 0, true)).toBeNull();
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

// How many rows still count as the Quick Collection tray (flagged OR bearing
// the reserved name). The invariant ensureQuickCollection must hold is
// "exactly one" — this counts it from the raw store so a consolidation that
// deleted nothing (or left an unflagged name-twin) is caught.
function traysIn(rows: Map<number | string, StoreRow>): number {
  return [...rows.values()].filter(
    (r) => r.quick === true || String(r.name).trim().toLowerCase() === QUICK_COLLECTION_NAME.toLowerCase(),
  ).length;
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

  it('CONSOLIDATES several trays into one, merging members (heals old polluted catalogs)', async () => {
    // The old mint-a-row-per-ensure build left real catalogs with a pile of
    // Quick Collections; the next boot must fold them into the survivor
    // (oldest row wins) without losing any member.
    const { db, rows } = fakeCollectionsDb([
      { id: 2, name: QUICK_COLLECTION_NAME, fileIds: [10, 11], createdAt: 1, updatedAt: 1 },
      { id: 5, name: QUICK_COLLECTION_NAME, fileIds: [11, 12], createdAt: 2, updatedAt: 2 },
      { id: 9, name: QUICK_COLLECTION_NAME, fileIds: [], createdAt: 3, updatedAt: 3, quick: true },
      { id: 4, name: 'Wedding', fileIds: [20], createdAt: 4, updatedAt: 4 },
    ]);
    const tray = await ensureQuickCollection(db);
    // Survivor preference: the flagged row (id 9), even though id 2 is older —
    // the flag is the identity, and a legacy adoption only applies when
    // nothing is flagged.
    expect(tray.id).toBe(9);
    expect(tray.quick).toBe(true);
    expect(tray.fileIds.sort((a, b) => a - b)).toEqual([10, 11, 12]); // union, deduped
    // Duplicates gone; the user's real collection untouched.
    expect(rows.has(2)).toBe(false);
    expect(rows.has(5)).toBe(false);
    expect(rows.get(4)).toMatchObject({ name: 'Wedding', fileIds: [20] });
    expect(traysIn(rows)).toBe(1);
    // Idempotent: a second call is a no-op.
    const again = await ensureQuickCollection(db);
    expect(again.id).toBe(9);
    expect(traysIn(rows)).toBe(1);
  });

  it('a flagged duplicate (restored-backup pathology) also consolidates without throwing', async () => {
    const { db, rows } = fakeCollectionsDb([
      { id: 1, name: QUICK_COLLECTION_NAME, fileIds: [1], createdAt: 1, updatedAt: 1, quick: true },
      { id: 2, name: QUICK_COLLECTION_NAME, fileIds: [2], createdAt: 2, updatedAt: 2, quick: true },
    ]);
    const tray = await ensureQuickCollection(db);
    expect(tray.quick).toBe(true);
    expect(tray.fileIds.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(traysIn(rows)).toBe(1);
  });

  it('createCollection REFUSES the reserved tray name (monkey-proof at the data layer)', async () => {
    // A user (or a future UI path) naming their own collection 'Quick
    // Collection' must be blocked, or the next ensure adopts it as the tray
    // and the catalog grows another undeletable pile.
    const { db, rows } = fakeCollectionsDb();
    await expect(createCollection(db, 'Quick Collection', [1])).rejects.toThrow(/reserved/i);
    await expect(createCollection(db, ' quick collection ', [1])).rejects.toThrow(/reserved/i); // case/space folded
    expect(rows.size).toBe(0); // nothing was written
    // A normal name still works.
    const ok = await createCollection(db, 'Wedding selects', [1]);
    expect(ok.name).toBe('Wedding selects');
    expect(rows.size).toBe(1);
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
