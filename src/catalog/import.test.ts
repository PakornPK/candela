import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import {
  createDuplicateGate,
  duplicateKeyForRow,
  mergeFileRow,
  shouldIdentify,
  stampImportBatch,
  importFolderFromHandle,
  importSingleFile,
} from './import';
import { duplicateKeyOf } from './duplicates';
import { exifToRecordFields } from '../raw/exif';
import type { ExifIdentify } from '../raw/exif';
import type { FileRecord } from './types';

// import.ts -> exifFieldsOrEmpty -> identify() would spin up the REAL LibRaw
// WASM for any new raw-extension row (decode.test.ts owns that path). Here
// the rows are .jpg / empty buffers anyway — identify can only fail — and
// exifFieldsOrEmpty's catch-{} is precisely the behaviour these stamping
// tests ride on. Mock it to keep this file wasm-free and deterministic.
vi.mock('../raw/decode', () => ({
  identify: async () => {
    throw new Error('no wasm in import stamping tests');
  },
}));

// The two pure helpers import.ts's upsert path is built from, tested without
// IndexedDB (the DB layer is exercised end-to-end via the browser dogfood).

function existingRow(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 42,
    folderId: 7,
    path: 'DSCF8945.RAF',
    name: 'DSCF8945.RAF',
    handle: {} as FileSystemFileHandle,
    size: 58983232,
    lastModified: 1700000000000,
    ...overrides,
  };
}

// Fresh file data exactly as upsertFile builds it (no EXIF keys yet).
function freshData(overrides: Partial<Omit<FileRecord, 'id'>> = {}): Omit<FileRecord, 'id'> {
  return {
    folderId: 7,
    path: 'DSCF8945.RAF',
    name: 'DSCF8945.RAF',
    handle: {} as FileSystemFileHandle,
    size: 58983232,
    lastModified: 1700000000000,
    ...overrides,
  };
}

describe('mergeFileRow', () => {
  it('keeps pre-existing cull marks through a re-import', () => {
    // The regression this locks: upsert used to put({ ...data, id }), which
    // silently wiped flag/rating/color/keywords every time a folder was
    // re-added -- ratings live on the same row.
    const record = existingRow({ flag: true, rating: 5, color: 2, keywords: ['keep', 'cull-test'] });
    const merged = mergeFileRow(record, freshData());
    expect(merged.id).toBe(42);
    expect(merged.flag).toBe(true);
    expect(merged.rating).toBe(5);
    expect(merged.color).toBe(2);
    expect(merged.keywords).toEqual(['keep', 'cull-test']);
  });

  it('carries EXIF collected on an earlier pass when this pass re-read nothing', () => {
    // shouldIdentify says "unchanged row with cameraModel" -> data has no
    // EXIF keys -> the merge must keep the old ones, not blank them.
    const record = existingRow({ cameraModel: 'Fujifilm X100V', iso: 320, dateTaken: 1755864499000 });
    const merged = mergeFileRow(record, freshData());
    expect(merged.cameraModel).toBe('Fujifilm X100V');
    expect(merged.iso).toBe(320);
    expect(merged.dateTaken).toBe(1755864499000);
  });

  it('lets freshly-read EXIF overwrite stale values and refreshes file facts', () => {
    const exif = exifToRecordFields({
      make: 'Fujifilm',
      model: 'X100V',
      lens: '',
      datetimeOriginal: '2026:08:22 12:28:19',
      iso: 320,
      focalLength: 23,
      width: 6246,
      height: 4170,
      flip: 6,
    } satisfies ExifIdentify);
    const record = existingRow({ cameraModel: 'Wrong Camera', rating: 3, missing: true });
    const merged = mergeFileRow(record, { ...freshData({ size: 123, lastModified: 456 }), ...exif });
    expect(merged.cameraModel).toBe('Fujifilm X100V');
    expect(merged.iso).toBe(320);
    expect(merged.focalLength).toBe(23);
    expect(merged.dateTaken).not.toBeUndefined();
    // 'lens' was empty -> key absent -> old value (none here) survives as none.
    expect('lensModel' in merged).toBe(false);
    // The live file facts win (they came from the fresh getFile()).
    expect(merged.size).toBe(123);
    expect(merged.lastModified).toBe(456);
    // The rating survives the re-read -- only the file facts and EXIF change.
    expect(merged.rating).toBe(3);
    // A successful re-read clears the stale missing badge (the old row-
    // replacing spread did the same by omission).
    expect('missing' in merged).toBe(false);
  });

  it('does not leak the merge into the source record', () => {
    const record = existingRow({ rating: 4 });
    mergeFileRow(record, freshData({ size: 999 }));
    expect(record.size).toBe(58983232);
  });
});

