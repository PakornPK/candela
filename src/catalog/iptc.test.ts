import { describe, expect, it } from 'vitest';
import {
  METADATA_PRESET_STORE,
  deleteMetadataPreset,
  describePreset,
  diffIptc,
  fieldsFromPresetForm,
  listMetadataPresets,
  mergeIptc,
  newPresetId,
  presetToPatch,
  saveMetadataPreset,
  setFileIptc,
  type IptcFields,
  type MetadataPreset,
} from './iptc';

// ---- pure: preset -> patch ---------------------------------------------------

const preset = (fields: IptcFields, name = 'Studio'): MetadataPreset => ({
  id: 'p1',
  name,
  fields,
});

describe('presetToPatch', () => {
  it('drops blank values so a preset never blanks an existing field', () => {
    // THE blank-out bug class: the Metadata panel hands presets around as
    // forms full of '' for the boxes nobody typed in. If '' survived into the
    // patch, applying {copyright} would erase the photo's caption.
    const patch = presetToPatch(
      preset({ copyright: '© Studio', caption: '   ', title: '' }),
    );
    expect(patch).toEqual({ copyright: '© Studio' });
    expect('caption' in patch).toBe(false);
  });

  it('trims what it keeps', () => {
    expect(presetToPatch(preset({ creator: '  Jane Doe ' }))).toEqual({
      creator: 'Jane Doe',
    });
  });

  it('an empty preset is an empty patch (apply changes nothing)', () => {
    expect(presetToPatch(preset({}))).toEqual({});
  });
});

describe('fieldsFromPresetForm', () => {
  it('keeps trimmed non-blank fields and drops the rest', () => {
    const fields = fieldsFromPresetForm({
      title: ' Sunset ',
      caption: '',
      creator: 'Jane',
      copyright: '© 2026',
      nonsense: 'ignored',
    });
    expect(fields).toEqual({ title: 'Sunset', creator: 'Jane', copyright: '© 2026' });
    expect('caption' in fields).toBe(false);
  });

  it('an all-blank form yields no keys at all', () => {
    expect(fieldsFromPresetForm({ title: ' ', caption: '' })).toEqual({});
  });
});

describe('describePreset', () => {
  it('summarises the filled fields in canonical order', () => {
    expect(
      describePreset(preset({ caption: 'c', copyright: '(c)', creator: 'J' })),
    ).toBe('Copyright · Creator · Caption');
  });

  it('ignores blank fields in the summary', () => {
    expect(describePreset(preset({ copyright: '(c)', title: '  ' }))).toBe('Copyright');
  });

  it('says so when the preset would do nothing', () => {
    expect(describePreset(preset({}))).toBe('No fields set');
  });
});

describe('diffIptc', () => {
  it('names the fields that actually differ', () => {
    expect(diffIptc({ copyright: 'a', title: 't' }, { copyright: 'b', title: 't' })).toEqual([
      'copyright',
    ]);
  });

  it('treats absent and empty-string as the same value', () => {
    expect(diffIptc({ caption: '' }, {})).toEqual([]);
    expect(diffIptc({ caption: 'x' }, { caption: '  ' })).toEqual(['caption']);
  });

  it('reports every differing field, in canonical order', () => {
    const d = diffIptc({ title: '1', creator: 'a' }, { title: '2', creator: 'b' });
    expect(d).toEqual(['creator', 'title']); // copyright-first order, not input order
  });
});

describe('mergeIptc', () => {
  it('a key absent from the patch keeps the existing value (preset path)', () => {
    const merged = mergeIptc({ caption: 'keep me', copyright: 'old' }, { copyright: 'new' });
    expect(merged).toEqual({ caption: 'keep me', copyright: 'new' });
  });

  it('a key PRESENT in the patch replaces, and an empty string clears (panel path)', () => {
    const merged = mergeIptc({ caption: 'x' }, { caption: '' });
    expect(merged).toEqual({});
  });

  it('merges into nothing when both sides are empty', () => {
    expect(mergeIptc(undefined, { title: '  ' })).toEqual({});
  });
});

describe('newPresetId', () => {
  it('makes distinct ids', () => {
    expect(new Set([newPresetId(), newPresetId()]).size).toBe(2);
  });
});

// ---- IndexedDB: setFileIptc ----------------------------------------------------
// Same clone-on-get/put, async-settle fake as keywords.test.ts (see the comment
// there for why the copies matter: mutating the fetched row must NOT be enough).
type Row = { id: number } & Record<string, unknown>;

function fakeFilesDb(initial: Row[]) {
  const store = new Map<number, Row>();
  for (const row of initial) store.set(row.id, structuredClone(row));
  let pending = 0;
  const settle = () => {
    pending -= 1;
    if (pending === 0) {
      queueMicrotask(() => {
        if (pending === 0) tx.oncomplete?.();
      });
    }
  };
  const tx: { oncomplete: (() => void) | null; objectStore(): unknown } = {
    oncomplete: null,
    objectStore: () => ({
      get(id: number) {
        const request = {
          result: undefined as Row | undefined,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        pending += 1;
        queueMicrotask(() => {
          const row = store.get(id);
          request.result = row ? structuredClone(row) : undefined;
          request.onsuccess?.();
          settle();
        });
        return request;
      },
      put(value: Row) {
        const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        pending += 1;
        queueMicrotask(() => {
          store.set(value.id, structuredClone(value));
          request.onsuccess?.();
          settle();
        });
        return request;
      },
    }),
  };
  return { db: { transaction: () => tx } as unknown as IDBDatabase, rows: store };
}

function fileRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    folderId: 1,
    path: 'a.jpg',
    name: 'a.jpg',
    handle: {},
    size: 1,
    lastModified: 0,
    ...overrides,
  };
}

