// Duplicate detection at import (gap analysis P1-8).
//
// `upsertFile` in import.ts dedupes only by folderId+path, so importing the
// same shoot from a second copy of a folder creates duplicate rows and
// inflates cull counts. LrC's "Don't Import Suspected Duplicates" instead
// matches on original filename + file size + EXIF capture time
// (https://helpx.adobe.com/lightroom-classic/help/photo-video-import-options.html).
//
// This is a standalone pure module: import.ts (being edited in parallel for
// EXIF) calls findSuspectedDuplicates() against its incoming file list before
// upserting, and skips the flagged rows. No IndexedDB, no DOM — testable in
// plain node.

export interface DuplicateKey {
  name: string; // original filename, e.g. "IMG_4032.CR3"
  size: number; // bytes
  dateTaken?: number; // EXIF DateTimeOriginal, ms epoch; absent until P0-1 lands
}

// LrC's identity: name + size + capture time. When dateTaken is missing the
// fallback lives in a DISTINCT namespace ('~' suffix segment) so a key
// computed with a date can never collide with one computed without it —
// otherwise a pre-EXIF row (no date) could "match" a post-EXIF import of a
// re-shot frame that happens to share name+size, silently skipping real
// photos. Exactness beats recall here: a false "duplicate" loses an import.
//
// Filenames are lowercased: macOS and Windows volumes preserve or fold case
// differently from what the camera actually wrote (Canon writes IMG_4032.CR3,
// a case-insensitive copy pass can produce img_4032.cr3), and the camera's
// own name is the identity being matched — case is an artifact of the
// filesystem it passed through. Size and date stay exact.
export function duplicateKeyOf(k: DuplicateKey): string {
  const name = k.name.toLowerCase();
  return k.dateTaken !== undefined
    ? `${name}|${k.size}|${k.dateTaken}`
    : `${name}|${k.size}|~`;
}

export interface DuplicateReport {
  // Indexes into `incoming` of rows that look already-imported — the caller
  // skips upserting these.
  duplicateIndexes: number[];
  // Everything else, in incoming order.
  keptIndexes: number[];
}

// `existing` is what the catalog already holds (one DuplicateKey per row —
// import.ts maps its FileRecords), `incoming` the proposed batch. A row
// matching anything in `existing` is a duplicate; a row matching an EARLIER
// KEPT row of `incoming` is also a duplicate, because the same card can be
// walked twice in one import (drag-drop plus folder pick) and only one copy
// should land.
export function findSuspectedDuplicates(
  existing: DuplicateKey[],
  incoming: DuplicateKey[],
): DuplicateReport {
  const seen = new Set<string>();
  for (const e of existing) seen.add(duplicateKeyOf(e));

  const duplicateIndexes: number[] = [];
  const keptIndexes: number[] = [];
  incoming.forEach((k, i) => {
    const key = duplicateKeyOf(k);
    if (seen.has(key)) {
      duplicateIndexes.push(i);
    } else {
      seen.add(key); // first kept copy claims the key for later rows
      keptIndexes.push(i);
    }
  });
  return { duplicateIndexes, keptIndexes };
}
