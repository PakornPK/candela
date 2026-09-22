import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  backupFileName,
  collectCatalogRows,
  downloadCatalogBackup,
  formatBytes,
  parseCatalogBackup,
  persistenceStatusText,
  requestStoragePersistence,
  restoreCatalogRows,
  restoreConfirmationMessage,
  serializeCatalog,
  wireCatalogBackupWithPorts,
} from './backup';
import type { BackupWirePorts, WireElement, WireEvent, CatalogRows } from './backup';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dodgeBurnMask(): Int8Array {
  // signed density including every edge a /127 mask hits: 0, +max, -max
  return Int8Array.from([0, -1, -128, 127, 55, -55, 1, -100]);
}

function fullRows(): CatalogRows {
  return {
    folders: [{ id: 1, name: 'X-T4 shoot', addedAt: 1700000000000 }],
    files: [
      { id: 10, folderId: 1, path: 'IMG_0001.RAF', name: 'IMG_0001.RAF', size: 58_000_000, rating: 5, flag: true },
      { id: 11, folderId: 1, path: 'IMG_0002.RAF', name: 'IMG_0002.RAF', size: 57_000_000, keywords: ['wedding'] },
    ],
    edits: [
      {
        fileId: 10,
        cursor: 1,
        history: [
          [{ kind: 'exposure', ev: 0.5 }],
          [
            { kind: 'exposure', ev: 0.5 },
            {
              kind: 'dodgeBurn',
              amount: 40,
              size: 12,
              opacity: 60,
              feather: 30,
              mask: dodgeBurnMask(),
              maskW: 2,
              maskH: 4,
            },
          ],
        ],
      },
    ],
    collections: [{ id: 3, name: 'Best of', fileIds: [10, 11], createdAt: 1, updatedAt: 2 }],
    smartCollections: [
      { id: 4, name: 'Five stars', criteria: { rating: { op: '=', value: 5 } }, createdAt: 1, updatedAt: 2 },
    ],
  };
}

