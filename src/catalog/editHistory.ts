import type { Op, EditState } from './types';

export const MAX_HISTORY = 50;

export function createEditState(): EditState {
  return { history: [[]], cursor: 0 };
}

export function currentOps(state: EditState): Op[] {
  return state.history[state.cursor];
}

export function commitEdit(state: EditState, ops: Op[]): EditState {
  const truncated = state.history.slice(0, state.cursor + 1); // drop any redo branch
  const history = [...truncated, ops];
  const overflow = history.length - MAX_HISTORY;
  const trimmed = overflow > 0 ? history.slice(overflow) : history;
  return { history: trimmed, cursor: trimmed.length - 1 };
}

export function undo(state: EditState): EditState {
  if (state.cursor === 0) return state;
  return { ...state, cursor: state.cursor - 1 };
}

export function redo(state: EditState): EditState {
  if (state.cursor === state.history.length - 1) return state;
  return { ...state, cursor: state.cursor + 1 };
}
