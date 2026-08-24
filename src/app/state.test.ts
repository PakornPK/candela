import { describe, it, expect, beforeEach } from 'vitest';
import { getState, subscribe, selectFile, setModule, type AppState } from './state';

describe('app state', () => {
  beforeEach(() => {
    setModule('library');
  });

  // Runs first in file order: the module singleton initializes to library
  // with no selection. No later test asserts the pristine initial state
  // again, so reordering past this one is safe.
  it('starts in library with no selection', () => {
    expect(getState()).toEqual({ module: 'library', selectedId: null });
  });

  it('selectFile sets the id and notifies exactly once', () => {
    const seen: AppState[] = [];
    subscribe((s) => seen.push({ ...s }));
    selectFile(42);
    expect(getState().selectedId).toBe(42);
    expect(seen.length).toBe(1);
    expect(seen[0].selectedId).toBe(42);
  });

  it('selecting the same id again is a no-op', () => {
    selectFile(7);
    const seen: AppState[] = [];
    subscribe((s) => seen.push({ ...s }));
    selectFile(7);
    expect(seen.length).toBe(0);
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
    selectFile(9);
    expect(seen.length).toBe(0);
  });
});