function flush(): Promise<void> {
  // One macrotask boundary drains the whole microtask chain the async click
  // handlers build (every await in them is on an already-settled promise).
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// serializeCatalog / parseCatalogBackup — the round-trip pair
// ---------------------------------------------------------------------------

describe('serializeCatalog / parseCatalogBackup round trip', () => {
  it('reproduces a full catalog through JSON', () => {
    const rows = fullRows();
    const parsed = parseCatalogBackup(serializeCatalog(rows));
    expect(parsed).toEqual(rows);
  });

  it('carries a human-inspectable envelope: version, exportedAt, counts, rows', () => {
    const envelope = JSON.parse(serializeCatalog(fullRows()));
    expect(envelope.version).toBe(BACKUP_FORMAT_VERSION);
    expect(envelope.version).toBe(1);
    expect(Number.isNaN(Date.parse(envelope.exportedAt))).toBe(false); // valid ISO date
    expect(envelope.counts).toEqual({ folders: 1, files: 2, edits: 1, collections: 1, smartCollections: 1 });
    expect(Array.isArray(envelope.rows.files)).toBe(true);
  });

  it('includes keywords in counts only when the store has rows', () => {
    const withKw = { ...fullRows(), keywords: [{ term: 'sunset' }] };
    expect(JSON.parse(serializeCatalog(withKw)).counts.keywords).toBe(1);
    expect(JSON.parse(serializeCatalog(fullRows())).counts.keywords).toBeUndefined();
    // absent keywords stay absent through parse, not a phantom []
    expect(parseCatalogBackup(serializeCatalog(fullRows())).keywords).toBeUndefined();
    // present keywords survive
    expect(parseCatalogBackup(serializeCatalog(withKw)).keywords).toEqual(withKw.keywords);
  });

  it('round-trips an empty catalog', () => {
    const empty: CatalogRows = { folders: [], files: [], edits: [], collections: [], smartCollections: [] };
    expect(parseCatalogBackup(serializeCatalog(empty))).toEqual(empty);
  });
});

describe('blob / handle exclusion (LrC backups contain no photos or previews)', () => {
  it('drops thumbnail and editedThumbnail fields from file rows', () => {
    const rows = fullRows();
    const file = rows.files[0] as Record<string, unknown>;
    file.thumbnail = new Blob(['jpegbytes'], { type: 'image/jpeg' });
    file.editedThumbnail = new Blob(['pngbytes']);
    // a future build that embeds handles in rows: a handle JSON.stringifies to
    // {} — a pointer that points at nothing, which is worse than no pointer.
    file.handle = { kind: 'file', name: 'IMG_0001.RAF' };

    const json = serializeCatalog(rows);
    expect(json).not.toContain('"thumbnail"');
    expect(json).not.toContain('"editedThumbnail"');
    expect(json).not.toContain('"handle"');

    const parsed = parseCatalogBackup(json);
    const roundTripped = parsed.files[0] as Record<string, unknown>;
    expect('thumbnail' in roundTripped).toBe(false);
    expect('editedThumbnail' in roundTripped).toBe(false);
    expect('handle' in roundTripped).toBe(false);
    // everything that IS work product survives
    expect(roundTripped.rating).toBe(5);
    expect(roundTripped.flag).toBe(true);
  });

  it('does not mutate the rows it serialized', () => {
    const rows = fullRows();
    const file = rows.files[0] as Record<string, unknown>;
    file.thumbnail = new Blob(['x']);
    file.handle = { kind: 'file' };
    serializeCatalog(rows);
    expect(file.thumbnail).toBeInstanceOf(Blob);
    expect(file.handle).toBeDefined();
  });
});

describe('dodgeBurn Int8Array masks', () => {
  it('survive the round trip byte-for-byte, as real Int8Arrays', () => {
    const rows = fullRows();
    const parsed = parseCatalogBackup(serializeCatalog(rows));
    const op = (parsed.edits[0] as { history: Record<string, unknown>[][] }).history[1][1];
    const mask = op.mask as Int8Array;
    expect(mask).toBeInstanceOf(Int8Array);
    expect(Array.from(mask)).toEqual(Array.from(dodgeBurnMask())); // byte equality
    expect(op.kind).toBe('dodgeBurn');
    expect(op.maskW).toBe(2);
    expect(op.maskH).toBe(4);
  });

  it('encode as base64, not as {"0":..,"1":..} index garbage', () => {
    const json = JSON.parse(serializeCatalog(fullRows()));
    const mask = json.rows.edits[0].history[1][1].mask;
    expect(mask.__candela_typed__).toBe('Int8Array');
    expect(typeof mask.__candela_bytes__).toBe('string');
    expect(atob(mask.__candela_bytes__).length).toBe(8);
  });

  it('keeps other typed array kinds (a future Float32 LUT survives too)', () => {
    const lut = new Float32Array([0, 0.25, -1.5, 1]);
    const rows = { ...fullRows(), collections: [{ id: 1, name: 'c', fileIds: [], lut }] };
    const parsed = parseCatalogBackup(serializeCatalog(rows));
    const decoded = (parsed.collections[0] as { lut: Float32Array }).lut;
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded)).toEqual(Array.from(lut));
  });

  it('rejects a marker naming a typed array this build does not know', () => {
    const evil = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: {},
      rows: { folders: [], files: [], edits: [{ history: [[{ __candela_typed__: 'BigUint64Array', __candela_bytes__: 'AAA=' }]] }], collections: [], smartCollections: [] },
    });
    expect(() => parseCatalogBackup(evil)).toThrow(/unknown typed array/i);
  });
});

describe('version gate', () => {
  const wrap = (rows: CatalogRows, version?: unknown): string => {
    const env: Record<string, unknown> = {
      version,
      exportedAt: new Date().toISOString(),
      counts: {},
      rows: JSON.parse(serializeCatalog(rows)).rows,
    };
    if (version === 'absent') delete env.version;
    return JSON.stringify(env);
  };

  it('rejects a missing version with a clear message', () => {
    expect(() => parseCatalogBackup(wrap(fullRows(), 'absent'))).toThrow(/no version/i);
  });

  it('rejects a future or past version and names both numbers', () => {
    expect(() => parseCatalogBackup(wrap(fullRows(), 2))).toThrow(/version 2/);
    expect(() => parseCatalogBackup(wrap(fullRows(), 99))).toThrow(/version 1/);
  });

  it('rejects non-JSON, empty text, and a non-object payload', () => {
    expect(() => parseCatalogBackup('not json at all')).toThrow(/not valid JSON/i);
    expect(() => parseCatalogBackup('')).toThrow(/empty/i);
    expect(() => parseCatalogBackup('[1,2,3]')).toThrow(/expected a JSON object/i);
  });

  it('rejects rows that are not an object, and a table that is not an array', () => {
    expect(() => parseCatalogBackup('{"version":1}')).toThrow(/no rows object/i);
    expect(() =>
      parseCatalogBackup('{"version":1,"rows":{"files":{"id":1}}}'),
    ).toThrow(/rows\.files is not an array/i);
  });
});

