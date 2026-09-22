import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUGGESTION_WINDOW_MS,
  addKeywords,
  buildKeywordList,
  filesMatchingKeyword,
  keywordKey,
  keywordSuggestions,
  normalizeKeyword,
  parseKeywordField,
  removeKeywords,
  renameKeywordAcrossCatalog,
  renameKeywordIn,
  addKeywordsToFiles,
  removeKeywordsFromFiles,
  sanitizeKeywords,
  setFileKeywords,
  toggleKeyword,
} from './keywords';

// ---- normalizeKeyword --------------------------------------------------------

describe('normalizeKeyword', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeKeyword('  wedding   2024 ')).toBe('wedding 2024');
    expect(normalizeKeyword('\tNat\n W\n')).toBe('Nat W');
  });

  it('strips LrC-forbidden separators inside a tag', () => {
    // comma/semicolon/pipe are separators, so a tag holding one becomes two tags
    // on the next round-trip through the entry field -- they are deleted here.
    expect(normalizeKeyword('a,b')).toBe('ab');
    expect(normalizeKeyword('a;b')).toBe('ab');
    expect(normalizeKeyword('animals|dogs')).toBe('animalsdogs');
  });

  it('strips a trailing asterisk only (LrC reserves it)', () => {
    expect(normalizeKeyword('family*')).toBe('family');
    expect(normalizeKeyword('family***')).toBe('family');
    expect(normalizeKeyword('f*amily')).toBe('f*amily');
  });

  it('preserves the user case -- lowercasing is for comparison only', () => {
    expect(normalizeKeyword('Border Collie')).toBe('Border Collie');
    expect(keywordKey('Border Collie')).toBe('border collie');
  });

  it('reduces an empty/garbage tag to an empty string so it is never stored', () => {
    expect(normalizeKeyword('   ')).toBe('');
    expect(normalizeKeyword('*, ;|')).toBe('');
    expect(normalizeKeyword('***')).toBe('');
  });
});

// ---- add / remove / toggle / parse ------------------------------------------

describe('addKeywords', () => {
  it('dedupes case-insensitively and keeps the FIRST spelling', () => {
    expect(addKeywords(['Wedding'], ['wedding', 'Bride'])).toEqual(['Wedding', 'Bride']);
  });

  it('keeps first-seen order and never stores an empty string', () => {
    expect(addKeywords(undefined, ['b', '', '  ', 'a', 'B'])).toEqual(['b', 'a']);
  });

  it('normalizes what it stores', () => {
    expect(addKeywords([], ['  day , two* '])).toEqual(['day two']);
  });
});

