// Film-stock response curves for the "film" profile looks. Pure and unit-tested:
// the GPU tone op only looks up the baked LUTs, all the math lives here.
//
// Source: filmr (W-Mai/filmr, MIT) -- a physics-based film simulation whose
// KODAK_PORTRA_400 preset carries the authoritative Kodak Portra 400 H-D
// curves (E-7053 datasheet). Two stages compose per channel:
//
//   1. H-D curve (filmr film.rs `SegmentedCurve::map_smooth`): the logistic
//      density response D(logE) = d_min + range·sigmoid(k·(logE − logE0)),
//      k = 4·gamma/range so the curve's slope AT THE INFLECTION equals gamma.
//      This IS the film's tone: toe lift, mid contrast, highlight shoulder.
//   2. Positive output (filmr pipeline.rs `create_output_image`, Positive):
//      net = (D − d_min), range_out = 0.85·(d_max − d_min), then a filmic
//      scan curve (`FilmicCurve::negative()`) turns density into display.
//
// The result is wrapped back to LINEAR (srgbToLinear) so it composes with our
// pipeline's sRGB encode at the blit -- the film look lives in the tone op,
// exactly like the camera/ACR base it replaces.
//
// ponytail: v1 SKIPS the film's dye-crosstalk color_matrix ([[1.07,-0.04,-0.03],
// ...]) -- it operates on DENSITIES between the H-D and filmic stages, so a
// per-channel LUT can't fold it. Its visible effect is a mild saturation/level
// lift (~7% diag); the per-channel H-D differences already carry most of the
// stock's color character. Upgrade path: a dedicated `film` op whose shader
// does LUT -> crosstalk -> filmic as one pass.

// A single film channel's H-D response.
export interface FilmChannelParams {
  dMin: number; // base density (orange-mask residual; R most transparent)
  dMax: number; // shoulder density ceiling
  gamma: number; // slope of the H-D curve at its inflection (channel contrast)
  e0: number; // exposure (linear units) of the inflection point -- the film's "speed"
}

export interface FilmStock {
  id: string;
  name: string;
  channels: [FilmChannelParams, FilmChannelParams, FilmChannelParams]; // R, G, B
  // Scanner per-channel OUTPUT gain (linear), the electronic scan balance that
  // neutralizes the raw layer imbalance: a neutral mid-gray must come out
  // neutral. (A logE-shift balance also neutralizes mid-gray but drifts the
  // highlights cool -- B>G>R, slide-film like; output gain keeps the warm
  // R>G>B through highlights, which IS Portra.) The per-channel SHAPE
  // differences stay -- warm shadows (R less dense, the orange mask) and warm
  // highlights, that's the stock's color character.
  gain: [number, number, number];
}

// Kodak Portra 400 (Professional Color Negative), E-7053, via filmr
// src/presets/kodak.rs. All three channels share e0 (one film speed); the
// gammas rise R<G<B (R flattest -- skin-tone friendly, B most contrasty) and
// d_mins rise R<G<B (B carries the most orange-mask dye). gain fitted so a
// neutral mid-gray (0.18) renders neutral at FILM_EXPOSURE_SCALE: R needs
// +1.167 (its layer is least sensitive), B ×0.862.
export const PORTRA_400: FilmStock = {
  id: 'portra400',
  name: 'Portra 400',
  channels: [
    { dMin: 0.14, dMax: 2.9, gamma: 0.58, e0: 625.0469 },
    { dMin: 0.16, dMax: 2.9, gamma: 0.65, e0: 625.0469 },
    { dMin: 0.19, dMax: 2.9, gamma: 0.72, e0: 625.0469 },
  ],
  gain: [1.167, 1, 0.862],
};

// The film's exposure scale (the GREEN channel is the gain=1 reference): the
// linear input times this = film exposure E fed to the H-D curve. Chosen so
// mid-gray (0.18 linear, the pipeline's exposure-0 convention) lands at 0.39
// LINEAR -- the SAME mid-gray the camera look renders (ACR baseline +1.11 EV)
// -- so switching to the film profile is a pure look swap, not a re-exposure.
// (The H-D inflection alone would center mid-gray there but render ~0.29 --
// visibly darker than the default.) The scanner gain neutralizes R/B to match.
// ponytail: anchored to the camera look's mid-gray analytically; tune against
// real files if Portra reads too dark/light at exposure 0.
export const FILM_EXPOSURE_SCALE = 17668;

// The H-D curve: density from log10 exposure. filmr film.rs map_smooth.
export function filmDensity(logE: number, c: FilmChannelParams): number {
  const range = c.dMax - c.dMin;
  if (range <= 0) return c.dMin;
  const k = (4 * c.gamma) / range;
  const sigmoid = 1 / (1 + Math.exp(-k * (logE - Math.log10(c.e0))));
  return c.dMin + range * sigmoid;
}

// filmr filmic_curve.rs `FilmicCurve::negative()`: the scan curve that turns
// normalized net density into display output. linear=x^2.2 (gamma), toe =
// linear^1.2 (toe_power=1+0.2), shoulder = 1−(1−linear)^1.6 (power=1+2·0.3),
// smoothstep-blended -- deep shadows gain contrast, highlights roll instead of
// clipping.
export function filmicNegative(x: number): number {
  const xc = Math.max(0, Math.min(1, x));
  const linear = xc ** 2.2;
  const toe = linear ** 1.2;
  const shoulder = 1 - (1 - linear) ** 1.6;
  const ts = linear * linear * (3 - 2 * linear); // smoothstep(linear)
  return toe * (1 - ts) + shoulder * ts;
}

// sRGB OETF inverse -- wraps the film's display-referred output back to linear
// so our pipeline's blit re-applies the encode. Mirror of the WGSL srgb_to_lin
// used elsewhere.
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// The full film composite for one channel: LINEAR in -> LINEAR out (display-
// referred through the film, then un-wrapped to linear). No crosstalk (v1).
// tone.ts samples this into the tone op's per-channel log-domain LUT
// (buildToneLutForChannel('film', channel)); this file stays pure math so it
// never needs the tone domain constants.
export function filmRenderLinear(lin: number, c: FilmChannelParams, exposureScale: number): number {
  const logE = Math.log10(lin * exposureScale);
  const net = filmDensity(logE, c) - c.dMin;
  const range = (c.dMax - c.dMin) * 0.85; // positive-mode density range (filmr)
  const out = filmicNegative(Math.max(0, net / range));
  return srgbToLinear(out);
}
