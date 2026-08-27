import type { EditState, Op } from './types';
import { createEditState } from './editHistory';
import { isFilmStockId } from '../gpu/film';

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
export function isValidEditRow(row: unknown): row is EditRow {
  if (typeof row !== 'object' || row === null) return false;
  const candidate = row as EditRow;
  return (
    Array.isArray(candidate.history) &&
    candidate.history.length > 0 &&
    candidate.history.every((snapshot) => Array.isArray(snapshot) && snapshot.every(isValidOp)) &&
    Number.isInteger(candidate.cursor) &&
    candidate.cursor >= 0 &&
    candidate.cursor < candidate.history.length
  );
}

// Guards the contents of each history snapshot, not just its shape --
// isExposureOp/isWhiteBalanceOp in types.ts dereference `op.kind`
// unconditionally and assume they're only ever called on real Ops, so
// this is the one place that needs to check that assumption before a
// stored row is trusted.
export function isValidOp(op: unknown): op is Op {
  if (typeof op !== 'object' || op === null) return false;
  const candidate = op as { kind?: unknown };
  if (candidate.kind === 'profile') {
    const p = (op as { profile?: unknown }).profile;
    return p === 'camera' || p === 'neutral' || isFilmStockId(p);
  }
  if (candidate.kind === 'exposure') {
    return typeof (op as { ev?: unknown }).ev === 'number';
  }
  if (candidate.kind === 'whiteBalance') {
    // `tint` optional: rows saved before the tint slider existed are valid.
    // `gains` optional: only present on As-Shot WB rows (exact camera gains).
    const wb = op as { kelvin?: unknown; tint?: unknown; gains?: unknown };
    const g = wb.gains as { r?: unknown; g?: unknown; b?: unknown } | undefined;
    const gainsOk =
      wb.gains === undefined ||
      (typeof wb.gains === 'object' && wb.gains !== null &&
        typeof g?.r === 'number' && typeof g?.g === 'number' && typeof g?.b === 'number');
    return typeof wb.kelvin === 'number' && (wb.tint === undefined || typeof wb.tint === 'number') && gainsOk;
  }
  if (candidate.kind === 'tone') {
    const t = op as { contrast?: unknown; highlights?: unknown; shadows?: unknown; whites?: unknown; blacks?: unknown };
    return [t.contrast, t.highlights, t.shadows, t.whites, t.blacks].every((v) => typeof v === 'number');
  }
  if (candidate.kind === 'toneCurve') {
    const c = op as { mode?: unknown; points?: unknown; highlights?: unknown; lights?: unknown; darks?: unknown; shadows?: unknown };
    if (c.mode === 'region') {
      return [c.highlights, c.lights, c.darks, c.shadows].every((v) => typeof v === 'number');
    }
    // `mode: 'point'` rows and pre-mode legacy rows carry a flat [x,y] list.
    return (
      Array.isArray(c.points) &&
      c.points.length > 0 &&
      c.points.length % 2 === 0 &&
      c.points.every((v) => typeof v === 'number')
    );
  }
  if (candidate.kind === 'presence') {
    const pr = op as { texture?: unknown; clarity?: unknown; dehaze?: unknown; vibrance?: unknown; saturation?: unknown };
    return [pr.texture, pr.clarity, pr.dehaze, pr.vibrance, pr.saturation].every((v) => typeof v === 'number');
  }
  if (candidate.kind === 'vignette') {
    const v = op as { amount?: unknown; midpoint?: unknown; roundness?: unknown; feather?: unknown; highlights?: unknown };
    return [v.amount, v.midpoint, v.roundness, v.feather, v.highlights].every((x) => typeof x === 'number');
  }
  if (candidate.kind === 'bw') {
    const b = op as { mix?: unknown; tone?: unknown };
    const isBwTone = (t: unknown) => t === 'none' || t === 'acros' || t === 'tx400' || t === 'doublex' || t === 'leica';
    return (
      Array.isArray(b.mix) && b.mix.length === 8 && b.mix.every((v) => typeof v === 'number') && isBwTone(b.tone)
    );
  }
  if (candidate.kind === 'grain') {
    const g = op as { amount?: unknown; size?: unknown; roughness?: unknown };
    return [g.amount, g.size, g.roughness].every((v) => typeof v === 'number');
  }
  if (candidate.kind === 'lightleak') {
    const l = op as { amount?: unknown; hue?: unknown };
    return [l.amount, l.hue].every((v) => typeof v === 'number');
  }
  if (candidate.kind === 'frame') {
    const s = (op as { style?: unknown }).style;
    return s === 'none' || s === '135' || s === '120' || s === 'print';
  }
  return false;
}

export function saveEditState(db: IDBDatabase, fileId: number, state: EditState): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: EditRow = { fileId, history: state.history, cursor: state.cursor };
    const request = db.transaction('edits', 'readwrite').objectStore('edits').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
