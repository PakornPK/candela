export type ModuleId = 'library' | 'develop' | 'contact';

export interface AppState {
  module: ModuleId;
  selectedId: number | null;
  selectedIds: number[];
}

export type StateListener = (state: AppState) => void;

const state: AppState = { module: 'library', selectedId: null, selectedIds: [] };
const listeners = new Set<StateListener>();

export function getState(): AppState {
  return state;
}

export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener(state);
}

// The single mutation path for file selection: grid clicks, filmstrip
// clicks, and the arrow keys all go through here so they can never
// disagree about which file is selected. Re-selecting the same id is a
// no-op (no notify). Single select collapses any multi-selection.
export function selectFile(id: number): void {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.selectedIds = [id];
  notify();
}

// Multi-selection (ctrl/cmd+click, shift+click range, and bulk cull/sync
// actions). `reference` is the active id -- the photo LrC would sync *from*.
// Unlike selectFile this always notifies, because toggle-in/toggle-out must
// repaint even when the set changed without the reference changing.
export function setSelection(ids: number[], reference: number | null): void {
  state.selectedIds = ids;
  state.selectedId = reference;
  notify();
}

export function setModule(id: ModuleId): void {
  if (state.module === id) return;
  state.module = id;
  notify();
}