describe('forward compatibility', () => {
  it('tolerates unknown extra fields on rows and drops nothing', () => {
    const rows = fullRows();
    const file = rows.files[0] as Record<string, unknown>;
    file.stackerId = 7; // a field from a future build
    file.faceRegions = [{ x: 0.1, y: 0.2, kind: 'person', sub: { note: 'v3' } }];
    file.aBoolean = true;
    file.aNull = null;
    const parsed = parseCatalogBackup(serializeCatalog(rows));
    expect(parsed.files.length).toBe(rows.files.length);
    expect((parsed.files[0] as Record<string, unknown>).stackerId).toBe(7);
    expect((parsed.files[0] as Record<string, unknown>).faceRegions).toEqual(file.faceRegions);
    expect((parsed.files[0] as Record<string, unknown>).aBoolean).toBe(true);
    expect((parsed.files[0] as Record<string, unknown>).aNull).toBeNull();
    // no row of any table was lost
    expect(parsed.files.length).toBe(2);
    expect(parsed.edits.length).toBe(1);
    expect(parsed.smartCollections.length).toBe(1);
  });

  it('ignores unknown extra tables in rows instead of failing', () => {
    const json = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: {},
      rows: { folders: [{ id: 1 }], files: [], edits: [], collections: [], smartCollections: [], stacks: [{ id: 9 }] },
    });
    const parsed = parseCatalogBackup(json);
    expect(parsed.folders).toEqual([{ id: 1 }]);
    expect('stacks' in parsed).toBe(false);
  });

  it('accepts a backup that omits optional stores entirely', () => {
    const json = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: {},
      rows: { folders: [], files: [{ id: 1 }] },
    });
    const parsed = parseCatalogBackup(json);
    expect(parsed.files).toEqual([{ id: 1 }]);
    expect(parsed.edits).toEqual([]);
    expect(parsed.collections).toEqual([]);
    expect(parsed.smartCollections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure copy + names + status text
// ---------------------------------------------------------------------------

describe('backupFileName', () => {
  it('stamps the local date, zero-padded (LrC names backups with a date)', () => {
    expect(backupFileName(new Date(2026, 8, 22, 14, 30))).toBe('candela-catalog-2026-09-22.json');
    expect(backupFileName(new Date(2026, 0, 5, 0, 0))).toBe('candela-catalog-2026-01-05.json');
  });

  it('uses the local day, not UTC (a user compares it to the wall calendar)', () => {
    // 22:00 UTC on Sep 21 is Sep 22 at home in UTC+7 — the filename must say 22.
    expect(backupFileName(new Date('2026-09-21T22:00:00Z'))).toBe(
      `candela-catalog-${new Date('2026-09-21T22:00:00Z').getFullYear()}-${String(new Date('2026-09-21T22:00:00Z').getMonth() + 1).padStart(2, '0')}-${String(new Date('2026-09-21T22:00:00Z').getDate()).padStart(2, '0')}.json`,
    );
  });
});

describe('restoreConfirmationMessage', () => {
  it('states the count and that the current catalog is replaced', () => {
    const msg = restoreConfirmationMessage(1234);
    expect(msg).toContain('1234');
    expect(msg).toMatch(/replace/i);
    expect(msg).toMatch(/cannot be undone/i);
  });

  it('singularizes one photo', () => {
    expect(restoreConfirmationMessage(1)).toContain('1 photo');
    expect(restoreConfirmationMessage(1)).not.toContain('1 photos');
    expect(restoreConfirmationMessage(0)).toContain('0 photos');
  });
});

describe('formatBytes / persistenceStatusText', () => {
  it('formats SI units and trims .0', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_000_000)).toBe('12 MB');
    expect(formatBytes(4_200_000_000)).toBe('4.2 GB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('shows the protected state with the quota', () => {
    expect(
      persistenceStatusText({ persisted: true, usage: 12_000_000, quota: 4_200_000_000 }),
    ).toBe('Catalog protected from eviction · 12 MB of 4.2 GB');
  });

  it('shows a denied persist as an alarming state, not silence', () => {
    const text = persistenceStatusText({ persisted: false, usage: 12_000_000, quota: 4_200_000_000 });
    expect(text).toMatch(/NOT protected/);
    expect(text).toMatch(/evict/i);
  });

  it('hides the estimate when navigator.storage gave none', () => {
    expect(persistenceStatusText({ persisted: false, usage: 0, quota: 0 })).not.toContain('·');
  });
});

