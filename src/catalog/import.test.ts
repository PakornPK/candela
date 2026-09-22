import { describe, it, expect } from 'vitest';
import { createDuplicateGate, duplicateKeyForRow, mergeFileRow, shouldIdentify } from './import';
import { duplicateKeyOf } from './duplicates';
import { exifToRecordFields } from '../raw/exif';
import type { ExifIdentify } from '../raw/exif';
import type { FileRecord } from './types';

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
