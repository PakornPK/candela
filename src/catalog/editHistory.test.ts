import { describe, it, expect } from 'vitest';
import { createEditState, commitEdit, undo, redo, currentOps, MAX_HISTORY } from './editHistory';
import type { Op } from './types';

const exposure = (ev: number): Op[] => [{ kind: 'exposure', ev }];

describe('createEditState', () => {
  it('starts with one empty snapshot at cursor 0', () => {
    const state = createEditState();
    expect(state.history).toEqual([[]]);
    expect(state.cursor).toBe(0);
    expect(currentOps(state)).toEqual([]);
  });
});

describe('commitEdit', () => {
  it('appends a snapshot and moves the cursor to it', () => {
    const state = commitEdit(createEditState(), exposure(1));
    expect(state.history).toEqual([[], exposure(1)]);
    expect(state.cursor).toBe(1);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('drops the redo branch when committing after an undo', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = commitEdit(state, exposure(2));
    state = undo(state); // back to exposure(1)
    state = commitEdit(state, exposure(3));
    expect(state.history).toEqual([[], exposure(1), exposure(3)]);
    expect(state.cursor).toBe(2);
  });

  it('caps history at MAX_HISTORY entries, dropping the oldest', () => {
    let state = createEditState();
    for (let i = 1; i <= MAX_HISTORY + 10; i++) {
      state = commitEdit(state, exposure(i));
    }
    expect(state.history.length).toBe(MAX_HISTORY);
    expect(state.cursor).toBe(MAX_HISTORY - 1);
    expect(currentOps(state)).toEqual(exposure(MAX_HISTORY + 10));
    expect(state.history[0]).toEqual(exposure(11));
  });
});

describe('undo/redo', () => {
  it('undo moves the cursor back one snapshot', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = commitEdit(state, exposure(2));
    state = undo(state);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('undo at the oldest snapshot is a no-op', () => {
    const state = createEditState();
    expect(undo(state)).toEqual(state);
  });

  it('redo moves the cursor forward one snapshot', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    state = undo(state);
    state = redo(state);
    expect(currentOps(state)).toEqual(exposure(1));
  });

  it('redo at the newest snapshot is a no-op', () => {
    let state = createEditState();
    state = commitEdit(state, exposure(1));
    expect(redo(state)).toEqual(state);
  });
});
