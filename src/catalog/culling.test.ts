import { describe, expect, it } from 'vitest';
import { applyCullResult } from './culling';
import type { FileRecord } from './types';

function record(extra: Partial<FileRecord> = {}): FileRecord {
  return { id: 1, name: 'a1.jpg', path: 'a1.jpg', folderId: 1, ...extra } as FileRecord;
}

describe('applyCullResult', () => {
  it('copies the saved marks onto the in-memory record', () => {
    const file = record();
    applyCullResult(file, record({ rating: 4, flag: true, color: 2 }));
    expect([file.rating, file.flag, file.color]).toEqual([4, true, 2]);
  });

  it('drops marks the store deleted, so a cleared rating stops painting stars', () => {
    const file = record({ rating: 5, flag: false, color: 3 });
    // setCull deletes cleared marks from the row it returns.
    applyCullResult(file, record());
    expect('rating' in file).toBe(false);
    expect('color' in file).toBe(false);
    expect('flag' in file).toBe(false);
  });

  it('keeps a mark that is still present when only another one is cleared', () => {
    const file = record({ rating: 2, color: 1 });
    applyCullResult(file, record({ rating: 2 }));
    expect(file.rating).toBe(2);
    expect('color' in file).toBe(false);
  });
});