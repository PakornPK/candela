import { describe, it, expect } from 'vitest';
import {
  autoStackByCaptureTime,
  visibleFiles,
  stackCountFor,
  toggleStackCollapsed,
  unstack,
  addToStack,
  type Stack,
} from './stacks';
import type { FileRecord } from '../catalog/types';

const F = (id: number, over: Partial<FileRecord> = {}): FileRecord => ({
  id,
  folderId: 1,
  path: `day1/img${id}.cr3`,
  name: `img${id}.cr3`,
  handle: {} as FileSystemFileHandle,
  size: 0,
  lastModified: 0,
  ...over,
});

// seconds -> ms epoch for readable fixtures
const T = (sec: number) => Date.UTC(2024, 0, 1) + sec * 1000;

describe('autoStackByCaptureTime', () => {
  it('groups consecutive shots whose gap is <= threshold, in one stack', () => {
    const files = [F(1, { dateTaken: T(0) }), F(2, { dateTaken: T(3) }), F(3, { dateTaken: T(6) })];
    const stacks = autoStackByCaptureTime(files, 5);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].fileIds).toEqual([1, 2, 3]);
    expect(stacks[0].collapsed).toBe(true); // LrC auto-stacks collapsed
  });

  it('the threshold is inclusive (gap EXACTLY at threshold stays together)', () => {
    const files = [F(1, { dateTaken: T(0) }), F(2, { dateTaken: T(5) })];
    expect(autoStackByCaptureTime(files, 5)[0].fileIds).toEqual([1, 2]);
  });

  it('one second over the threshold splits into two groups', () => {
    const files = [F(1, { dateTaken: T(0) }), F(2, { dateTaken: T(6) })];
    const stacks = autoStackByCaptureTime(files, 5);
    expect(stacks).toHaveLength(0); // singles are not stacks
  });

  it('splits a run at each over-gap boundary', () => {
    const files = [
      F(1, { dateTaken: T(0) }),
      F(2, { dateTaken: T(2) }), // burst A
      F(3, { dateTaken: T(600) }),
      F(4, { dateTaken: T(601) }), // burst B
      F(5, { dateTaken: T(900) }), // lonely frame
    ];
    const stacks = autoStackByCaptureTime(files, 5);
    expect(stacks.map((s) => s.fileIds)).toEqual([[1, 2], [3, 4]]);
  });

  it('a lonely file never becomes a stack', () => {
    const stacks = autoStackByCaptureTime([F(1, { dateTaken: T(0) })], 3600);
    expect(stacks).toEqual([]);
  });

  it('all-identical timestamps collapse into ONE stack (fast bracketing)', () => {
    const files = [1, 2, 3, 4].map((i) => F(i, { dateTaken: T(100) }));
    const stacks = autoStackByCaptureTime(files, 0); // even a 0s gap keeps ties
    expect(stacks).toHaveLength(1);
    expect(stacks[0].fileIds).toEqual([1, 2, 3, 4]);
  });

  it('a file with no dateTaken is never stacked — mtime fallback would merge unrelated shoots', () => {
    const files = [
      F(1, { dateTaken: T(0), lastModified: T(0) }),
      F(2, { lastModified: T(0) }), // imported same day as everything else: no EXIF
      F(3, { dateTaken: T(1) }),
    ];
    const stacks = autoStackByCaptureTime(files, 5);
    // 1 and 3 still group; the EXIF-less 2 is NOT dragged in via lastModified.
    expect(stacks).toHaveLength(1);
    expect(stacks[0].fileIds).toEqual([1, 3]);
  });

  it('missing timestamps interleaved do not bridge two bursts', () => {
    const files = [
      F(1, { dateTaken: T(0) }),
      F(2, { dateTaken: T(1) }),
      F(3), // no date, sits in the middle of the list
      F(4, { dateTaken: T(600) }),
      F(5, { dateTaken: T(601) }),
    ];
    const stacks = autoStackByCaptureTime(files, 5);
    expect(stacks.map((s) => s.fileIds)).toEqual([[1, 2], [4, 5]]);
  });

  it('unsorted input is sorted by capture time first', () => {
    const files = [
      F(3, { dateTaken: T(6) }),
      F(1, { dateTaken: T(0) }),
      F(2, { dateTaken: T(3) }),
    ];
    const stacks = autoStackByCaptureTime(files, 5);
    // Members run in TIME order, which is also the LrC top-of-stack rule.
    expect(stacks[0].fileIds).toEqual([1, 2, 3]);
  });

  it('never mutates the caller array', () => {
    const files = [
      F(2, { dateTaken: T(1) }),
      F(1, { dateTaken: T(0) }),
    ];
    const before = files.map((f) => f.id);
    autoStackByCaptureTime(files, 5);
    expect(files.map((f) => f.id)).toEqual(before);
  });

  it('stack ids are unique per group', () => {
    const files = [
      F(1, { dateTaken: T(0) }),
      F(2, { dateTaken: T(1) }),
      F(3, { dateTaken: T(600) }),
      F(4, { dateTaken: T(601) }),
    ];
    const stacks = autoStackByCaptureTime(files, 5);
    const idSet = new Set(stacks.map((s) => s.id));
    expect(idSet.size).toBe(stacks.length);
  });
});

