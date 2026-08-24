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

// Layout must match the `Cfa` uniform struct in demosaic.wgsl:
// struct Cfa { pattern: array<vec4<u32>, 9> } -- 9 vec4s x 4 components =
// 36 colors, ONE color per component (color at CFA position i is
// pattern[i/4][i%4]). Each component must be a single color code (0=R 1=G
// 2=B), not a bit-packed group -- a previous 4-colors-per-u32 packing made
// the shader read packed groups, misclassified every pixel, and rendered
// every image dark red/black.
export function packCfa6(cfa6: Uint8Array): Uint32Array {
  if (cfa6.length !== 36) {
    throw new Error(`Expected 36 CFA entries, got ${cfa6.length}`);
  }
  // One u32 per CFA position fills all 144 bytes of the 9xvec4 uniform
  // buffer (36 u32s), so no component ever relies on zero padding.
  return Uint32Array.from(cfa6, (c) => c);
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
