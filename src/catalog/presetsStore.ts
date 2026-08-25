import type { Op } from './types';
import { isValidOp } from './editsStore';

// A named snapshot of an op chain. Saved by the user; applying merges the
// stored ops into the current state by kind (see main.ts), so a preset never
// clobbers adjustments it doesn't cover.
export interface PresetRow {
  id?: number; // auto-increment key; absent on unsaved rows
  name: string;
  ops: Op[];
  createdAt: number;
}

export function listPresets(db: IDBDatabase): Promise<PresetRow[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('presets', 'readonly').objectStore('presets').getAll();
    request.onsuccess = () => {
      // A corrupt/stale row (future schema, external damage) is dropped, not
      // fatal -- same defensive stance as editsStore.isValidEditRow.
      const rows = (request.result as unknown[]).filter(isValidPresetRow) as PresetRow[];
      rows.sort((a, b) => b.createdAt - a.createdAt); // newest first
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

export function savePreset(db: IDBDatabase, name: string, ops: Op[]): Promise<number> {
  const row: PresetRow = { name, ops, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    const request = db.transaction('presets', 'readwrite').objectStore('presets').add(row);
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
  });
}

export function deletePreset(db: IDBDatabase, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('presets', 'readwrite').objectStore('presets').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function isValidPresetRow(row: unknown): row is PresetRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as PresetRow;
  return (
    typeof r.name === 'string' &&
    r.name.length > 0 &&
    Array.isArray(r.ops) &&
    r.ops.every(isValidOp) &&
    Number.isFinite(r.createdAt)
  );
}
