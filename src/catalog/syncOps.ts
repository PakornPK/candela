import type { Op } from './types';

// Lightroom-style Sync with DELTA semantics (user spec 2026-09-18): the
// source photo's edits are what it CHANGED since import, and a sync applies
// that change on top of each target's own values -- edit 5500K -> 6500K syncs
// "+1000" to every target (each keeps its own starting point), not the
// absolute 6500K. Kinds where a delta is meaningless (a tone curve's points,
// a crop rect, a film stock, a painted mask) copy absolutely instead.
//
// The reference's baseline is its history[0] snapshot (as-imported), so an
// untouched field produces a zero delta and never touches the target.

// Slider neutral values (index.html defaults) -- the fallback baseline when
// a photo's history[0] predates an op kind entirely. 'highlights'/'amount'
// repeat across kinds, so fields live per kind.
type Fields = Record<string, [neutral: number, min: number, max: number]>;

const DELTA_KINDS: Partial<Record<Op['kind'], Fields>> = {
  exposure: { ev: [0, -5, 5] },
  whiteBalance: { kelvin: [5500, 2000, 50000], tint: [0, -150, 150] },
  tone: {
    contrast: [0, -100, 100],
    highlights: [0, -100, 100],
    shadows: [0, -100, 100],
    whites: [0, -100, 100],
    blacks: [0, -100, 100],
  },
  presence: {
    texture: [0, -100, 100],
    clarity: [0, -100, 100],
    dehaze: [0, -100, 100],
    vibrance: [0, -100, 100],
    saturation: [0, -100, 100],
  },
  vignette: {
    amount: [0, -100, 100],
    midpoint: [50, 0, 100],
    roundness: [0, -100, 100],
    feather: [50, 0, 100],
    highlights: [0, 0, 100],
  },
};

// The delta kinds -- exported so the caller can split absolute kinds out.
export const DELTA_OP_KINDS = Object.keys(DELTA_KINDS) as Op['kind'][];

// The ops to merge into one target: for every delta kind present in the
// (already module-filtered) source set, the target's current value + the
// source's change since import. Kinds the source never changed produce
// nothing. Non-delta kinds (curve/crop/frame/...) are copied absolutely by
// the caller's merge and are skipped here.
export function syncDeltaOps(refBase: Op[], refPicked: Op[], targetNow: Op[]): Op[] {
  const baseByKind = new Map(refBase.map((o) => [o.kind, o]));
  const targetByKind = new Map(targetNow.map((o) => [o.kind, o]));
  const out: Op[] = [];
  for (const op of refPicked) {
    const fields = DELTA_KINDS[op.kind];
    if (!fields) continue;
    const srcObj = op as unknown as Record<string, number>;
    const baseObj = (baseByKind.get(op.kind) ?? {}) as unknown as Record<string, number>;
    const tgtObj = (targetByKind.get(op.kind) ?? {}) as unknown as Record<string, number>;
    const merged: Record<string, number> = { ...tgtObj };
    let changed = false;
    for (const [field, [neutral, min, max]] of Object.entries(fields)) {
      const delta = (srcObj[field] ?? neutral) - (baseObj[field] ?? neutral);
      if (delta === 0) continue; // the source never touched this field
      const tgt = tgtObj[field] ?? neutral;
      merged[field] = Math.min(max, Math.max(min, tgt + delta));
      changed = true;
    }
    if (changed) out.push({ kind: op.kind, ...merged } as unknown as Op);
  }
  return out;
}
