// CPU-side model for the Presence op (presence.wgsl). Pure + unit-tested: the
// chroma math below mirrors the shader's boost so the direction logic (which
// slider makes colors more/less saturated) is verifiable without a browser.
// The spatial texture/clarity part lives only in the shader.

export interface PresenceParams {
  texture: number; // -100..100, 0 neutral
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
}

export function isNeutralPresence(p: PresenceParams): boolean {
  return p.texture === 0 && p.clarity === 0 && p.dehaze === 0 && p.vibrance === 0 && p.saturation === 0;
}

// Layout must match the `Presence` struct in presence.wgsl (5 f32s + 3 pad).
export function packPresence(p: PresenceParams): Float32Array {
  return new Float32Array([p.texture, p.clarity, p.dehaze, p.vibrance, p.saturation, 0, 0, 0]);
}

// Combined chroma scale applied to (rgb - lum), mirroring the shader's
// `boost` (the dehaze chroma term is a calibration detail, omitted here).
// sat in [0,1] (max channel - min channel). Vibrance lifts low-saturation
// pixels more -- the "skin protection" behavior; coefficient 1.3 is the
// calibrated LrC-ish strength. Clamped >= 0: a negative chroma scale would
// invert hues (turn red into cyan).
export function chromaBoost(saturation: number, vibrance: number, sat: number): number {
  const satAmt = saturation / 100;
  const vibAmt = vibrance / 100;
  return Math.max((1 + satAmt) * (1 + 1.3 * vibAmt * (1 - sat)), 0);
}
