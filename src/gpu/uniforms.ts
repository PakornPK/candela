export function evToGain(ev: number): number {
  return Math.pow(2, ev);
}

export interface WhiteBalanceGains {
  rGain: number;
  bGain: number;
}

// wbShift in [-1, 1]: positive shifts warmer (boost red, cut blue).
export function wbShiftToGains(wbShift: number): WhiteBalanceGains {
  const clamped = Math.max(-1, Math.min(1, wbShift));
  return {
    rGain: 1 + clamped * 0.5,
    bGain: 1 - clamped * 0.5,
  };
}

export interface AdjustState {
  exposureEV: number;
  wbShift: number;
}

// Layout must match the `Adjust` uniform struct in adjust.wgsl:
// struct Adjust { exposureGain: f32, rGain: f32, bGain: f32, _pad: f32 }
export function packAdjustUniforms(state: AdjustState): Float32Array {
  const exposureGain = evToGain(state.exposureEV);
  const { rGain, bGain } = wbShiftToGains(state.wbShift);
  return new Float32Array([exposureGain, rGain, bGain, 0]);
}

const CFA_COLOR_CODE: Record<string, number> = { R: 0, G: 1, B: 2 };

// Layout must match the `Cfa` uniform struct in demosaic.wgsl:
// struct Cfa { pattern: vec4<u32> }
export function packCfaPattern(cfaPattern: string): Uint32Array {
  if (cfaPattern.length !== 4) {
    throw new Error(`Expected a 4-character CFA pattern, got "${cfaPattern}"`);
  }
  return Uint32Array.from(cfaPattern, (ch) => {
    const code = CFA_COLOR_CODE[ch];
    if (code === undefined) {
      throw new Error(`Unknown CFA color "${ch}"`);
    }
    return code;
  });
}

export const WB_NEUTRAL_KELVIN = 5500;
const WB_KELVIN_HALF_RANGE = 3500;

// UI-facing conversion only: the WB slider is displayed in Kelvin, but the
// gain math above (wbShiftToGains) and the GPU uniform layout stay in their
// existing [-1, 1] shift space. Not a physically accurate color-temperature
// model.
export function kelvinToShift(kelvin: number): number {
  return (kelvin - WB_NEUTRAL_KELVIN) / WB_KELVIN_HALF_RANGE;
}