describe('shouldIdentify', () => {
  it('returns true for a brand-new raw row', () => {
    expect(shouldIdentify('IMG_0001.RAF', undefined, 10, 20)).toBe(true);
  });

  it('returns false for non-raw files (LibRaw rejects them, so the read gains nothing)', () => {
    expect(shouldIdentify('holiday.JPG', undefined, 10, 20)).toBe(false);
    expect(shouldIdentify('scan.tiff', undefined, 10, 20)).toBe(false);
    expect(shouldIdentify('day/pic.png', existingRow(), 10, 20)).toBe(false);
  });

  it('backfills rows written before EXIF existed, then stops re-reading unchanged files', () => {
    // Pre-EXIF catalog row (no cameraModel): pay the read once.
    expect(shouldIdentify('DSCF8945.RAF', existingRow(), 58983232, 1700000000000)).toBe(true);
    // Row with EXIF, file untouched: skip -- this is the 10k-file re-import
    // path that must not re-read 58MB per file.
    const withExif = existingRow({ cameraModel: 'Fujifilm X100V' });
    expect(shouldIdentify('DSCF8945.RAF', withExif, 58983232, 1700000000000)).toBe(false);
  });

  it('re-reads when the file changed on disk (size or mtime differ)', () => {
    const withExif = existingRow({ cameraModel: 'Fujifilm X100V' });
    expect(shouldIdentify('DSCF8945.RAF', withExif, 58983233, 1700000000000)).toBe(true);
    expect(shouldIdentify('DSCF8945.RAF', withExif, 58983232, 1700000000001)).toBe(true);
  });

  it('re-reads after an in-place edit changed size/mtime (EXIF may differ now)', () => {
    // Same gate as above, stated as the scenario: exported/edited file
    // replaced at the same path gets fresh metadata next import.
    const withExif = existingRow({ cameraModel: 'Fujifilm X100V' });
    expect(shouldIdentify('DSCF8945.RAF', withExif, 60123456, 1800000000000)).toBe(true);
  });
});

// The duplicate gate (gap P1-8) — pure key-set membership, no IndexedDB.
// import.ts owns WHERE the gate runs (upsertFile after getFile); this owns
// that it skips exactly what duplicates.ts' key semantics say to skip.
describe('createDuplicateGate', () => {
  // Gate rows are plain DuplicateKeys; the gate must derive every key
  // through duplicateKeyOf, never a hand-rolled string: assertions go
  // through the engine so a format change there fails this suite rather
  // than silently splitting the catalog's idea of a duplicate in two.

  it('derives keys through the engine (same name+size twice skips)', () => {
    const gate = createDuplicateGate([{ name: 'IMG_1.CR3', size: 100 }]);
    expect(gate.test({ name: 'IMG_1.CR3', size: 100 })).toBe(true);
    expect(gate.test({ name: 'img_1.cr3', size: 100 })).toBe(true); // case folded by duplicateKeyOf
    expect(duplicateKeyOf({ name: 'IMG_1.CR3', size: 100 })).toContain('img_1.cr3');
  });

  it('same name different size imports', () => {
    const gate = createDuplicateGate([{ name: 'IMG_1.JPG', size: 100 }]);
    expect(gate.test({ name: 'IMG_1.JPG', size: 101 })).toBe(false);
  });

  it('a dated key never collides with an undated one', () => {
    // The engine's separate namespaces: an incoming candidate is undated in
    // practice (identify has not run yet), so it must not match a DATED row
    // — a re-shot frame that happens to share name+size must import.
    const gateDatedRow = createDuplicateGate([{ name: 'IMG_1.CR3', size: 100, dateTaken: 1755864499000 }]);
    expect(gateDatedRow.test({ name: 'IMG_1.CR3', size: 100 })).toBe(false);
    // And the mirror: a DATED candidate against an undated row also misses.
    const gatePlain = createDuplicateGate([{ name: 'IMG_1.CR3', size: 100 }]);
    expect(gatePlain.test({ name: 'IMG_1.CR3', size: 100, dateTaken: 1755864499000 })).toBe(false);
    // Same namespace, same facts: hit.
    expect(gatePlain.test({ name: 'IMG_1.CR3', size: 100 })).toBe(true);
  });

  it('a within-batch duplicate skips (the first kept copy claims the key)', () => {
    // Mirrors findSuspectedDuplicates: an accepted candidate adds its key, so
    // the same card walked twice in one import lands once.
    const gate = createDuplicateGate([]);
    expect(gate.test({ name: 'A.JPG', size: 50 })).toBe(false); // kept
    expect(gate.test({ name: 'a.jpg', size: 50 })).toBe(true); // duplicate of the kept row
  });

  it('import projects rows to NAME+SIZE only — a dated existing row still matches an undated candidate', () => {
    // The regression: readExistingKeys once kept dateTaken, and since the
    // incoming candidate is always undated at gate time (identify has not
    // run), the engine's dated/undated namespace split made EVERY RAW
    // duplicate a miss (measured: a second copy of the Fuji RAF imported as
    // a new row). duplicateKeyForRow is the projection both sides share.
    const row = existingRow({ dateTaken: 1787376499000, cameraModel: 'Fujifilm X100V' });
    const key = duplicateKeyForRow(row);
    expect(key).toEqual({ name: row.name, size: row.size });
    expect(key.dateTaken).toBeUndefined();
    const gate = createDuplicateGate([key]);
    // The undated candidate a second copy of the same RAW produces:
    expect(gate.test({ name: row.name, size: row.size })).toBe(true);
  });

  it('a rejected duplicate does not corrupt the set', () => {
    const gate = createDuplicateGate([{ name: 'A.JPG', size: 50 }]);
    expect(gate.test({ name: 'A.JPG', size: 50 })).toBe(true);
    // Still true (a rejected test adds nothing and removes nothing).
    expect(gate.test({ name: 'A.JPG', size: 50 })).toBe(true);
    // An unrelated candidate still passes.
    expect(gate.test({ name: 'B.JPG', size: 50 })).toBe(false);
  });
});

