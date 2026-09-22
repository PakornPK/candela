import { describe, expect, it } from 'vitest';
import { developedRenderNeeded, opDigest } from './thumbnails';
import type { Op } from './types';

const ops = (...ops: Op[]): Op[] => ops;

describe('opDigest', () => {
  it('is stable for identical chains', () => {
    const a = ops({ kind: 'exposure', ev: 0.5 }, { kind: 'whiteBalance', kelvin: 6200, tint: 12 });
    const b = ops({ kind: 'exposure', ev: 0.5 }, { kind: 'whiteBalance', kelvin: 6200, tint: 12 });
    expect(opDigest(a)).toBe(opDigest(b));
  });

  it('changes when a single numeric field changes', () => {
    const base = ops({ kind: 'exposure', ev: 0.5 });
    expect(opDigest(base)).not.toBe(opDigest(ops({ kind: 'exposure', ev: 0.6 })));
  });

  it('is order-sensitive (kind merge order is visible state)', () => {
    const e = { kind: 'exposure', ev: 1 } as Op;
    const w = { kind: 'whiteBalance', kelvin: 5000, tint: 0 } as Op;
    expect(opDigest(ops(e, w))).not.toBe(opDigest(ops(w, e)));
  });

  it('distinguishes the two tone-curve modes', () => {
    const region: Op = { kind: 'toneCurve', mode: 'region', highlights: 10, lights: 0, darks: 0, shadows: -5 };
    const point: Op = { kind: 'toneCurve', mode: 'point', points: [0, 0, 0.5, 0.6, 1, 1] };
    expect(opDigest(ops(region))).not.toBe(opDigest(ops(point)));
  });

  it('sees optional crop rect fields but not their key order', () => {
    const a: Op = { kind: 'crop', aspect: '3:2', rotate90: 0, angle: 0, x: 0.1, y: 0.2, w: 0.8, h: 0.6 };
    const b: Op = { kind: 'crop', aspect: '3:2', rotate90: 0, angle: 0 };
    expect(opDigest(ops(a))).not.toBe(opDigest(ops(b)));
    // same rect, object literal in different field order -> same digest
    const c: Op = { kind: 'crop', angle: 0, h: 0.6, w: 0.8, y: 0.2, x: 0.1, rotate90: 0, aspect: '3:2' };
    expect(opDigest(ops(a))).toBe(opDigest(ops(c)));
  });

  it('hashes dodge/burn mask content', () => {
    const mk = (mask: Int8Array): Op => ({ kind: 'dodgeBurn', amount: 40, size: 20, opacity: 50, feather: 0, mask, maskW: 4, maskH: 1 });
    expect(opDigest(ops(mk(new Int8Array([0, 0, 0, 0]))))).not.toBe(opDigest(ops(mk(new Int8Array([0, 90, 0, 0])))));
  });

  it('empty chain has a distinct digest from a neutral-exposure chain', () => {
    expect(opDigest([])).not.toBe(opDigest(ops({ kind: 'exposure', ev: 0 })));
  });

  it('kelvin + tint gains (optional fields) both feed the digest', () => {
    const a: Op = { kind: 'whiteBalance', kelvin: 5200, tint: 0, gains: { r: 2, g: 1, b: 1.5 } };
    const b: Op = { kind: 'whiteBalance', kelvin: 5200, tint: 0 };
    expect(opDigest(ops(a))).not.toBe(opDigest(ops(b)));
  });
});

describe('developedRenderNeeded', () => {
  const emptyDigest = opDigest([]);
  const editedDigest = opDigest(ops({ kind: 'exposure', ev: 0.5 }));

  it('unedited RAW needs a render: the camera JPEG is not the developed image (film sims)', () => {
    expect(developedRenderNeeded(true, 0, undefined, emptyDigest)).toBe(true);
  });

  it('unedited non-RAW never needs a render: browser decode matches the pipeline', () => {
    expect(developedRenderNeeded(false, 0, undefined, emptyDigest)).toBe(false);
  });

  it('edited photo with no cached row needs a render', () => {
    expect(developedRenderNeeded(false, 1, undefined, editedDigest)).toBe(true);
  });

  it('edited photo with a stale cached row needs a render', () => {
    expect(developedRenderNeeded(false, 1, emptyDigest, editedDigest)).toBe(true);
  });

  it('edited photo with a fresh cached row does not', () => {
    expect(developedRenderNeeded(false, 1, editedDigest, editedDigest)).toBe(false);
    expect(developedRenderNeeded(true, 1, editedDigest, editedDigest)).toBe(false);
  });

  it('RAW with a fresh cached render for its empty chain does not re-render', () => {
    expect(developedRenderNeeded(true, 0, emptyDigest, emptyDigest)).toBe(false);
  });
});