describe('visibleFiles', () => {
  const files = [F(1), F(2), F(3), F(4), F(5), F(6)];
  const stacked: Stack[] = [
    { id: 's1', fileIds: [2, 3, 4], collapsed: true },
    { id: 's2', fileIds: [5, 6], collapsed: false },
  ];

  it('collapsed shows ONLY the top, at the top member’s position; expanded shows all members adjacently', () => {
    const out = visibleFiles(files, stacked);
    expect(out.map((f) => f.id)).toEqual([1, 2, 5, 6]); // 3,4 hidden by collapse
  });

  it('collapsed hides members even when the top appears late in file order', () => {
    const s: Stack[] = [{ id: 'x', fileIds: [5, 1, 2], collapsed: true }];
    const out = visibleFiles(files, s);
    expect(out.map((f) => f.id)).toEqual([3, 4, 5, 6]); // top=5 keeps its slot; 1,2 hidden
  });

  it('an expanded stack stays adjacent even if the catalog scattered its members', () => {
    const s: Stack[] = [{ id: 'x', fileIds: [6, 1, 3], collapsed: false }];
    const out = visibleFiles(files, s);
    // The TOP (6) anchors the group at its own position; 1 and 3 are pulled
    // up next to it in stack order, and pass-through files fill the rest.
    expect(out.map((f) => f.id)).toEqual([2, 4, 5, 6, 1, 3]);
  });

  it('unstacked files pass through in catalog order', () => {
    expect(visibleFiles(files, []).map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a stack with no files present is ignored', () => {
    const s: Stack[] = [{ id: 'ghost', fileIds: [97, 98, 99], collapsed: true }];
    expect(visibleFiles(files, s).map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a stack whose top was removed from the catalog promotes the next member', () => {
    const s: Stack[] = [{ id: 'x', fileIds: [3, 4], collapsed: true }];
    const without3 = files.filter((f) => f.id !== 3);
    expect(visibleFiles(without3, s).map((f) => f.id)).toEqual([1, 2, 4, 5, 6]);
  });
});

describe('stackCountFor', () => {
  const stacks: Stack[] = [{ id: 's1', fileIds: [7, 8, 9], collapsed: true }];
  it('every member reports the full member count (the badge LrC shows)', () => {
    expect(stackCountFor(7, stacks)).toBe(3);
    expect(stackCountFor(9, stacks)).toBe(3);
  });
  it('0 for a file not in any stack', () => {
    expect(stackCountFor(1, stacks)).toBe(0);
    expect(stackCountFor(7, [])).toBe(0);
  });
});

describe('immutable stack editors', () => {
  const stacks: Stack[] = [
    { id: 'a', fileIds: [1, 2], collapsed: true },
    { id: 'b', fileIds: [3, 4, 5], collapsed: false },
  ];
  const snapshot = () => JSON.parse(JSON.stringify(stacks)) as Stack[];

  it('toggleStackCollapsed flips only the target; input untouched', () => {
    const out = toggleStackCollapsed(stacks, 'a');
    expect(out[0].collapsed).toBe(false);
    expect(out[1]).toBe(stacks[1]); // sibling stack is the SAME object (no churn)
    expect(stacks[0].collapsed).toBe(true);
    expect(out).not.toBe(stacks);
    // toggling back restores
    expect(toggleStackCollapsed(out, 'a')[0].collapsed).toBe(true);
    expect(toggleStackCollapsed(stacks, 'unknown')).toEqual(snapshot());
  });

  it('unstack dissolves one stack and keeps the other', () => {
    const out = unstack(stacks, 'a');
    expect(out.map((s) => s.id)).toEqual(['b']);
    expect(stacks).toHaveLength(2);
  });

  it('addToStack appends, leaves the input untouched', () => {
    const out = addToStack(stacks, 'a', 6);
    expect(out[0].fileIds).toEqual([1, 2, 6]);
    expect(stacks[0].fileIds).toEqual([1, 2]);
  });

  it('addToStack ENFORCES one-stack-per-file: it is removed from its old stack', () => {
    const out = addToStack(stacks, 'a', 4); // 4 moves b -> a
    expect(out.find((s) => s.id === 'a')!.fileIds).toEqual([1, 2, 4]);
    expect(out.find((s) => s.id === 'b')!.fileIds).toEqual([3, 5]);
    const noDouble = out.some((s) => s.fileIds.filter((id) => id === 4).length > 1);
    expect(noDouble).toBe(false);
    // And the invariant holds across a move that would empty the source:
    const two: Stack[] = [
      { id: 'x', fileIds: [1, 2], collapsed: false },
      { id: 'y', fileIds: [3], collapsed: false },
    ];
    const moved = addToStack(two, 'x', 3); // 3 was the only member of y
    expect(moved.map((s) => s.id)).toEqual(['x']); // y dissolved, no one-photo shell
    expect(moved[0].fileIds).toEqual([1, 2, 3]);
  });

  it('addToStack is idempotent when the file is already a member', () => {
    const out = addToStack(stacks, 'b', 4);
    expect(out).toBe(stacks); // same array: nothing to do
  });

  it('addToStack with an unknown stack id is a no-op', () => {
    expect(addToStack(stacks, 'zzz', 9)).toBe(stacks);
  });

  it('moving a file out of a 2-stack dissolves the source into nothing, not a singleton', () => {
    const pair: Stack[] = [{ id: 'p', fileIds: [1, 2], collapsed: false }];
    const withTarget: Stack[] = [...pair, { id: 'q', fileIds: [7, 8], collapsed: false }];
    const out = addToStack(withTarget, 'q', 2);
    expect(out.map((s) => s.id)).toEqual(['q']);
    expect(out[0].fileIds).toEqual([7, 8, 2]);
    expect(withTarget[0].fileIds).toEqual([1, 2]); // input untouched
  });
});