describe('removeKeywords', () => {
  it('matches case-insensitively and leaves the survivors untouched', () => {
    expect(removeKeywords(['Wedding', 'Bride', 'Groom'], ['bride'])).toEqual(['Wedding', 'Groom']);
  });

  it('removing everything yields an empty list, not undefined', () => {
    expect(removeKeywords(['a'], ['A'])).toEqual([]);
    expect(removeKeywords(undefined, ['a'])).toEqual([]);
  });

  it('an empty removal request is a no-op', () => {
    expect(removeKeywords(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(removeKeywords(['a', 'b'], ['', '   '])).toEqual(['a', 'b']);
  });
});

describe('toggleKeyword', () => {
  it('adds when absent and removes when present (case-insensitive)', () => {
    expect(toggleKeyword(['Wedding'], 'wedding')).toEqual([]);
    expect(toggleKeyword(['Wedding'], 'Bride')).toEqual(['Wedding', 'Bride']);
    expect(toggleKeyword(undefined, 'Bride')).toEqual(['Bride']);
  });

  it('a blank keyword must not wipe the photo (empty click = no-op)', () => {
    expect(toggleKeyword(['Wedding'], '  ')).toEqual(['Wedding']);
    expect(toggleKeyword(['Wedding'], '*, ;|')).toEqual(['Wedding']);
  });
});

describe('parseKeywordField', () => {
  it('splits LrC comma-separated entry text into tags', () => {
    expect(parseKeywordField('wedding, bride ,groom')).toEqual(['wedding', 'bride', 'groom']);
  });

  it('drops empties and dedupes case-insensitively', () => {
    expect(parseKeywordField('Nat,,  nat , W|X;Y')).toEqual(['Nat', 'WXY']);
  });

  it('treats newlines as separators so a pasted list works', () => {
    expect(parseKeywordField('one\ntwo,three')).toEqual(['one', 'two', 'three']);
  });

  it('empty text is an empty tag list', () => {
    expect(parseKeywordField('   ')).toEqual([]);
  });
});

describe('sanitizeKeywords', () => {
  it('is idempotent', () => {
    const once = sanitizeKeywords(['  A , b* ', 'a', '', 'C']);
    expect(sanitizeKeywords(once)).toEqual(once);
  });
});

describe('renameKeywordIn', () => {
  it('swaps the spelling in place, keeping order', () => {
    expect(renameKeywordIn(['Wed', 'Bride'], 'wed', 'Wedding')).toEqual(['Wedding', 'Bride']);
  });

  it('does not create a duplicate when the file already had the new spelling', () => {
    expect(renameKeywordIn(['Wed', 'Wedding'], 'Wed', 'wedding')).toEqual(['Wedding']);
  });

  it('returns null when the file never had the old tag', () => {
    expect(renameKeywordIn(['Bride'], 'wed', 'Wedding')).toBeNull();
  });

  it('returns null when the rename changes nothing (same spelling)', () => {
    expect(renameKeywordIn(['Wed'], 'Wed', 'wed')).toBeNull();
  });

  it('blank from/to is a no-op, not a delete-everything', () => {
    expect(renameKeywordIn(['A'], '', 'B')).toBeNull();
    expect(renameKeywordIn(['A'], 'A', ' , ')).toBeNull();
  });
});

// ---- derived catalog list / filter / suggestions -----------------------------

function kwFile(id: number, keywords?: string[], extra: Record<string, unknown> = {}) {
  return { id, keywords, ...extra };
}

describe('buildKeywordList', () => {
  it('derives the catalog list with per-keyword photo counts', () => {
    const files = [
      kwFile(1, ['Wedding', 'Bride']),
      kwFile(2, ['wedding']),
      kwFile(3, ['Wedding', 'Groom']),
    ];
    expect(buildKeywordList(files)).toEqual([
      { keyword: 'Wedding', count: 3 },
      { keyword: 'Bride', count: 1 },
      { keyword: 'Groom', count: 1 },
    ]);
  });

  it('counts a keyword once per photo even if it somehow repeats on the row', () => {
    const files = [kwFile(1, ['A', 'a'])];
    expect(buildKeywordList(files)).toEqual([{ keyword: 'A', count: 1 }]);
  });

  it('skips files with no keywords and empty/garbage tags', () => {
    expect(buildKeywordList([kwFile(1), kwFile(2, undefined), kwFile(3, ['', '  '])])).toEqual([]);
  });

  it('breaks count ties alphabetically, case-insensitively', () => {
    const list = buildKeywordList([kwFile(1, ['zeta', 'Alpha', 'beta'])]);
    expect(list.map((t) => t.keyword)).toEqual(['Alpha', 'beta', 'zeta']);
  });
});

describe('filesMatchingKeyword', () => {
  const files = [
    kwFile(1, ['Wedding']),
    kwFile(2, ['wedding', 'Bride']),
    kwFile(3, ['Party']),
    kwFile(4),
  ];
  it('matches case-insensitively', () => {
    expect(filesMatchingKeyword(files, 'WEDDING')).toEqual([1, 2]);
  });
  it('returns nothing for an unknown or blank keyword', () => {
    expect(filesMatchingKeyword(files, 'nope')).toEqual([]);
    expect(filesMatchingKeyword(files, '  ')).toEqual([]);
  });
});

describe('keywordSuggestions', () => {
  const t = (iso: string) => Date.parse(iso);
  const noon = t('2024-05-10T12:00:00Z');

  it('suggests tags from photos captured inside the window, most frequent first', () => {
    const files = [
      kwFile(1, ['Bride'], { dateTaken: noon }),
      kwFile(2, ['Ceremony', 'Venue'], { dateTaken: noon + 60_000 }),
      kwFile(3, ['Ceremony'], { dateTaken: noon + 120_000 }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual(['Ceremony', 'Venue']);
  });

  it('excludes keywords the target already has (case-insensitively)', () => {
    const files = [
      kwFile(1, ['ceremony'], { dateTaken: noon }),
      kwFile(2, ['Ceremony', 'Venue'], { dateTaken: noon + 60_000 }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual(['Venue']);
  });

  it('ignores photos outside the window', () => {
    const files = [
      kwFile(1, ['A'], { dateTaken: noon }),
      kwFile(2, ['B'], { dateTaken: noon + DEFAULT_SUGGESTION_WINDOW_MS + 1 }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual([]);
  });

  it('the window is overridable', () => {
    const files = [
      kwFile(1, ['A'], { dateTaken: noon }),
      kwFile(2, ['B'], { dateTaken: noon + 10 * 60_000 }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual(['B']);
    expect(keywordSuggestions(files, 1, 60_000)).toEqual([]);
  });

  it('prefers dateTaken over lastModified -- lastModified is the ingest date of a copied archive', () => {
    // Same mtime (imported in one batch) but captured years apart: mtime alone
    // would suggest across a decade, so dateTaken must win.
    const files = [
      kwFile(1, ['Self'], { dateTaken: noon, lastModified: t('2024-06-01T00:00:00Z') }),
      // dateTaken absent -> falls back to lastModified, which is far from noon.
      kwFile(2, ['Wrong'], { lastModified: t('2024-06-01T00:10:00Z') }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual([]);
  });

  it('falls back to lastModified when nothing has dateTaken', () => {
    const files = [
      kwFile(1, ['Self'], { lastModified: noon }),
      kwFile(2, ['Venue'], { lastModified: noon + 60_000 }),
    ];
    expect(keywordSuggestions(files, 1)).toEqual(['Venue']);
  });

  it('returns [] when the target has no timestamp at all (whole-catalog guesses are noise)', () => {
    const files = [kwFile(1, ['Self']), kwFile(2, ['Popular'], { dateTaken: noon })];
    expect(keywordSuggestions(files, 1)).toEqual([]);
  });

  it('returns [] for an unknown target id', () => {
    expect(keywordSuggestions([kwFile(2, ['A'])], 1)).toEqual([]);
  });

  it('does not suggest the target to itself', () => {
    const files = [kwFile(1, ['Only'], { dateTaken: noon })];
    expect(keywordSuggestions(files, 1)).toEqual([]);
  });
});

// ---- IndexedDB layer ---------------------------------------------------------
// A minimal in-memory stand-in for the `files` store, mirroring the two IndexedDB
// behaviours the merge discipline depends on: requests settle asynchronously, and
// get/put pass COPIES (structured clone) -- so a module that merely mutated the
// fetched object would NOT pass here; the write has to go through put. The fake
// also counts outstanding requests and fires tx.oncomplete when they drain, like
// IndexedDB's auto-commit, so the awaited promise settles the same way it does in
// the browser.
type Row = { id: number } & Record<string, unknown>;

interface FakeCursor {
  value: Row;
  update(next: Row): void;
  continue(): void;
}

function fakeFilesDb(initial: Row[]) {
  const store = new Map<number, Row>();
  for (const row of initial) store.set(row.id, { ...row });

  let pending = 0;
  let aborted = false;
  let completed = false;

  const settle = () => {
    pending -= 1;
    if (pending === 0 && !aborted && !completed) {
      // One more microtask before committing, so a request created synchronously
      // INSIDE a success handler (the get -> put chain) is counted first.
      queueMicrotask(() => {
        if (pending === 0 && !aborted && !completed) {
          completed = true;
          tx.oncomplete?.();
        }
      });
    }
  };

  const tx: {
    oncomplete: (() => void) | null;
    onabort: (() => void) | null;
    onerror: (() => void) | null;
    error: unknown;
    abort(): void;
    objectStore(): unknown;
  } = {
    oncomplete: null,
    onabort: null,
    onerror: null,
    error: null,
    abort() {
      aborted = true;
      queueMicrotask(() => tx.onabort?.());
    },
    objectStore: () => ({
      get(id: number) {
        const request: {
          result?: Row;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = { error: null, onsuccess: null, onerror: null };
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
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        pending += 1;
        queueMicrotask(() => {
          store.set(value.id, structuredClone(value));
          request.onsuccess?.();
          settle();
        });
        return request;
      },
      openCursor() {
        const ids = [...store.keys()];
        let i = 0;
        const request: { result: FakeCursor | null; onsuccess: (() => void) | null } = {
          result: null,
          onsuccess: null,
        };
        const deliver = () => {
          if (i >= ids.length) {
            request.result = null;
          } else {
            const id = ids[i++];
            const value = structuredClone(store.get(id)!);
            request.result = {
              value,
              update: (next: Row) => store.set(id, structuredClone(next)),
              continue: () => {
                pending += 1; // a live cursor keeps the transaction from committing
                queueMicrotask(deliver);
              },
            };
          }
          request.onsuccess?.();
          settle();
        };
        pending += 1;
        queueMicrotask(deliver);
        return request;
      },
    }),
  };

  const db = { transaction: () => tx } as unknown as IDBDatabase;
  return { db, rows: store };
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

describe('setFileKeywords (IDB)', () => {
  it('keeps ratings, flags and colours -- get-merge-put, not a blind patch', async () => {
    const { db, rows } = fakeFilesDb([
      fileRow({ rating: 5, flag: true, color: 2, keywords: ['old'] }),
    ]);
    await setFileKeywords(db, [1], ['Wedding', 'Bride']);
    const row = rows.get(1)!;
    expect(row.keywords).toEqual(['Wedding', 'Bride']);
    expect([row.rating, row.flag, row.color]).toEqual([5, true, 2]);
  });

  it('an empty list DELETES the key rather than storing []', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ keywords: ['a'] })]);
    await setFileKeywords(db, [1], []);
    expect('keywords' in rows.get(1)!).toBe(false);
  });

  it('normalizes and dedupes what it writes', async () => {
    const { db, rows } = fakeFilesDb([fileRow()]);
    await setFileKeywords(db, [1], ['  A,b ', 'ab', '  ']);
    expect(rows.get(1)!.keywords).toEqual(['Ab']);
  });

  it('writes every file in the selection', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ id: 1 }), fileRow({ id: 2 })]);
    await setFileKeywords(db, [1, 2], ['Tag']);
    expect(rows.get(1)!.keywords).toEqual(['Tag']);
    expect(rows.get(2)!.keywords).toEqual(['Tag']);
  });

  it('rejects when a file vanished mid-write (same contract as setCull)', async () => {
    const { db } = fakeFilesDb([fileRow({ id: 1 })]);
    await expect(setFileKeywords(db, [1, 99], ['x'])).rejects.toThrow(/99/);
  });

  it('a no-op write leaves the row untouched', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ keywords: ['A', 'B'] })]);
    await setFileKeywords(db, [1], ['A', 'B']);
    expect(rows.get(1)!.keywords).toEqual(['A', 'B']);
  });
});

