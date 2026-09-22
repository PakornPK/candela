import { describe, expect, it } from 'vitest';
import {
  classifyHandleError,
  matchByBasename,
  missingBadgeTitle,
  type MatchMap,
} from './missing';
import type { FileRecord } from './types';

// The handle is never touched by anything tested here, so a stub cast is the
// cheapest honest FileRecord (same pattern as smartCollections.test.ts).
function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 1,
    folderId: 1,
    path: 'day1/DSCF8946.RAF',
    name: 'DSCF8946.RAF',
    handle: {} as FileSystemFileHandle,
    size: 1,
    lastModified: 0,
    ...overrides,
  };
}

describe('classifyHandleError', () => {
  it('maps NotFoundError to notfound (moved/renamed/volume gone)', () => {
    expect(classifyHandleError(new DOMException('gone', 'NotFoundError'))).toBe('notfound');
  });

  it('maps NotAllowedError to denied, which is the restore banner\'s case, NOT missing', () => {
    // A reload revokes every File System Access grant, so every unreadable
    // file throws this. If it ever counted as missing, one F5 would badge the
    // whole catalog broken.
    expect(classifyHandleError(new DOMException('no perm', 'NotAllowedError'))).toBe('denied');
  });

  it('maps any other DOMException to unreadable', () => {
    expect(classifyHandleError(new DOMException('disk died', 'IOError'))).toBe('unreadable');
    expect(classifyHandleError(new Error('plain Error'))).toBe('unreadable');
  });

  it('survives non-exception throws without crashing', () => {
    expect(classifyHandleError('a string')).toBe('unreadable');
    expect(classifyHandleError(null)).toBe('unreadable');
    expect(classifyHandleError(undefined)).toBe('unreadable');
    // Duck-typed on .name, so a foreign-realm/lookalike object classifies too.
    expect(classifyHandleError({ name: 'NotFoundError' })).toBe('notfound');
  });
});

describe('missingBadgeTitle', () => {
  it('names the file and promises the edits survived', () => {
    const title = missingBadgeTitle('DSCF8946.RAF');
    expect(title).toContain('DSCF8946.RAF');
    expect(title).toContain('edits are safe');
    expect(title).toContain('relink');
  });
});

describe('matchByBasename', () => {
  it('matches on the exact basename', () => {
    const map: MatchMap = matchByBasename([file({ id: 7 })], ['DSCF8946.RAF', 'other.jpg']);
    expect(map.get(7)).toBe('DSCF8946.RAF');
  });

  it('ignores case (exFAT/APFS/NTFS resolve names case-insensitively)', () => {
    expect(matchByBasename([file({ id: 1, name: 'DSCF8946.RAF' })], ['dscf8946.raf']).get(1)).toBe(
      'dscf8946.raf',
    );
    expect(matchByBasename([file({ id: 1, name: 'dscf8946.raf' })], ['DSCF8946.RAF']).get(1)).toBe(
      'DSCF8946.RAF',
    );
  });

  it('never matches across extensions — a .RAF and its .jpg sibling are different files', () => {
    expect(matchByBasename([file({ id: 1, name: 'IMG_0001.RAF' })], ['IMG_0001.jpg']).size).toBe(0);
    expect(matchByBasename([file({ id: 1, name: 'IMG_0001' })], ['IMG_0001.raf']).size).toBe(0);
  });

  it('leaves a file with no candidate out of the map', () => {
    const map = matchByBasename([file({ id: 1 })], ['DSCF0001.RAF', 'readme.txt']);
    expect(map.has(1)).toBe(false);
    expect(map.size).toBe(0);
  });

  it('first match wins: one entry cannot be claimed by two records', () => {
    // Two catalog rows sharing a name (two subfolders merged into one picked
    // directory): the earlier row gets the entry, the later stays missing for
    // a hand Locate — documented in matchByBasename.
    const map = matchByBasename(
      [file({ id: 1, name: 'IMG_5.RAF' }), file({ id: 2, name: 'img_5.raf' })],
      ['IMG_5.RAF'],
    );
    expect(map.get(1)).toBe('IMG_5.RAF');
    expect(map.has(2)).toBe(false);
  });
});
