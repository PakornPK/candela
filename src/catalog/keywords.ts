// Keywords (gap-analysis P0-6) -- LrC's third organization axis after folders
// and collections, and the one that scales to 100k files.
//
// DESIGN: there is NO keyword registry store. The catalog-wide keyword LIST is
// DERIVED by scanning file rows (buildKeywordList below). One source of truth,
// so a rename or delete can never leave a registry claiming photos it no longer
// has -- and a derived list needs no DB_VERSION bump (rows are schemaless).
// Hierarchy (`animals|dogs|Border Collie`), synonyms and keyword sets are out of
// scope for this pass; everything here works on a flat string array.
//
// The pure half of the file is the rules (normalization, dedupe, tally, suggest)
// and holds no DOM/IndexedDB dependency, matching sidecar.ts / culling.ts. The
// IDB half mirrors setCull's get-merge-put discipline exactly: a keyword write
// reads the whole row, changes ONLY `keywords`, and writes it back, so a
// concurrent rating/flag/colour write can't be clobbered.

import type { FileRecord } from './types';

// ---- structural input types -------------------------------------------------
// The pure functions take the narrowest shape they actually read, so tests and
// callers can hand them plain objects instead of full FileRecords (a FileRecord
// is assignable to all three).

export interface KeywordSource {
  keywords?: string[];
}
export interface KeywordFile extends KeywordSource {
  id: number;
}
// Timestamps used only by keywordSuggestions: `dateTaken` (EXIF capture time)
// preferred, `lastModified` (when the file landed on disk) as the fallback.
export interface KeywordSuggestionSource extends KeywordFile {
  dateTaken?: number;
  lastModified?: number;
}

export interface KeywordTally {
  keyword: string;
  count: number;
}

// ---- pure: normalization ----------------------------------------------------

