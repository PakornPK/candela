import { describe, it, expect } from 'vitest';
import { duplicateKeyOf, findSuspectedDuplicates, type DuplicateKey } from './duplicates';

const D = 1_700_000_000_000; // a plausible DateTimeOriginal in ms

describe('duplicateKeyOf', () => {
  it('uses name + size + date when the date is known', () => {
    expect(duplicateKeyOf({ name: 'IMG_1.CR3', size: 10, dateTaken: D })).toBe('img_1.cr3|10|' + D);
  });

  it('lowercases the filename — case is a filesystem artifact, not identity', () => {
    expect(duplicateKeyOf({ name: 'IMG_1.CR3', size: 10, dateTaken: D })).toBe(
      duplicateKeyOf({ name: 'img_1.cr3', size: 10, dateTaken: D }),
    );
  });

  it('a key WITH a date can never equal a key WITHOUT one', () => {
    // The distinct-namespace requirement: size/date segments must not let
    // `name|size` alias into the dated form (e.g. a file literally named
    // "a|10|123.cr3" with no date vs. a dated one).
    const noDate = duplicateKeyOf({ name: 'a|10|123.cr3', size: 456 });
    const withDate = duplicateKeyOf({ name: 'a', size: 10, dateTaken: 123 });
    expect(noDate).not.toBe(withDate);
    // and the plain fallbacks differ from each other only in their own parts
    expect(duplicateKeyOf({ name: 'a.cr3', size: 1 })).not.toBe(duplicateKeyOf({ name: 'a.cr3', size: 2 }));
  });

  it('dateTaken of 0 (epoch) is treated as a known date, not as missing', () => {
    expect(duplicateKeyOf({ name: 'a', size: 1, dateTaken: 0 })).not.toBe(
      duplicateKeyOf({ name: 'a', size: 1 }),
    );
  });
});

describe('findSuspectedDuplicates', () => {
  it('an empty catalog keeps everything', () => {
    const incoming = [
      { name: 'a.cr3', size: 1, dateTaken: D },
      { name: 'b.cr3', size: 2, dateTaken: D },
    ];
    expect(findSuspectedDuplicates([], incoming)).toEqual({ duplicateIndexes: [], keptIndexes: [0, 1] });
  });

  it('an empty batch produces empty lists', () => {
    expect(findSuspectedDuplicates([{ name: 'a.cr3', size: 1 }], [])).toEqual({
      duplicateIndexes: [],
      keptIndexes: [],
    });
  });

  it('the same file twice (second copy of the folder) is a duplicate', () => {
    const existing: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 58_000_000, dateTaken: D }];
    const incoming: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 58_000_000, dateTaken: D }];
    expect(findSuspectedDuplicates(existing, incoming)).toEqual({
      duplicateIndexes: [0],
      keptIndexes: [],
    });
  });

  it('same name, different size: keep both — a re-shot frame writes different bytes', () => {
    const existing: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 58_000_000, dateTaken: D }];
    const incoming: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 58_000_001, dateTaken: D }];
    expect(findSuspectedDuplicates(existing, incoming).keptIndexes).toEqual([0]);
  });

  it('different name, same size and date: keep — identity includes the filename', () => {
    const existing: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 58_000_000, dateTaken: D }];
    const incoming: DuplicateKey[] = [{ name: 'IMG_4033.CR3', size: 58_000_000, dateTaken: D }];
    expect(findSuspectedDuplicates(existing, incoming).keptIndexes).toEqual([0]);
  });

  it('case difference alone still matches (macOS/Windows vs what the camera wrote)', () => {
    const existing: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 100, dateTaken: D }];
    const incoming: DuplicateKey[] = [{ name: 'img_4032.cr3', size: 100, dateTaken: D }];
    expect(findSuspectedDuplicates(existing, incoming).duplicateIndexes).toEqual([0]);
  });

  it('missing dateTaken on one side only does NOT match (distinct namespaces)', () => {
    // pre-P0-EXIF rows carry no date; a later dated import must not be
    // silently skipped as a "duplicate" of an undated row.
    const existing: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 100 }];
    const incoming: DuplicateKey[] = [{ name: 'IMG_4032.CR3', size: 100, dateTaken: D }];
    expect(findSuspectedDuplicates(existing, incoming)).toEqual({
      duplicateIndexes: [],
      keptIndexes: [0],
    });
  });

  it('missing dateTaken on BOTH sides does match', () => {
    const k: DuplicateKey = { name: 'IMG_4032.CR3', size: 100 };
    expect(findSuspectedDuplicates([k], [{ ...k }]).duplicateIndexes).toEqual([0]);
  });

  it('duplicates WITHIN the incoming batch are caught — only the first copy lands', () => {
    // The same card walked twice in one import (drag-drop + folder pick).
    const a: DuplicateKey = { name: 'A.CR2', size: 10, dateTaken: D };
    const incoming = [a, { name: 'B.CR2', size: 20 }, { ...a, name: 'a.cr2' }, { ...a }];
    expect(findSuspectedDuplicates([], incoming)).toEqual({
      duplicateIndexes: [2, 3],
      keptIndexes: [0, 1],
    });
  });

  it('index lists partition the batch and keptIndexes preserves order', () => {
    const incoming: DuplicateKey[] = [
      { name: 'x.cr3', size: 1, dateTaken: D },
      { name: 'x.cr3', size: 1, dateTaken: D },
      { name: 'y.cr3', size: 2, dateTaken: D },
      { name: 'x.cr3', size: 1, dateTaken: D },
    ];
    const r = findSuspectedDuplicates([], incoming);
    expect([...r.duplicateIndexes, ...r.keptIndexes].sort()).toEqual([0, 1, 2, 3]);
    expect(r.keptIndexes).toEqual([0, 2]);
    expect(r.duplicateIndexes).toEqual([1, 3]);
  });
});
