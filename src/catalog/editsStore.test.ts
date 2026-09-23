import { describe, it, expect } from 'vitest';
import { isValidEditRow, listEditedFileIds } from './editsStore';

describe('isValidEditRow', () => {
  it('accepts a valid row', () => {
    const row = { fileId: 1, history: [[], [{ kind: 'exposure', ev: 1 }]], cursor: 1 };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isValidEditRow(null)).toBe(false);
    expect(isValidEditRow(undefined)).toBe(false);
    expect(isValidEditRow('nope')).toBe(false);
    expect(isValidEditRow(42)).toBe(false);
  });

  it('rejects a missing history array', () => {
    expect(isValidEditRow({ fileId: 1, cursor: 0 })).toBe(false);
  });

  it('rejects an empty history array', () => {
    expect(isValidEditRow({ fileId: 1, history: [], cursor: 0 })).toBe(false);
  });

  it('rejects a snapshot that is not an array', () => {
    expect(isValidEditRow({ fileId: 1, history: [null], cursor: 0 })).toBe(false);
    expect(isValidEditRow({ fileId: 1, history: [{}], cursor: 0 })).toBe(false);
  });

  it('rejects a negative cursor', () => {
    expect(isValidEditRow({ fileId: 1, history: [[]], cursor: -1 })).toBe(false);
  });

  it('rejects a non-integer cursor', () => {
    expect(isValidEditRow({ fileId: 1, history: [[]], cursor: 0.5 })).toBe(false);
  });

  it('rejects a cursor one past the end of history', () => {
    expect(isValidEditRow({ fileId: 1, history: [[], []], cursor: 2 })).toBe(false);
  });

  it('rejects a snapshot containing null', () => {
    expect(isValidEditRow({ fileId: 1, history: [[null]], cursor: 0 })).toBe(false);
  });

  it('rejects a snapshot containing an empty object', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{}]], cursor: 0 })).toBe(false);
  });

  it('rejects an exposure op missing ev', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'exposure' }]], cursor: 0 })).toBe(false);
  });

  it('rejects an exposure op with a non-numeric ev', () => {
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'exposure', ev: 'not a number' }]], cursor: 0 })
    ).toBe(false);
  });

  it('rejects a whiteBalance op missing kelvin', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance' }]], cursor: 0 })).toBe(false);
  });

  it('rejects a whiteBalance op with a non-numeric kelvin', () => {
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 'warm' }]], cursor: 0 })
    ).toBe(false);
  });

  it('rejects an op with an unknown kind', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'unknown' }]], cursor: 0 })).toBe(false);
  });

  it('accepts a row whose snapshot has a valid exposure op', () => {
    const row = { fileId: 1, history: [[{ kind: 'exposure', ev: 0.5 }]], cursor: 0 };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('accepts a row whose snapshot has a valid whiteBalance op', () => {
    const row = { fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 5500 }]], cursor: 0 };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('accepts an As-Shot whiteBalance op carrying exact gains', () => {
    const row = {
      fileId: 1,
      history: [[{ kind: 'whiteBalance', kelvin: 5200, tint: 5, gains: { r: 2.1, g: 1, b: 1.4 } }]],
      cursor: 0,
    };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('rejects a whiteBalance op with malformed gains', () => {
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 5200, gains: { r: 2.1 } }]], cursor: 0 })
    ).toBe(false);
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 5200, gains: 'nope' }]], cursor: 0 })
    ).toBe(false);
  });
});

// ---- listEditedFileIds (IDB) ------------------------------------------------
// The in-memory fake seam the other catalog suites use (collections.test.ts's
// fakeCollectionsDb, keywords.test.ts's fakeFilesDb): async-settling requests,
// structured-clone copies out of the store, no fake-indexeddb dependency.
// This one additionally COUNTS transactions: the whole point of
// listEditedFileIds is ONE getAll per refresh (the filter bar calls it on
// every catalog render), so a regression to per-row gets fails here.

interface EditRowLike {
  fileId: number;
  history: unknown[][];
  cursor: number;
}