// LrC's tag-content rule: a keyword may not contain a comma, semicolon or pipe
// (those are the field/list separators, so a tag holding one becomes two tags on
// round-trip) and may not END with an asterisk (LrC reserves a trailing `*`).
// Those characters are stripped here. Whitespace is trimmed and internal runs
// collapsed so "  wedding    2024 " and "wedding 2024" are the same tag.
//
// Case is PRESERVED -- this returns the stored/displayed spelling. Comparison is
// case-insensitive in LrC and here, but going lowercase would overwrite what the
// user typed ("Nat" -> "nat") the moment they re-saved a photo. Use keywordKey()
// for the comparison form.
export function normalizeKeyword(s: string): string {
  return s
    .replace(/[,;|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\*+$/, '');
}

// The case-insensitive comparison key for a tag. Every dedupe, remove, match and
// tally in this module goes through it, so there is exactly one notion of "same
// keyword" -- the bug class it prevents is "Wedding" and "wedding" both living in
// the Keyword List with half the photos each.
export function keywordKey(s: string): string {
  return normalizeKeyword(s).toLowerCase();
}

// Normalize a proposed list into a storable one: strip empties, drop
// case-insensitive duplicates, keep first-seen order.
export function sanitizeKeywords(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const value = normalizeKeyword(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// LrC's Keywording panel field is comma-separated text; typing into it replaces
// the tags. Split on commas (and newlines, so a list pasted from anywhere
// works). Semicolons and pipes do NOT split here -- normalizeKeyword strips them
// from inside a tag, mirroring LrC, where they belong to other keyword features
// (hierarchy, sets) that are out of scope.
export function parseKeywordField(text: string): string[] {
  return sanitizeKeywords(text.split(/[,\n]/));
}

// Add tags to a file's existing set: case-insensitive dedupe, first-seen order,
// never stores an empty string. Existing spellings win -- adding "wedding" to a
// file that already says "Wedding" must not silently rename that tag.
export function addKeywords(
  current: readonly string[] | undefined,
  added: readonly string[],
): string[] {
  return sanitizeKeywords([...(current ?? []), ...added]);
}

// Remove tags case-insensitively, keeping the surviving spellings untouched.
export function removeKeywords(
  current: readonly string[] | undefined,
  removed: readonly string[],
): string[] {
  const drop = new Set<string>();
  for (const raw of removed) {
    const key = keywordKey(raw);
    if (key) drop.add(key);
  }
  if (drop.size === 0) return sanitizeKeywords(current);
  return sanitizeKeywords(current).filter((kw) => !drop.has(keywordKey(kw)));
}

// Clicking a keyword in the Keyword List toggles it on the selection. A tag that
// normalizes to nothing is a no-op (returns a copy), so an empty click can never
// wipe a photo's keywords.
export function toggleKeyword(current: readonly string[] | undefined, kw: string): string[] {
  const value = normalizeKeyword(kw);
  if (!value) return sanitizeKeywords(current);
  const key = value.toLowerCase();
  const list = sanitizeKeywords(current);
  if (list.some((existing) => keywordKey(existing) === key)) {
    return list.filter((existing) => keywordKey(existing) !== key);
  }
  return [...list, value];
}

// Rename one tag inside a list. Returns null when nothing would change, so the
// caller (and the cursor loop in renameKeywordAcrossCatalog) can skip the write.
//
// When the file ALREADY had the new spelling, the existing spelling wins and the
// old tag is just dropped -- renaming "Wed" to "wedding" onto a photo that says
// "Wedding" must not re-case the surviving tag (LrC merges into the existing
// keyword the same way), and it must never leave two spellings on one row.
export function renameKeywordIn(
  current: readonly string[] | undefined,
  from: string,
  to: string,
): string[] | null {
  const key = keywordKey(from);
  const target = normalizeKeyword(to);
  if (!key || !target) return null;
  const list = sanitizeKeywords(current);
  if (!list.some((kw) => keywordKey(kw) === key)) return null;
  const targetKey = keywordKey(target);
  const existing = list.find((kw) => keywordKey(kw) === targetKey);
  const replacement = existing ?? target;
  const renamed = list.map((kw) => (keywordKey(kw) === key ? replacement : kw));
  const next = sanitizeKeywords(renamed);
  const same =
    next.length === list.length && next.every((kw, i) => kw === list[i]);
  return same ? null : next;
}

// ---- pure: derived catalog list / filtering / suggestions -------------------

// The Keyword List panel: every distinct tag in the catalog with its photo count,
// most-used first (LrC sorts by count so the tags you actually reach for surface
// at the top), ties broken alphabetically for a stable list. The first spelling
// seen wins as the display form, so the list doesn't flicker between "Wed" and
// "wed" as rows load.
export function buildKeywordList(files: readonly KeywordSource[]): KeywordTally[] {
  const counts = new Map<string, { keyword: string; count: number }>();
  for (const file of files) {
    // Per-file dedupe: the list counts PHOTOS (like LrC's parenthesized number),
    // so even a legacy row carrying the same tag twice contributes 1, not 2.
    const keysThisFile = new Set<string>();
    for (const raw of file.keywords ?? []) {
      const value = normalizeKeyword(raw);
      if (!value) continue;
      const key = value.toLowerCase();
      if (keysThisFile.has(key)) continue;
      keysThisFile.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { keyword: value, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const an = a.keyword.toLowerCase();
    const bn = b.keyword.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0;
  });
}

// "Click a keyword = filter the grid": the file ids carrying that tag,
// case-insensitively.
export function filesMatchingKeyword(
  files: readonly KeywordFile[],
  keyword: string,
): number[] {
  const key = keywordKey(keyword);
  if (!key) return [];
  const out: number[] = [];
  for (const file of files) {
    if ((file.keywords ?? []).some((kw) => keywordKey(kw) === key)) out.push(file.id);
  }
  return out;
}

// LrC's default suggestion window: photos captured within ~2 hours of each other
// are the same shoot/session, which is what makes its suggestions useful.
export const DEFAULT_SUGGESTION_WINDOW_MS = 2 * 60 * 60 * 1000;

// Suggest tags for one photo from its time-neighbours (LrC's Keywording panel
// "Suggestions: all" uses capture time the same way). We have no EXIF offset
// range, so: nearest-in-time by whichever timestamp exists, `dateTaken` preferred
// (lastModified is the ingest date of a copied archive -- a decade of photos lands
// in one hour and every photo would suggest every other).
//
// Returns [] when the target carries NEITHER timestamp: with no anchor there is no
// "close in time", and falling back to the whole catalog would suggest the most
// popular tags in the library, which is noise, not a suggestion.
export function keywordSuggestions(
  files: readonly KeywordSuggestionSource[],
  targetId: number,
  windowMs: number = DEFAULT_SUGGESTION_WINDOW_MS,
): string[] {
  const target = files.find((file) => file.id === targetId);
  if (!target) return [];
  const anchor = captureTime(target);
  if (anchor === null) return [];

  const has = new Set((target.keywords ?? []).map(keywordKey));
  const counts = new Map<string, { keyword: string; count: number }>();
  for (const file of files) {
    if (file.id === targetId) continue;
    const when = captureTime(file);
    if (when === null || Math.abs(when - anchor) > windowMs) continue;
    // Frequency counts PHOTOS, not tag instances (see buildKeywordList).
    const keysThisFile = new Set<string>();
    for (const raw of file.keywords ?? []) {
      const value = normalizeKeyword(raw);
      if (!value) continue;
      const key = value.toLowerCase();
      if (has.has(key) || keysThisFile.has(key)) continue; // skip what it already has
      keysThisFile.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { keyword: value, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      const an = a.keyword.toLowerCase();
      const bn = b.keyword.toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.keyword < b.keyword ? -1 : 1;
    })
    .map((entry) => entry.keyword);
}

function captureTime(file: KeywordSuggestionSource): number | null {
  const taken = file.dateTaken;
  if (typeof taken === 'number' && Number.isFinite(taken)) return taken;
  const modified = file.lastModified;
  if (typeof modified === 'number' && Number.isFinite(modified)) return modified;
  return null;
}

// ---- IndexedDB layer --------------------------------------------------------
// Every write is get-merge-put on the full row, exactly like setCull: the record
// also carries the file `handle`, so a blind `put` of a partial patch would drop
// it, and a patch that skipped the read would erase the rating a keystroke earlier.

// Write a whole keyword list (replace semantics -- this is what LrC's comma-
// separated Keywording field does on blur). An empty list DELETES the key so rows
// stay lean, the same normalization setCull applies to a 0-star rating.
export function setFileKeywords(
  db: IDBDatabase,
  fileIds: readonly number[],
  keywords: readonly string[],
): Promise<void> {
  const next = sanitizeKeywords(keywords);
  return updateFiles(db, fileIds, (record) => writeKeywords(record, next));
}

export function addKeywordsToFiles(
  db: IDBDatabase,
  fileIds: readonly number[],
  added: readonly string[],
): Promise<void> {
  return updateFiles(db, fileIds, (record) => {
    const merged = addKeywords(record.keywords, added);
    return writeKeywords(record, merged);
  });
}

export function removeKeywordsFromFiles(
  db: IDBDatabase,
  fileIds: readonly number[],
  removed: readonly string[],
): Promise<void> {
  return updateFiles(db, fileIds, (record) => {
    const pruned = removeKeywords(record.keywords, removed);
    return writeKeywords(record, pruned);
  });
}

// The Keyword List's rename affordance: one tag, every photo, catalog-wide.
// Returns how many rows actually changed (the UI reports it, and 0 means the
// spelling never existed -- worth saying out loud rather than a silent no-op).
//
// Two cursor passes inside ONE readwrite transaction (an IDB transaction's view
// is stable while it runs, so nothing can slip in between): pass 1 finds the
// display spelling the catalog already uses for the TARGET (renaming "Wed" to
// "wedding" must merge into the "Wedding" some photos already show, not leave
// half the rows "Wedding" and half "wedding" -- with no registry, the per-row
// string IS the registry, so it has to come out uniform), pass 2 rewrites.
// Pass 2's cursor opens SYNCHRONOUSLY from pass 1's last callback: IDB
// auto-commits once no request is outstanding, and a cursor opened from a
// promise continuation lands after that check and silently gets a
// TransactionInactiveError.
//
// A cursor, not getAll(): the catalog is 10k-100k rows of structured-cloneable
// file handles and a rename should not need to hold them all in memory at once.
//
// Known limit (deliberate): a case-ONLY rename ("wed" -> "Wed") is a no-op --
// both spellings are the same keyword under case-insensitive identity, so the
// rename merges into the existing spelling instead of re-casing it. The derived
// list shows one spelling either way.
export function renameKeywordAcrossCatalog(
  db: IDBDatabase,
  from: string,
  to: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const key = keywordKey(from);
    const target = normalizeKeyword(to);
    if (!key) {
      reject(new Error('Rename needs a keyword to look for'));
      return;
    }
    if (!target) {
      // Renaming to nothing is a DELETE, and silently deleting every photo's tag
      // from an edit box is not what an inline rename means. The UI must offer
      // remove explicitly (removeKeywordsFromFiles).
      reject(new Error(`Rename target "${to}" is empty once invalid characters are stripped`));
      return;
    }

    let tx: IDBTransaction;
    try {
      tx = db.transaction('files', 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore('files');
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('Keyword rename failed'));
    };
    let changed = 0;

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(changed);
    };
    tx.onabort = () => fail(tx.error ?? new Error('Keyword rename aborted'));
    tx.onerror = () => fail(tx.error ?? new Error('Keyword rename failed'));

    // Sequential cursor loop over every file row. `visit` sees each record with
    // its cursor (mutating the value alone is NOT enough -- IndexedDB persists
    // only what cursor.update() is handed) and returns false to stop the scan
    // early. `done` fires on exhaustion or early stop, always inside a cursor
    // callback, so a follow-up request opened there keeps the transaction alive.
    const scan = (
      visit: (record: FileRecord, cursor: IDBCursorWithValue) => boolean,
      done: () => void,
    ): void => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done();
          return;
        }
        if (visit(cursor.value as FileRecord, cursor)) cursor.continue();
        else done();
      };
      request.onerror = () => fail(request.error);
    };

    const targetKey = keywordKey(target);
    let display = target; // what pass 2 actually writes

    scan(
      (record) => {
        // Pass 1: keep scanning until an existing spelling of the target shows
        // up, then adopt it and stop -- every row ends on that one casing.
        if (targetKey === key) return false; // case-only rename: nothing to adopt
        const existing = (record.keywords ?? []).find((kw) => keywordKey(kw) === targetKey);
        if (existing) {
          display = existing;
          return false;
        }
        return true;
      },
      () => {
        scan(
          (record, cursor) => {
            const renamed = renameKeywordIn(record.keywords, key, display);
            if (renamed) {
              writeKeywords(record, renamed);
              changed += 1;
              cursor.update(record);
            }
            return true;
          },
          () => {
            /* pass 2 exhausted: the tx auto-commits and oncomplete resolves */
          },
        );
      },
    );
  });
}

