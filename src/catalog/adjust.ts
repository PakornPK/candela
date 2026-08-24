import { kelvinToShift, type AdjustState } from '../gpu/uniforms';
import { isExposureOp, isWhiteBalanceOp, type Op } from './types';

export function opsToAdjustState(ops: Op[]): AdjustState {
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  return {
    exposureEV: exposureOp?.ev ?? 0,
    wbShift: wbOp ? kelvinToShift(wbOp.kelvin) : 0,
  };
}