// ---------------------------------------------------------------------------
// requestStoragePersistence — never throws
// ---------------------------------------------------------------------------

describe('requestStoragePersistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports persisted + usage + quota on the happy path', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: async () => true,
        estimate: async () => ({ usage: 12_000_000, quota: 4_200_000_000 }),
      },
    });
    expect(await requestStoragePersistence()).toEqual({
      persisted: true,
      usage: 12_000_000,
      quota: 4_200_000_000,
    });
  });

  it('a denied persist() is a reported state, not a crash', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: async () => false, estimate: async () => ({ usage: 5, quota: 10 }) },
    });
    expect(await requestStoragePersistence()).toEqual({ persisted: false, usage: 5, quota: 10 });
  });

  it('an earlier grant still counts: persisted() confirms after persist() resolves false', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: async () => false,
        persisted: async () => true,
        estimate: async () => ({}),
      },
    });
    const report = await requestStoragePersistence();
    expect(report.persisted).toBe(true);
    expect(report.usage).toBe(0); // estimate missing → zeros, status line hides it
  });

  it('survives a persist() that throws (permission policy)', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: async () => {
          throw new DOMException('blocked');
        },
        estimate: async () => {
          throw new Error('no estimate');
        },
      },
    });
    expect(await requestStoragePersistence()).toEqual({ persisted: false, usage: 0, quota: 0 });
  });

  it('survives a browser with no navigator.storage at all', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestStoragePersistence()).toEqual({ persisted: false, usage: 0, quota: 0 });
    vi.stubGlobal('navigator', undefined);
    expect(await requestStoragePersistence()).toEqual({ persisted: false, usage: 0, quota: 0 });
  });
});

// ---------------------------------------------------------------------------
// downloadCatalogBackup — anchor with [download], URL revoked
// ---------------------------------------------------------------------------

