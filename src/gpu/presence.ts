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

// Clarity constants -- MUST stay in sync with presence.wgsl (the shader can't
// import TS; same pattern as tone's LOG_MIN/LOG_MAX). The gate REPLACES the
// old CLARITY_HALO hard clamp -- the repro'ed cause of "clarity does nothing"
// (research: LrC +100 clarity roughly doubles midtone local log-contrast and
// its halos are a feature, not an overshoot to clamp away). The clamp capped
// the whole response at a few percent; the gate caps only the EXTREMES, where
// halos would bloom, and lets the midtones run at full strength.
export const CLARITY_STRENGTH = 1.5;
// log2(0.18) -- mid-gray, the center of LrC's clarity response.
export const CLARITY_MID_LOG = Math.log2(0.18);
// EV half-width of the midtone bell: ~1 at mid-gray, ~0 past ±~5 EV.
export const CLARITY_GATE_WIDTH = 3.5;

// Midtone gate: 1 at mid-gray, rolling to ~0 toward black/white (the smooth
// rolloff is the "soft edge-aware" half of LrC's halo management -- halos show
// in the midtones, which is the look, and die in the extremes).
export function clarityGate(l: number): number {
  return Math.exp(-3 * ((l - CLARITY_MID_LOG) / CLARITY_GATE_WIDTH) ** 2);
}

// CPU mirror of presence.wgsl's clarity term: local-contrast unsharp on log
// luma, response scaled by the midtone gate. The spatial part of the shader
// otherwise has no runnable repro -- a browser render can't run in vitest -- so
// this is the only place the slider response is pinned. `l` is the center
// pixel's log2 luma, mean the CLARITY_RADIUS box mean, amount clarity in
// [-1, 1].
export function clarityLogLuma(l: number, mean: number, amount: number): number {
  return l + CLARITY_STRENGTH * amount * (l - mean) * clarityGate(l);
}