describe('setFileIptc (IDB)', () => {
  it('writes under ONE iptc key and keeps ratings/keywords/handles', async () => {
    const { db, rows } = fakeFilesDb([
      fileRow({ rating: 5, keywords: ['A'], iptc: { caption: 'old', title: 'T' } }),
    ]);
    await setFileIptc(db, [1], { caption: 'new', creator: 'Jane' });
    const row = rows.get(1)!;
    expect(row.iptc).toEqual({ caption: 'new', creator: 'Jane', title: 'T' });
    expect([row.rating, row.keywords, row.handle]).toEqual([5, ['A'], {}]);
  });

  it('applying a presetToPatch-shaped value leaves an existing caption intact', async () => {
    // End-to-end of the blank-out bug class: the preset sets copyright only, so
    // a photo with a caption must still HAVE it after Apply.
    const { db, rows } = fakeFilesDb([fileRow({ iptc: { caption: 'client copy' } })]);
    const patch = presetToPatch(preset({ caption: '', copyright: '© Studio' }));
    await setFileIptc(db, [1], patch);
    expect(rows.get(1)!.iptc).toEqual({ caption: 'client copy', copyright: '© Studio' });
  });

  it('an explicitly blanked field clears, and an empty result deletes the key', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ iptc: { caption: 'x' } })]);
    await setFileIptc(db, [1], { caption: '' });
    expect('iptc' in rows.get(1)!).toBe(false);
  });

  it('writes every selected file in one go', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ id: 1 }), fileRow({ id: 2 })]);
    await setFileIptc(db, [1, 2], { copyright: '© S' });
    expect(rows.get(1)!.iptc).toEqual({ copyright: '© S' });
    expect(rows.get(2)!.iptc).toEqual({ copyright: '© S' });
  });

  it('rejects when a file vanished mid-write (setCull contract)', async () => {
    const { db } = fakeFilesDb([fileRow({ id: 1 })]);
    await expect(setFileIptc(db, [1, 99], { title: 'x' })).rejects.toThrow(/99/);
  });
});

// ---- IndexedDB: metadata presets -----------------------------------------------
// A fake with a SWITCHABLE preset store: the whole point of these tests is that
// reads tolerate the store not existing yet (db.ts v6 is a parent action) and
// writes refuse loudly.

function fakePresetDb(rows: MetadataPreset[], withStore = true) {
  const store = new Map<string, MetadataPreset>();
  for (const row of rows) store.set(row.id, structuredClone(row));
  const txFactory = (_name: string, _mode: string) => {
    const tx = {
      onabort: null as (() => void) | null,
      objectStore: () => ({
        getAll() {
          const request = {
            result: undefined as unknown,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
          };
          queueMicrotask(() => {
            request.result = structuredClone([...store.values()]);
            request.onsuccess?.();
          });
          return request;
        },
        put(value: MetadataPreset) {
          const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => {
            store.set(value.id, structuredClone(value));
            request.onsuccess?.();
          });
          return request;
        },
        delete(id: string) {
          const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => {
            if (store.has(id)) {
              store.delete(id);
              request.onsuccess?.();
            } else {
              // Real IDB raises an error event; so do we.
              request.onerror?.();
            }
          });
          return request;
        },
      }),
    };
    return tx;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => withStore && n === METADATA_PRESET_STORE },
    transaction: (name: string, mode: string) => {
      if (!(withStore && name === METADATA_PRESET_STORE)) {
        throw new Error(`NotFoundError: no store '${name}'`);
      }
      return txFactory(name, mode);
    },
  } as unknown as IDBDatabase;
  return { db, rows: store };
}

describe('metadata preset store', () => {
  const p: MetadataPreset = { id: 'x1', name: 'Studio', fields: { copyright: '© S' } };

  it('lists nothing when the store does not exist yet (pre-v6 db)', async () => {
    const { db } = fakePresetDb([], false);
    expect(await listMetadataPresets(db)).toEqual([]);
  });

  it('reads tolerate a throwing transaction (still no presets, no crash)', async () => {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        throw new Error('TransactionInactiveError');
      },
    } as unknown as IDBDatabase;
    expect(await listMetadataPresets(db)).toEqual([]);
  });

  it('lists presets sorted by name', async () => {
    const { db } = fakePresetDb([
      { id: 'b', name: 'Zebra', fields: { copyright: 'z' } },
      { id: 'c', name: 'Alpha', fields: { creator: 'a' } },
    ]);
    const list = await listMetadataPresets(db);
    expect(list.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('saving into a missing store fails with a message naming the fix', async () => {
    const { db } = fakePresetDb([], false);
    await expect(saveMetadataPreset(db, p)).rejects.toThrow(/metadataPresets/);
    await expect(deleteMetadataPreset(db, 'x1')).rejects.toThrow(/metadataPresets/);
  });

  it('save upserts by id and delete removes', async () => {
    const { db, rows } = fakePresetDb([p]);
    await saveMetadataPreset(db, { ...p, name: 'Studio 2026' });
    expect(rows.get('x1')!.name).toBe('Studio 2026');
    await deleteMetadataPreset(db, 'x1');
    expect(rows.size).toBe(0);
  });

  it('deleting an unknown preset rejects', async () => {
    const { db } = fakePresetDb([p]);
    await expect(deleteMetadataPreset(db, 'nope')).rejects.toThrow(/nope|No metadata preset/);
  });

  it('rejects a preset with no id or no name before touching IDB', async () => {
    const { db } = fakePresetDb([]);
    await expect(saveMetadataPreset(db, { id: '', name: 'x', fields: {} })).rejects.toThrow(/id/);
    await expect(
      saveMetadataPreset(db, { id: 'x', name: '  ', fields: { copyright: 'c' } }),
    ).rejects.toThrow(/name/);
  });
});