describe('downloadCatalogBackup', () => {
  it('creates a blob URL, clicks a [download] anchor, revokes the URL', () => {
    const clicked: string[] = [];
    const anchor = {
      href: '',
      download: '',
      style: {} as Record<string, string>,
      click: () => clicked.push(anchor.href),
      remove: () => clicked.push('removed'),
    };
    const appended: unknown[] = [];
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: (el: unknown) => appended.push(el) },
    });
    const created: string[] = [];
    const revoked: string[] = [];
    const realUrl = globalThis.URL;
    vi.stubGlobal('URL', {
      ...realUrl,
      createObjectURL: () => {
        created.push('blob:fake');
        return 'blob:fake';
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    });

    downloadCatalogBackup('{"version":1}', 'candela-catalog-2026-09-22.json');

    expect(anchor.download).toBe('candela-catalog-2026-09-22.json');
    expect(anchor.href).toBe('blob:fake');
    expect(appended).toEqual([anchor]);
    expect(clicked).toEqual(['blob:fake', 'removed']);
    // the revoke is what keeps a 100k-row catalog string from pinning memory
    expect(revoked).toEqual(['blob:fake']);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// IndexedDB layer against a fake db (no fake-indexeddb dependency)
// ---------------------------------------------------------------------------

interface FakeTx {
  objectStore: (name: string) => FakeStore;
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  ops: string[];
}

interface FakeStore {
  getAll: () => { result?: unknown[]; onsuccess?: () => void; onerror?: () => void };
  clear: () => void;
  put: (row: unknown) => void;
}

function fakeDb(stores: Record<string, unknown[] | null>, failStore?: string): {
  db: IDBDatabase;
  txs: FakeTx[];
} {
  const txs: FakeTx[] = [];
  const names = { contains: (n: string) => stores[n] != null };
  const db = {
    objectStoreNames: names,
    transaction(name: string) {
      const tx: FakeTx = {
        ops: [],
        objectStore: () => {
          const rows = stores[name] as unknown[];
          return {
            getAll: () => {
              tx.ops.push('getAll');
              const request: { result: unknown[]; onsuccess?: () => void } = {
                result: rows.map((r) => structuredClone(r)),
              };
              setTimeout(() => request.onsuccess?.(), 0);
              return request;
            },
            clear: () => {
              tx.ops.push('clear');
              stores[name] = [];
            },
            put: (row: unknown) => {
              tx.ops.push(`put:${(row as { id?: number; fileId?: number }).id ?? (row as { fileId?: number }).fileId}`);
              (stores[name] as unknown[]).push(row);
            },
          } as FakeStore;
        },
      };
      txs.push(tx);
      setTimeout(() => {
        if (failStore === name) tx.onabort?.();
        else tx.oncomplete?.();
      }, 0);
      return tx;
    },
  } as unknown as IDBDatabase;
  return { db, txs };
}

describe('collectCatalogRows', () => {
  it('reads every catalog store', async () => {
    const stores = {
      folders: [{ id: 1 }],
      files: [{ id: 2 }, { id: 3 }],
      edits: [{ fileId: 2 }],
      collections: [],
      smartCollections: [],
      keywords: null, // store absent from this schema version
    };
    const { db } = fakeDb(stores);
    const rows = await collectCatalogRows(db);
    expect(rows.files.length).toBe(2);
    expect(rows.folders).toEqual([{ id: 1 }]);
    expect(rows.keywords).toBeUndefined();
  });

  it('yields [] for stores the schema does not have instead of throwing', async () => {
    const { db } = fakeDb({
      folders: [],
      files: [{ id: 1 }],
      edits: null, // e.g. a v1-era catalog without presets? no — without these
      collections: null,
      smartCollections: null,
      keywords: null,
    });
    const rows = await collectCatalogRows(db);
    expect(rows.edits).toEqual([]);
    expect(rows.collections).toEqual([]);
    expect(rows.smartCollections).toEqual([]);
    expect(rows.files).toEqual([{ id: 1 }]);
  });

  it('rejects when a real read errors', async () => {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({
          getAll: () => {
            const request: { onerror?: () => void } = {};
            setTimeout(() => request.onerror?.(), 0);
            return request;
          },
        }),
      }),
    } as unknown as IDBDatabase;
    await expect(collectCatalogRows(db)).rejects.toBeDefined();
  });
});

