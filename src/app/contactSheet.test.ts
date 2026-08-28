import { describe, it, expect } from 'vitest';
import { buildContactSheets, matchesContactCull, CONTACT_SHEET_SIZE } from './contactSheet';
import type { FileRecord } from '../catalog/types';

const F = (id: number, over: Partial<FileRecord> = {}): FileRecord => ({
  id, folderId: 1, path: `img${id}.cr3`, name: `img${id}.cr3`,
  handle: {} as FileSystemFileHandle, size: 0, lastModified: 0, ...over,
});

const NEUTRAL = { hideRejected: false, pickedOnly: false, minRating: 0 };

describe('matchesContactCull', () => {
  it('treats absent flag/rating as unflagged/unrated (never filtered)', () => {
    expect(matchesContactCull(F(1), { ...NEUTRAL, hideRejected: true })).toBe(true);
    expect(matchesContactCull(F(1), { ...NEUTRAL, pickedOnly: true })).toBe(false); // unflagged is not "picked"
    expect(matchesContactCull(F(1), { ...NEUTRAL, minRating: 3 })).toBe(false); // unrated < 3
  });
});

describe('buildContactSheets', () => {
  const roll = [F(1), F(2, { flag: false }), F(3, { flag: true }), F(4, { rating: 4 }), F(5, { flag: true, rating: 2 })];

  it('hideRejected drops flag === false only', () => {
    const sheets = buildContactSheets(roll, { ...NEUTRAL, hideRejected: true });
    expect(sheets[0].map((f) => f.id)).toEqual([1, 3, 4, 5]);
  });

  it('pickedOnly keeps only flag === true', () => {
    const sheets = buildContactSheets(roll, { ...NEUTRAL, pickedOnly: true });
    expect(sheets[0].map((f) => f.id)).toEqual([3, 5]);
  });

  it('minRating keeps rating >= threshold (unrated excluded)', () => {
    const sheets = buildContactSheets(roll, { ...NEUTRAL, minRating: 3 });
    expect(sheets[0].map((f) => f.id)).toEqual([4]);
  });

  it('chunks into sheets of CONTACT_SHEET_SIZE, overflow to a new sheet', () => {
    const big = Array.from({ length: CONTACT_SHEET_SIZE + 4 }, (_, i) => F(i + 1));
    const sheets = buildContactSheets(big, NEUTRAL);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toHaveLength(CONTACT_SHEET_SIZE);
    expect(sheets[1]).toHaveLength(4);
  });

  it('preserves scope order (path order = roll order)', () => {
    const sheets = buildContactSheets([F(9), F(1), F(5)], NEUTRAL);
    expect(sheets[0].map((f) => f.id)).toEqual([9, 1, 5]);
  });

  it('empty scope -> no sheets', () => {
    expect(buildContactSheets([], NEUTRAL)).toEqual([]);
  });
});