describe('addKeywordsToFiles / removeKeywordsFromFiles (IDB)', () => {
  it('add merges with what the row already has', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ keywords: ['Wedding'], rating: 3 })]);
    await addKeywordsToFiles(db, [1], ['wedding', 'Bride']);
    expect(rows.get(1)!.keywords).toEqual(['Wedding', 'Bride']);
    expect(rows.get(1)!.rating).toBe(3);
  });

  it('remove prunes case-insensitively and deletes the key when empty', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ keywords: ['A', 'B'] })]);
    await removeKeywordsFromFiles(db, [1], ['a', 'b']);
    expect('keywords' in rows.get(1)!).toBe(false);
  });

  it('an empty fileIds list resolves without touching anything', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ keywords: ['A'] })]);
    await setFileKeywords(db, [], []);
    expect(rows.get(1)!.keywords).toEqual(['A']);
  });
});

describe('renameKeywordAcrossCatalog (IDB)', () => {
  it('rewrites every file that had the old spelling and reports the count', async () => {
    const { db, rows } = fakeFilesDb([
      fileRow({ id: 1, keywords: ['Wed', 'Bride'], rating: 4 }),
      fileRow({ id: 2, keywords: ['wed'] }),
      fileRow({ id: 3, keywords: ['Party'] }),
    ]);
    const changed = await renameKeywordAcrossCatalog(db, ' Wed ', 'Wedding');
    expect(changed).toBe(2);
    expect(rows.get(1)!.keywords).toEqual(['Wedding', 'Bride']);
    expect(rows.get(2)!.keywords).toEqual(['Wedding']);
    expect(rows.get(3)!.keywords).toEqual(['Party']);
    expect(rows.get(1)!.rating).toBe(4);
  });

  it('does not duplicate when a file already had the new spelling', async () => {
    const { db, rows } = fakeFilesDb([
      fileRow({ id: 1, keywords: ['Wed', 'Wedding'] }),
      fileRow({ id: 2, keywords: ['Wed'] }),
    ]);
    expect(await renameKeywordAcrossCatalog(db, 'Wed', 'wedding')).toBe(2);
    expect(rows.get(1)!.keywords).toEqual(['Wedding']);
    expect(rows.get(2)!.keywords).toEqual(['Wedding']);
  });

  it('returns 0 when nothing used the old tag', async () => {
    const { db, rows } = fakeFilesDb([fileRow({ id: 1, keywords: ['Party'] })]);
    expect(await renameKeywordAcrossCatalog(db, 'Wed', 'Wedding')).toBe(0);
    expect(rows.get(1)!.keywords).toEqual(['Party']);
  });

  it('renaming to a blank is an error, not a catalog-wide delete', async () => {
    const { db } = fakeFilesDb([fileRow({ id: 1, keywords: ['Wed'] })]);
    await expect(renameKeywordAcrossCatalog(db, 'Wed', '  ,* ')).rejects.toThrow(/empty/);
  });
});