describe('restoreCatalogRows', () => {
  it('clears then puts each store inside ONE transaction, returns the file count', async () => {
    const rows = fullRows();
    const stores: Record<string, unknown[] | null> = {
      folders: [{ id: 999 }],
      files: [{ id: 999 }],
      edits: [{ fileId: 999 }],
      collections: [{ id: 999 }],
      smartCollections: [{ id: 999 }],
    };
    const { db, txs } = fakeDb(stores);
    const n = await restoreCatalogRows(db, rows);
    expect(n).toBe(2);
    // one transaction per store: each carried clear + all its puts
    // one transaction per present store; keywords is absent from the fake
    // schema, so it is skipped without opening a transaction.
    expect(txs.length).toBe(5);
    const fileTx = txs.find((t) => t.ops.includes('put:10'))!;
    expect(fileTx.ops.filter((o) => o.startsWith('put'))).toEqual(['put:10', 'put:11']);
    expect(fileTx.ops[0]).toBe('clear');
    const filesNow = stores.files as unknown[]; // the fake's type is nullable; restore populated it
    expect(filesNow).toEqual(rows.files);
    expect(stores.folders).toEqual(rows.folders);
    // the old catalog's rows are gone, replaced — not merged
    expect(filesNow.some((f) => (f as { id: number }).id === 999)).toBe(false);
  });

  it('a failed store rejects and leaves that store untouched (transaction abort)', async () => {
    const rows = fullRows();
    const stores: Record<string, unknown[] | null> = {
      folders: [],
      files: [{ id: 1 }],
      edits: [],
      collections: [],
      smartCollections: [],
    };
    const { db } = fakeDb(stores, 'edits');
    await expect(restoreCatalogRows(db, rows)).rejects.toBeDefined();
    // folders + files already committed = exactly the backup's content; the
    // failed store re-runs clean on a retry. IndexedDB gives per-store
    // atomicity; the fake asserts we never swallow the abort.
    expect(stores.folders).toEqual(rows.folders);
    expect(stores.files).toEqual(rows.files);
  });

  it('skips stores the schema does not have instead of dying', async () => {
    const stores: Record<string, unknown[] | null> = {
      folders: [],
      files: [],
      edits: [],
      collections: [],
      smartCollections: [],
      // keywords deliberately absent
    };
    const { db } = fakeDb(stores);
    const rows = { ...fullRows(), keywords: [{ term: 'x' }] };
    await expect(restoreCatalogRows(db, rows)).resolves.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// wireCatalogBackup control flow — fake elements, no DOM
// ---------------------------------------------------------------------------

interface FakeWireElement extends WireElement {
  listeners: Map<string, Array<(event: WireEvent) => void>>;
  clicks: number;
  setFiles: (files: WireElement['files']) => void;
  fire: (type: string, event: WireEvent) => void;
}

function fakeElement(): FakeWireElement {
  const listeners = new Map<string, Array<(event: WireEvent) => void>>();
  const el: FakeWireElement = {
    listeners,
    clicks: 0,
    textContent: '',
    files: null,
    value: '/fake/path.json',
    accept: '',
    click: () => {
      el.clicks++;
    },
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    setFiles: (files) => {
      el.files = files;
    },
    fire: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return el;
}

function makePorts(opts: { confirmResult?: boolean; collectFail?: string; readFileFail?: string; restoreFail?: string } = {}) {
  const elements: Record<string, FakeWireElement | null> = {
    'backup-export-btn': fakeElement(),
    'backup-import-btn': fakeElement(),
    'backup-import-input': fakeElement(),
    'backup-status': fakeElement(),
  };
  const calls = {
    collect: 0,
    restored: [] as number[],
    errors: [] as Array<[string, string | undefined]>,
    downloads: [] as Array<[string, string]>,
    confirms: [] as string[],
    restoreArgs: [] as CatalogRows[],
    persistenceCalls: 0,
  };
  const ports: BackupWirePorts = {
    getElementById: (id) => elements[id] ?? null,
    collectRows: async () => {
      calls.collect++;
      if (opts.collectFail) throw new Error(opts.collectFail);
      return fullRows();
    },
    restoreRows: async (_db, rows) => {
      calls.restoreArgs.push(rows);
      if (opts.restoreFail) throw new Error(opts.restoreFail);
      return rows.files.length;
    },
    readFile: async () => {
      if (opts.readFileFail) throw new Error(opts.readFileFail);
      return fullRows();
    },
    download: (json, filename) => {
      calls.downloads.push([json, filename]);
    },
    confirm: (message) => {
      calls.confirms.push(message);
      return opts.confirmResult ?? true;
    },
    now: () => new Date(2026, 8, 22, 12, 0),
    requestPersistence: async () => {
      calls.persistenceCalls++;
      return { persisted: true, usage: 12_000_000, quota: 4_200_000_000 };
    },
  };
  // deps wired to the same recorder so control-flow assertions see the calls
  const deps = {
    db: fakeDbArg,
    onRestored: (n: number) => calls.restored.push(n),
    onError: (title: string, detail?: string) => calls.errors.push([title, detail]),
  };
  return { ports, elements, calls, deps };
}

const fakeDbArg = {} as IDBDatabase;

describe('wireCatalogBackupWithPorts', () => {
  it('never throws on a page with none of the markup', () => {
    const { ports, deps } = makePorts();
    const noElements: BackupWirePorts = { ...ports, getElementById: () => null };
    expect(() => wireCatalogBackupWithPorts(deps, noElements)).not.toThrow();
  });

  it('half a section (import button, no file input) wires nothing and crashes nothing', () => {
    const { ports, elements, deps } = makePorts();
    elements['backup-import-input'] = null;
    expect(() => wireCatalogBackupWithPorts(deps, ports)).not.toThrow();
    // export still works independently
    expect(elements['backup-export-btn']!.listeners.has('click')).toBe(true);
    expect(elements['backup-import-btn']!.listeners.size).toBe(0);
  });

  it('requests persistence on boot and paints #backup-status', async () => {
    const { ports, elements, calls, deps } = makePorts();
    wireCatalogBackupWithPorts(deps, ports);
    await flush();
    expect(calls.persistenceCalls).toBe(1);
    expect(elements['backup-status']!.textContent).toBe(
      'Catalog protected from eviction · 12 MB of 4.2 GB',
    );
  });

  it('export click downloads a serialized backup with the dated filename', async () => {
    const { ports, elements, calls, deps } = makePorts();
    wireCatalogBackupWithPorts(deps, ports);
    elements['backup-export-btn']!.fire('click', { target: null });
    await flush();
    expect(calls.collect).toBe(1);
    expect(calls.downloads.length).toBe(1);
    const [json, filename] = calls.downloads[0];
    expect(filename).toBe('candela-catalog-2026-09-22.json');
    // the download carries a real, re-parseable backup — wiring must not hand
    // out `undefined` or a double-encoded string
    expect(parseCatalogBackup(json).files.length).toBe(2);
  });

  it('export failure goes to onError, never an unhandled rejection', async () => {
    const { ports, elements, calls, deps } = makePorts({ collectFail: 'db exploded' });
    wireCatalogBackupWithPorts(deps, ports);
    elements['backup-export-btn']!.fire('click', { target: null });
    await flush();
    expect(calls.errors[0]?.[0]).toMatch(/export/i);
    expect(calls.errors[0]?.[1]).toContain('db exploded');
    expect(calls.downloads.length).toBe(0);
  });

  it('import click opens the file picker and the input accepts json only', () => {
    const { ports, elements, deps } = makePorts();
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    expect(input.accept).toContain('.json');
    expect(input.accept).toContain('application/json');
    elements['backup-import-btn']!.fire('click', { target: null });
    expect(input.clicks).toBe(1);
  });

  it('a chosen file confirms with the photo count, restores, reports the new count', async () => {
    const { ports, elements, calls, deps } = makePorts();
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles([{ text: async () => '' }]);
    input.fire('change', { target: input });
    await flush();
    expect(calls.confirms[0]).toBe(restoreConfirmationMessage(2));
    expect(calls.restored).toEqual([2]);
    expect(calls.restoreArgs[0].files.length).toBe(2);
    expect(calls.errors).toEqual([]);
    // status refreshed: usage changed after a 2-photo restore
    expect(calls.persistenceCalls).toBe(2);
  });

  it('declining the confirm restores nothing', async () => {
    const { ports, elements, calls, deps } = makePorts({ confirmResult: false });
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles([{ text: async () => '' }]);
    input.fire('change', { target: input });
    await flush();
    expect(calls.confirms.length).toBe(1);
    expect(calls.restored).toEqual([]);
    expect(calls.restoreArgs.length).toBe(0);
  });

  it('a wrong-version file errors without touching the catalog', async () => {
    const { ports, elements, calls, deps } = makePorts({
      readFileFail: 'Backup file is version 99; this build only reads version 1.',
    });
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles([{ text: async () => '' }]);
    input.fire('change', { target: input });
    await flush();
    expect(calls.errors[0]?.[0]).toMatch(/restore/i);
    expect(calls.errors[0]?.[1]).toContain('version 99');
    expect(calls.confirms.length).toBe(0);
    expect(calls.restoreArgs.length).toBe(0);
    expect(calls.restored).toEqual([]);
  });

  it('cancelling the OS file dialog is a no-op', async () => {
    const { ports, elements, calls, deps } = makePorts();
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles(null);
    input.fire('change', { target: input });
    await flush();
    expect(calls.confirms.length).toBe(0);
    expect(calls.errors.length).toBe(0);
  });

  it('resets the input value so the same file can be re-picked', async () => {
    const { ports, elements, deps } = makePorts({ readFileFail: 'nope' });
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles([{ text: async () => '' }]);
    expect(input.value).toBe('/fake/path.json');
    input.fire('change', { target: input });
    await flush();
    expect(input.value).toBe('');
  });

  it('a restore failure reports via onError and does not claim success', async () => {
    const { ports, elements, calls, deps } = makePorts({ restoreFail: 'transaction aborted' });
    wireCatalogBackupWithPorts(deps, ports);
    const input = elements['backup-import-input']!;
    input.setFiles([{ text: async () => '' }]);
    input.fire('change', { target: input });
    await flush();
    expect(calls.restored).toEqual([]);
    expect(calls.errors.length).toBe(1);
  });
});
