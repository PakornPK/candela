import { describe, it, expect } from 'vitest';
import { parsePreset, serializePreset } from './presetFiles';
import type { Op } from './types';

const SIMPLE_OPS: Op[] = [
  { kind: 'profile', profile: 'camera' },
  { kind: 'exposure', ev: 0.5 },
  { kind: 'tone', contrast: 20, highlights: -30, shadows: 15, whites: 5, blacks: -8 },
  { kind: 'toneCurve', mode: 'region', highlights: 10, lights: 5, darks: -5, shadows: -10 },
];

describe('presetFiles', () => {
  it('round-trips a preset through JSON losslessly', () => {
    const json = serializePreset('Film-ish', SIMPLE_OPS);
    const parsed = parsePreset(json);
    expect(parsed.name).toBe('Film-ish');
    expect(parsed.candelaPreset).toBe(1);
    expect(parsed.ops).toEqual(SIMPLE_OPS);
  });

  it('round-trips a dodgeBurn brush mask as a real Int8Array', () => {
    // JSON.stringify of an Int8Array would emit {"0":...} -- the mask must
    // serialize as a plain byte array and come back as an Int8Array or
    // isValidOp rejects it on import.
    const withMask: Op[] = [
      { kind: 'dodgeBurn', amount: 40, size: 20, opacity: 50, feather: 0, mask: new Int8Array([0, 127, -127, 64]), maskW: 2, maskH: 2 },
    ];
    const parsed = parsePreset(serializePreset('Brush', withMask));
    expect(parsed.ops[0]).toEqual(withMask[0]);
    expect((parsed.ops[0] as { mask: Int8Array }).mask).toBeInstanceOf(Int8Array);
    expect(Array.from((parsed.ops[0] as { mask: Int8Array }).mask)).toEqual([0, 127, -127, 64]);
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePreset('{ not json')).toThrow();
  });

  it('rejects a future/unknown file version', () => {
    expect(() => parsePreset('{"candelaPreset": 2, "name": "x", "ops": []}')).toThrow(/version/);
  });

  it('rejects a file with no name unless a fallback is given', () => {
    const noName = '{"candelaPreset": 1, "ops": []}';
    expect(() => parsePreset(noName)).toThrow(/name/);
    expect(parsePreset(noName, 'from-file').name).toBe('from-file');
  });

  it('rejects an op that fails validation (unknown kind)', () => {
    const bad = '{"candelaPreset": 1, "name": "x", "ops": [{"kind": "teleport"}]}';
    expect(() => parsePreset(bad)).toThrow(/validat/);
  });
});