// ---- importBatch stamping (Previous Import) ---------------------------------
// The pure seam first: the new-vs-merge rule, then the same rule through the
// real upsert path against an in-memory files store (the fake seam style of
// keywords.test.ts — structured-clone copies, microtask settling), because
// WHERE the stamp lands (add data vs merged row) is exactly what a unit test
// of the helper alone cannot see.

describe('stampImportBatch (pure rule)', () => {
  it('a new row (no record) claims the batch id', () => {
    expect(stampImportBatch(undefined, 123)).toEqual({ importBatch: 123 });
  });

  it('a merged row adds NOTHING — spread into the merge data, mergeFileRow keeps the old stamp', () => {
    expect(stampImportBatch(existingRow({ importBatch: 999 }), 123)).toEqual({});
    // The empty object must not clobber the key when spread: this is the
    // whole contract — spread order makes {} a no-op, not `importBatch: undefined`.
    const merged = { ...existingRow({ importBatch: 999 }), ...stampImportBatch(existingRow(), 123) };
    expect(merged.importBatch).toBe(999);
  });

  it('the decision depends only on row existence, not on file contents changing', () => {
    // A re-import of a CHANGED file is still a merge: same path, row exists
    // -> keeps its original stamp (LrC's Previous Import = photos ADDED).
    const changed = existingRow({ importBatch: 999, size: 1, lastModified: 2 });
    expect(stampImportBatch(changed, 5000)).toEqual({});
  });
});

// ---- the fake catalog --------------------------------------------------------

interface FakeFileRow extends Record<string, unknown> {
  id: number;
  folderId: number;
  path: string;
  name: string;
  size: number;
  lastModified: number;
}

// Rows here carry fake FileSystem handles (method objects), which
// structuredClone rejects in node — the real browser IDB clones handles
// natively. A SHALLOW copy keeps the top-level-row discipline that matters
// for this module (writes never alias the stored row; reads hand out fresh
// objects so a caller mutating `row.rating` cannot poison the store) while
// the handle travels by reference, which every consumer here only reads.
const cloneRow = <T extends Record<string, unknown>>(r: T): T => ({ ...r });

