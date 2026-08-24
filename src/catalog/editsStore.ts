import type { EditState } from './types';
import { createEditState } from './editHistory';

interface EditRow {
  fileId: number;
  history: EditState['history'];
  cursor: number;
}

export function loadEditState(db: IDBDatabase, fileId: number): Promise<EditState> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('edits', 'readonly').objectStore('edits').get(fileId);
    request.onsuccess = () => {
      const row = request.result;
      resolve(isValidEditRow(row) ? { history: row.history, cursor: row.cursor } : createEditState());
    };
    request.onerror = () => reject(request.error);
  });
}

// A stored row could be corrupt or stale (e.g. from a future schema
// version, or damaged by something outside this app's control) --
// editHistory.ts's undo()/redo()/currentOps() all assume
// `0 <= cursor < history.length` unconditionally and don't re-check it,
// so this is the one place that needs to validate before trusting a
// loaded row. Falling back to a fresh EditState is safe: worst case, a
// corrupt row loses its undo history, not the app.
//
// Takes `unknown` and returns a type predicate so the type system
// actually depends on every check below -- deleting one is a real,
// meaningful behavior change the type checker can't silently absorb.
function isValidEditRow(row: unknown): row is EditRow {
  if (typeof row !== 'object' || row === null) return false;
  const candidate = row as EditRow;
  return (
    Array.isArray(candidate.history) &&
    candidate.history.length > 0 &&
    candidate.history.every((snapshot) => Array.isArray(snapshot)) &&
    Number.isInteger(candidate.cursor) &&
    candidate.cursor >= 0 &&
    candidate.cursor < candidate.history.length
  );
}

export function saveEditState(db: IDBDatabase, fileId: number, state: EditState): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: EditRow = { fileId, history: state.history, cursor: state.cursor };
    const request = db.transaction('edits', 'readwrite').objectStore('edits').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
