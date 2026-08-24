import { describe, it, expect } from 'vitest';
import { opsToAdjustState } from './adjust';
import { WB_NEUTRAL_KELVIN } from '../gpu/uniforms';

describe('opsToAdjustState', () => {
  it('defaults to neutral when there are no ops', () => {
    expect(opsToAdjustState([])).toEqual({ exposureEV: 0, wbShift: 0 });
  });

  it('reads exposureEV from the exposure op', () => {
    const state = opsToAdjustState([{ kind: 'exposure', ev: 1.5 }]);
    expect(state.exposureEV).toBe(1.5);
    expect(state.wbShift).toBe(0);
  });

  it('converts the whiteBalance op kelvin to a shift', () => {
    const state = opsToAdjustState([{ kind: 'whiteBalance', kelvin: 9000 }]);
    expect(state.exposureEV).toBe(0);
    expect(state.wbShift).toBeCloseTo(1);
  });

  it('reads both ops together, independent of array order', () => {
    const state = opsToAdjustState([
      { kind: 'whiteBalance', kelvin: WB_NEUTRAL_KELVIN },
      { kind: 'exposure', ev: -2 },
    ]);
    expect(state).toEqual({ exposureEV: -2, wbShift: 0 });
  });
});
