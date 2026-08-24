export type ModuleId = 'library' | 'develop';

export interface AppState {
  module: ModuleId;
  selectedId: number | null;
}

export type StateListener = (state: AppState) => void;

const state: AppState = { module: 'library', selectedId: null };
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
// no-op (no notify).
export function selectFile(id: number): void {
  if (state.selectedId === id) return;
  state.selectedId = id;
  notify();
}

export function setModule(id: ModuleId): void {
  if (state.module === id) return;
  state.module = id;
  notify();
}