function fakeCatalogDb(initial: { folders?: FakeFolderRow[]; files?: FakeFileRow[] } = {}) {
  const folders = new Map<number, FakeFolderRow>();
  let folderAuto = 1;
  for (const f of initial.folders ?? []) {
    folders.set(f.id, cloneRow(f));
    folderAuto = Math.max(folderAuto, f.id + 1);
  }
  const files = new Map<number, FakeFileRow>();
  let fileAuto = 1;
  for (const r of initial.files ?? []) {
    files.set(r.id, cloneRow(r));
    fileAuto = Math.max(fileAuto, r.id + 1);
  }

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

  // The files store exposes what import.ts touches: getAll (duplicate gate),
  // index('folderPath').get([folderId, path]) (row lookup), add/put.
  const filesStore = {
    getAll: () => makeRequest(() => [...files.values()].map(cloneRow)),
    add: (value: Omit<FakeFileRow, 'id'>) =>
      makeRequest(() => {
        const id = fileAuto++;
        files.set(id, { ...cloneRow(value), id } as FakeFileRow);
        return id;
      }),
    put: (value: FakeFileRow) =>
      makeRequest(() => {
        files.set(value.id, cloneRow(value));
        return value.id;
      }),
    index: (_name: string) => ({
      get: (key: [number, string]) => {
        const [folderId, path] = key;
        return makeRequest(() => {
          const row = [...files.values()].find((r) => r.folderId === folderId && r.path === path);
          return row ? cloneRow(row) : undefined;
        });
      },
    }),
  };
  const foldersStore = {
    getAll: () => makeRequest(() => [...folders.values()].map(cloneRow)),
    add: (value: Omit<FakeFolderRow, 'id'>) =>
      makeRequest(() => {
        const id = folderAuto++;
        folders.set(id, { ...cloneRow(value), id } as FakeFolderRow);
        return id;
      }),
  };

  const db = {
    transaction: (storeName: string) => ({
      objectStore: () => (storeName === 'files' ? filesStore : foldersStore),
    }),
  } as unknown as IDBDatabase;

  return { db, files, folders };
}

interface FakeFolderRow extends Record<string, unknown> {
  id: number;
  handle: FakeDirHandle;
  name: string;
  addedAt: number;
}

// Minimal File System Access stand-ins: import.ts only uses entries()
// (directory walk), kind, isSameEntry(), and getFile() — nothing WASM or
// network, so these are honest to the code under test.
interface FakeFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<{ name: string; size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

interface FakeDirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FakeDirHandle | FakeFileHandle]>;
  isSameEntry(other: FakeDirHandle): Promise<boolean>;
}

function fileHandle(name: string, size = 100, lastModified = 1000): FakeFileHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => ({
      name,
      size,
      lastModified,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  };
}

function dirHandle(name: string, files: FakeFileHandle[]): FakeDirHandle {
  const self: FakeDirHandle = {
    kind: 'directory',
    name,
    async *entries() {
      for (const f of files) yield [f.name, f];
    },
    // Identity is object identity here — faithful enough: the real API
    // compares filesystem entries, the code only consumes the boolean.
    isSameEntry: async (other: FakeDirHandle) => other === self,
  };
  return self;
}

