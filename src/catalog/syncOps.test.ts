import { describe, expect, it } from 'vitest';
import { WB_NEUTRAL_KELVIN } from '../gpu/uniforms';
import type { Op, ProfileKind } from './types';
import { syncableOps } from './syncOps';

const wb = (kelvin: number, tint = 0): Op => ({ kind: 'whiteBalance', kelvin, tint });
// An As-Shot op: `gains` is set exactly when the WB sliders were never touched.
const shotWb = (kelvin: number, tint = 0): Op => ({
  kind: 'whiteBalance', kelvin, tint, gains: { r: 2.1, g: 1, b: 1.4 },
});
const exposure = (ev: number): Op => ({ kind: 'exposure', ev });
const profile = (p: ProfileKind): Op => ({ kind: 'profile', profile: p });
const tone: Op = { kind: 'tone', contrast: 25, highlights: -30, shadows: 15, whites: 5, blacks: -10 };
const presence: Op = { kind: 'presence', texture: 20, clarity: -10, dehaze: 5, vibrance: 15, saturation: -5 };
const crop: Op = { kind: 'crop', aspect: '1:1', rotate90: 1, angle: 2.5 };

describe('syncableOps (absolute sync, user intent only)', () => {
  it('drops a whiteBalance op that still carries the camera gains', () => {
    expect(syncableOps([shotWb(6500, 12)], 'camera')).toStrictEqual([]);
  });

  it('drops a whiteBalance op sitting on the slider neutral', () => {
    expect(syncableOps([wb(WB_NEUTRAL_KELVIN, 0)], 'camera')).toStrictEqual([]);
  });

  it('keeps a moved whiteBalance op, kelvin and tint intact', () => {
    expect(syncableOps([wb(6500, 5)], 'camera')).toStrictEqual([{ kind: 'whiteBalance', kelvin: 6500, tint: 5 }]);
  });

  it('drops EV 0 exposure and keeps a moved one', () => {
    expect(syncableOps([exposure(0)], 'camera')).toStrictEqual([]);
    expect(syncableOps([exposure(0.8)], 'camera')).toStrictEqual([exposure(0.8)]);
  });

  it('drops the profile equal to the defaultProfile argument and keeps any other', () => {
    expect(syncableOps([profile('camera')], 'camera')).toStrictEqual([]);
    expect(syncableOps([profile('portra400')], 'camera')).toStrictEqual([profile('portra400')]);
    // The argument decides which profile means "never chose one" -- not a
    // hardcoded 'camera' inside syncableOps.
    expect(syncableOps([profile('neutral')], 'neutral')).toStrictEqual([]);
  });

  it('keeps tone, presence and crop unchanged -- those are already emitted only when non-neutral', () => {
    expect(syncableOps([tone, presence, crop], 'camera')).toStrictEqual([tone, presence, crop]);
  });

  it('from an untouched-source mix, returns only the real edits, in input order', () => {
    const moved: Op = { kind: 'exposure', ev: 0.8 };
    const out = syncableOps(
      [shotWb(WB_NEUTRAL_KELVIN), wb(WB_NEUTRAL_KELVIN, 0), exposure(0), profile('camera'), tone, moved],
      'camera',
    );
    expect(out).toStrictEqual([tone, moved]);
  });
});
