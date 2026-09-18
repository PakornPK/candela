import { describe, expect, it } from 'vitest';
import type { Op } from './types';
import { DELTA_OP_KINDS, syncDeltaOps } from './syncOps';

const wb = (kelvin: number, tint = 0): Op => ({ kind: 'whiteBalance', kelvin, tint });
const tone = (contrast: number, blacks = 0): Op => ({
  kind: 'tone', contrast, highlights: 0, shadows: 0, whites: 0, blacks,
});

describe('syncDeltaOps (LrC delta semantics)', () => {
  it('applies the source CHANGE onto the target value, not the source value', () => {
    // Source: 5500 -> 6500 (+1000). Target has its own 7000. Sync => 8000.
    const ops = syncDeltaOps([wb(5500)], [wb(6500)], [wb(7000)]);
    expect(ops).toEqual([wb(8000, 0)]);
  });

  it('an untouched source field contributes nothing', () => {
    // Source only changed tint; the target keeps its own kelvin.
    const ops = syncDeltaOps([wb(5500, 0)], [wb(5500, 20)], [wb(7000, -5)]);
    expect(ops).toEqual([wb(7000, 15)]);
  });

  it('falls back to slider neutrals when history[0] predates the kind', () => {
    // Source baseline has no WB op at all: 5500 neutral -> 6500 = +1000 delta
    // onto a target with no WB op = target starts from neutral too. Untouched
    // fields stay absent (the renderer reads their neutral for a missing op).
    const ops = syncDeltaOps([], [wb(6500)], []);
    expect(ops).toEqual([{ kind: 'whiteBalance', kelvin: 6500 }]);
  });

  it('per-field deltas on a multi-field op (contrast moved, blacks not)', () => {
    const ops = syncDeltaOps(
      [tone(0, -20)],
      [tone(30, -20)],
      [tone(-10, 40)],
    );
    expect(ops).toEqual([tone(20, 40)]); // contrast -10 + 30; blacks untouched by source
  });

  it('clamps into the slider range', () => {
    const ops = syncDeltaOps([tone(0)], [tone(90)], [tone(50)]);
    expect(ops).toEqual([tone(100)]); // 140 clamped to the 100 range
  });

  it('non-delta kinds produce nothing (caller copies them absolutely)', () => {
    const curve: Op = { kind: 'toneCurve', mode: 'point', points: [0, 0, 0.5, 0.6, 1, 1] };
    expect(syncDeltaOps([], [curve], [])).toEqual([]);
  });

  it('delta kinds cover the slider-backed ops', () => {
    expect(DELTA_OP_KINDS).toEqual(
      expect.arrayContaining(['exposure', 'whiteBalance', 'tone', 'presence', 'vignette']),
    );
    expect(DELTA_OP_KINDS).not.toContain('crop');
    expect(DELTA_OP_KINDS).not.toContain('toneCurve');
  });
});