function fakeEditsDb(initial: EditRowLike[]) {
  const rows = new Map<number, EditRowLike>();
  for (const r of initial) rows.set(r.fileId, structuredClone(r));
  let transactionCount = 0;

  const makeRequest = (run: () => unknown) => {
    const req: {
      result?: unknown;
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
    // A get would signal per-row access (the O(n)-transactions regression).
    // The fake keeps one alive per fileId so countGet proves it is NOT used.
    get: (fileId: number) => makeRequest(() => {
      const r = rows.get(fileId);
      return r ? structuredClone(r) : undefined;
    }),
  };
  let getCalls = 0;
  const countingStore = {
    getAll: () => store.getAll(),
    get: (fileId: number) => {
      getCalls += 1;
      return store.get(fileId);
    },
  };

  const db = {
    transaction: (_name: string, _mode?: IDBTransactionMode) => {
      transactionCount += 1;
      return { objectStore: () => countingStore };
    },
  } as unknown as IDBDatabase;

  return {
    db,
    rows,
    transactions: () => transactionCount,
    getCalls: () => getCalls,
  };
}

const exposure = { kind: 'exposure', ev: 0.7 };
const row = (fileId: number, history: unknown[][], cursor: number): EditRowLike => ({ fileId, history, cursor });

describe('listEditedFileIds', () => {
  it('includes a file whose CURRENT snapshot has ops', async () => {
    const { db } = fakeEditsDb([row(1, [[], [exposure]], 1)]);
    const edited = await listEditedFileIds(db);
    expect([...edited]).toEqual([1]);
  });

  it('excludes a never-edited row (empty base snapshot) and an undone edit (cursor back at base)', async () => {
    // 'Edited' = what the editor would RENDER, not "ever touched": cursor at
    // the empty snapshot (full undo) reads unedited, exactly like
    // currentOps().length for the open file.
    const { db } = fakeEditsDb([
      row(1, [[]], 0), // fresh createEditState() row
      row(2, [[], [exposure]], 0), // edited, then fully undone
      row(3, [[], [exposure]], 1), // edited, not undone
    ]);
    const edited = await listEditedFileIds(db);
    expect([...edited].sort((a, b) => a - b)).toEqual([3]);
  });

  it('excludes a row whose LATEST snapshot is empty but older snapshots had ops', async () => {
    // Revert-to-base commits an empty snapshot at the tip: current state is
    // unedited even though history is non-empty.
    const { db } = fakeEditsDb([row(7, [[], [exposure], []], 2)]);
    expect(await listEditedFileIds(db)).toEqual(new Set());
  });

  it('skips corrupt rows without throwing (loadEditState tolerance: one bad row must not blank the view)', async () => {
    const { db } = fakeEditsDb([
      { fileId: 1, history: 'not-an-array', cursor: 0 } as unknown as EditRowLike,
      row(2, [[], [exposure]], 1),
      row(3, [[]], 5), // cursor past the end
      { fileId: 4, cursor: 0 } as unknown as EditRowLike, // no history at all
      row(5, [[{ kind: 'bogus' }]], 0), // snapshot with an invalid op
      row(6, [[exposure]], 0),
    ]);
    const edited = await listEditedFileIds(db);
    expect([...edited].sort((a, b) => a - b)).toEqual([2, 6]);
  });

  it('an empty edits store resolves to an empty set', async () => {
    const { db } = fakeEditsDb([]);
    expect(await listEditedFileIds(db)).toEqual(new Set());
  });

  it('uses EXACTLY ONE transaction regardless of row count (getAll, never per-file get)', async () => {
    const rows: EditRowLike[] = [];
    for (let i = 0; i < 500; i++) rows.push(row(i, [[], [exposure]], i % 2));
    const fake = fakeEditsDb(rows);
    const edited = await listEditedFileIds(fake.db);
    // cursor = i % 2: odd ids sit on the [exposure] snapshot, even ones on
    // the empty base — exactly half read as edited.
    expect(edited.size).toBe(250);
    expect(fake.transactions()).toBe(1);
    expect(fake.getCalls()).toBe(0);
  });

  it('rejects when the store read itself fails (the error is the caller to show, not to swallow)', async () => {
    // Tolerance is for CORRUPT ROWS, not a broken transaction: loadEditState
    // likewise rejects request.error.
    const db = {
      transaction: () => {
        throw new Error('database closed');
      },
    } as unknown as IDBDatabase;
    await expect(listEditedFileIds(db)).rejects.toThrow('database closed');
  });
});