describe('importFolderFromHandle — Previous Import batch stamps (IDB)', () => {
  afterEach(() => vi.useRealTimers());

  it('every NEW row of one import shares the batch id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const { db, files } = fakeCatalogDb();
    const dir = dirHandle('shoot', [fileHandle('a.jpg'), fileHandle('b.jpg')]);
    const result = await importFolderFromHandle(db, dir as unknown as FileSystemDirectoryHandle);
    expect(result).toEqual({ imported: 2, skippedDuplicates: 0 });
    const rows = [...files.values()];
    expect(rows.map((r) => r.importBatch)).toEqual([5000, 5000]);
  });

  it('a merged re-import keeps the OLD stamp even when the file changed on disk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const dir = dirHandle('shoot', [fileHandle('a.jpg', 100, 1000)]);
    const { db, files } = fakeCatalogDb({ folders: [{ id: 1, handle: dir, name: 'shoot', addedAt: 0 }] });
    await importFolderFromHandle(db, dir as unknown as FileSystemDirectoryHandle);
    expect([...files.values()][0].importBatch).toBe(5000);

    // Same dir picked later, file rewritten in place (size + mtime move).
    vi.setSystemTime(9000);
    const dir2 = dirHandle('shoot', [fileHandle('a.jpg', 777, 8888)]);
    // isSameEntry identity: make dir2 claim to BE the stored folder.
    dir2.isSameEntry = async (other) => other === dir || other === dir2;
    const result = await importFolderFromHandle(
      db,
      dir2 as unknown as FileSystemDirectoryHandle,
    );
    expect(result.imported).toBe(1); // the merge counts as an import (documented ImportResult semantics)
    expect(files.size).toBe(1); // still ONE row — merged, not re-added
    const row = [...files.values()][0];
    expect(row.importBatch).toBe(5000); // original stamp survives
    expect(row.size).toBe(777); // ...while the live file facts refreshed
    expect(row.lastModified).toBe(8888);
  });

  it('two imports produce DIFFERENT batch ids; only the second import rows carry the new one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { db, files } = fakeCatalogDb();
    const shootA = dirHandle('shootA', [fileHandle('a1.jpg')]);
    await importFolderFromHandle(db, shootA as unknown as FileSystemDirectoryHandle);

    vi.setSystemTime(2000);
    const shootB = dirHandle('shootB', [fileHandle('b1.jpg')]);
    await importFolderFromHandle(db, shootB as unknown as FileSystemDirectoryHandle);

    const byName = new Map([...files.values()].map((r) => [r.name, r.importBatch]));
    expect(byName.get('a1.jpg')).toBe(1000);
    expect(byName.get('b1.jpg')).toBe(2000);
    // The Previous Import smart-collection query reads exactly this shape:
    // the newest batch id selects ONLY shootB's row.
    const newest = Math.max(...[...files.values()].map((r) => Number(r.importBatch)));
    expect([...files.values()].filter((r) => r.importBatch === newest).map((r) => r.name)).toEqual(['b1.jpg']);
  });

  it('the new-row stamp survives mergeFileRow untouched on a LATER re-import (integration of the two seams)', async () => {
    // upsertFile's merge spreads stampImportBatch(record, batch) = {} into
    // `data`, so mergeFileRow(record, data) keeps record.importBatch — this
    // pins the actual DB write, not just the helper.
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const dir = dirHandle('shoot', [fileHandle('a.jpg')]);
    const { db, files } = fakeCatalogDb({ folders: [{ id: 1, handle: dir, name: 'shoot', addedAt: 0 }] });
    await importFolderFromHandle(db, dir as unknown as FileSystemDirectoryHandle);
    vi.setSystemTime(2000);
    await importFolderFromHandle(db, dir as unknown as FileSystemDirectoryHandle);
    expect([...files.values()].map((r) => r.importBatch)).toEqual([1000]);
  });
});

describe('importSingleFile — tethered frames (IDB)', () => {
  afterEach(() => vi.useFakeTimers());

  it('each captured frame stamps its OWN batch (one Date.now per frame)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(111);
    const dir = dirHandle('tether', []);
    const { db, files } = fakeCatalogDb({ folders: [{ id: 1, handle: dir, name: 'tether', addedAt: 0 }] });
    const first = fileHandle('frame-0001.cr3');
    await importSingleFile(db, dir as unknown as FileSystemDirectoryHandle, first as unknown as FileSystemFileHandle);

    vi.setSystemTime(222);
    const second = fileHandle('frame-0002.cr3');
    await importSingleFile(db, dir as unknown as FileSystemDirectoryHandle, second as unknown as FileSystemFileHandle);

    const byName = new Map([...files.values()].map((r) => [r.name, r.importBatch]));
    expect(byName.get('frame-0001.cr3')).toBe(111);
    expect(byName.get('frame-0002.cr3')).toBe(222);
  });

  it('a re-import of a same-path frame keeps its stamp (it is a merge, not a new capture)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(111);
    const dir = dirHandle('tether', []);
    const { db, files } = fakeCatalogDb({ folders: [{ id: 1, handle: dir, name: 'tether', addedAt: 0 }] });
    await importSingleFile(
      db,
      dir as unknown as FileSystemDirectoryHandle,
      fileHandle('frame.cr3') as unknown as FileSystemFileHandle,
    );
    vi.setSystemTime(999);
    const again = await importSingleFile(
      db,
      dir as unknown as FileSystemDirectoryHandle,
      fileHandle('frame.cr3', 555, 777) as unknown as FileSystemFileHandle,
    );
    expect(again.imported).toBe(1);
    expect(files.size).toBe(1);
    const row = [...files.values()][0];
    expect(row.importBatch).toBe(111);
    expect(row.size).toBe(555);
  });
});