// Mutates `record` in place and reports whether anything changed (the caller
// skips the write when it didn't, so a no-op Add click doesn't touch 5k rows).
function writeKeywords(record: FileRecord, keywords: string[]): boolean {
  const previous = record.keywords ?? [];
  const same =
    previous.length === keywords.length && previous.every((kw, i) => kw === keywords[i]);
  if (same) return false;
  if (keywords.length === 0) delete record.keywords;
  else record.keywords = keywords;
  return true;
}

// One readwrite transaction for the whole selection: opening a transaction per
// file would let a concurrent cull write interleave BETWEEN our get and put for
// another file, and costs a transaction setup per photo on a 500-photo selection.
// `mutate` returns true when the row needs writing.
function updateFiles(
  db: IDBDatabase,
  fileIds: readonly number[],
  mutate: (record: FileRecord) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fileIds.length === 0) {
      resolve();
      return;
    }
    let tx: IDBTransaction;
    try {
      tx = db.transaction('files', 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore('files');
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('Keyword write failed'));
    };

    for (const fileId of fileIds) {
      const getRequest = store.get(fileId);
      getRequest.onsuccess = () => {
        const record = getRequest.result as FileRecord | undefined;
        if (!record) {
          // Same contract as setCull: a file that vanished mid-write is an error,
          // not a silent skip -- the UI thinks it just tagged something.
          fail(new Error(`File ${fileId} not in catalog`));
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
          return;
        }
        if (mutate(record)) store.put(record);
      };
      getRequest.onerror = () => fail(getRequest.error);
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onabort = () => fail(tx.error ?? new Error('Keyword write aborted'));
    tx.onerror = () => fail(tx.error ?? new Error('Keyword write failed'));
  });
}
