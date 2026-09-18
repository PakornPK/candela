import { describe, it, expect, beforeEach } from 'vitest';
import { getState, subscribe, setSelection, setModule, type AppState } from './state';

describe('app state', () => {
  beforeEach(() => {
    setModule('library');
  });

  // Runs first in file order: the module singleton initializes to library
  // with no selection. No later test asserts the pristine initial state
  // again, so reordering past this one is safe.
  it('starts in library with no selection', () => {
    expect(getState()).toEqual({ module: 'library', selectedId: null, selectedIds: [] });
  });

  it('a single click sets id and selection together', () => {
    setSelection([42], 42);
    expect(getState().selectedId).toBe(42);
    expect(getState().selectedIds).toEqual([42]);
  });

  it('setSelection carries the multi-selection plus the reference (sync source)', () => {
    setSelection([11, 22, 33], 22);
    expect(getState().selectedIds).toEqual([11, 22, 33]);
    expect(getState().selectedId).toBe(22);
  });

  it('an open (plain click) collapses any multi-selection back to one file', () => {
    setSelection([11, 22, 33], 33);
    setSelection([44], 44); // openFile's collapse path
    expect(getState().selectedIds).toEqual([44]);
    expect(getState().selectedId).toBe(44);
  });

  it('setSelection always notifies, so a toggle that keeps the reference still repaints', () => {
    setSelection([5], 5);
    const seen: AppState[] = [];
    subscribe((s) => seen.push({ ...s }));
    setSelection([5, 6], 5); // reference unchanged, set grew -- must repaint
    expect(seen.length).toBe(1);
    expect(seen[0].selectedIds).toEqual([5, 6]);
  });

  it('setModule switches and notifies; same module is a no-op', () => {
    const seen: string[] = [];
    subscribe((s) => seen.push(s.module));
    setModule('develop');
    expect(getState().module).toBe('develop');
    setModule('develop');
    expect(seen).toEqual(['develop']);
  });

  it('unsubscribing stops notifications', () => {
    const seen: AppState[] = [];
    const unsubscribe = subscribe((s) => seen.push({ ...s }));
    unsubscribe();
    setSelection([9], 9);
    expect(seen.length).toBe(0);
  });
});
