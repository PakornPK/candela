// CPU-side builders for the LUT-based tonal ops (tone.wgsl). Pure and
// unit-tested: the GPU only looks up, all the math lives here so it can be
// reasoned about and verified without a browser.
//
// The output LUT is a sampled monotonic response y = f(x), x/y in [0,1].
// Monotonicity is load-bearing -- a non-monotonic response inverts tones and
// bands. Every stage below has a strictly positive derivative over its range,
// so any composition of them is monotonic by construction.
//
// Domain: x is normalized LOG2 luminance (logToNorm below), not linear
// luminance. That is the fix for "tone feels unlike LrC": in linear space the
// deep shadows (near 0.0) and bright highlights (near 1.0) crowd the ends of
// [0,1], so a shadows/highlights curve barely touches one end and slams the
// other; in log space the perceptual range (roughly 2^-12 .. 2^4 EV) stretches
// across the whole domain and both tools act where the eye cares.
//
// NEUTRAL IS NOT IDENTITY: the LUT base is ACR_DEFAULT_CURVE (below) mapped
// into the log domain -- the baseline look LrC opens every photo with. All
// sliders perturb that base. The identity response only appears in
// buildToneCurveLut (a user tone curve with no edits).
//
// Stage math (contrast -> region/endpoint deltas) is LrC-like: the tonal tools
// are *band-confined* (weighted by smoothstep, so each tool only touches its
// own tonal band -- a Highlights slider never moves the midtones the way a
// global power/ratio curve did). Blacks/Shadows/Whites are additive deltas;
// Highlights + is a top-roll (see stage 3) because a plain delta was too weak
// in the visible 0.75-0.85 zone and hard-clipped the near-white end. Blacks
// runs opposite to Shadows: Blacks + crushes the bottom, Shadows + lifts its
// band. A running-max guard keeps the composition monotonic when a strong
// negative delta would otherwise dip its end.
// ponytail: strengths are rough calibrations -- tune against LrC screenshots
// (phase J verification); directions are correct as-is.

import { PORTRA_400, filmRenderLinear, filmExposureScale } from './film';
import type { FilmChannelParams, FilmStock } from './film';

export interface ToneParams {
  contrast: number; // -100..100, 0 neutral
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export const TONE_LUT_SIZE = 512;

// Baked "camera look" -- the tone of the camera's own JPEG engine,
// reverse-engineered from the embedded camera JPEG (X100V, fitted 2026-08-26
// across DSCF8946/8947/8949, three WB scenes). It is the DEFAULT tone look
// (buildToneLuts('camera')): the app should render like the camera back
// screen, not like Adobe's ACR baseline -- the user's directive ("Profile
// กล้องที่เหมือนหลังกล้อง"). The ACR baseline stays as the 'standard' look
// (profile 'neutral' / the generic fallback for cameras we haven't fitted).
//
// The fit's first pass found per-channel B shadow lifts (5-8x) and baked them
// as fixed curves -- WRONG: the fitted files were warm/tungsten scenes whose
// shadows are physically blue, so a fixed per-channel curve cast EVERY file
// blue-orange ("ฟ้าส้ม" -- the broken render the user reported). The
// scene-independent signal is LUMA: in midtones/highlights the camera JPEG
// matches the ACR baseline channel-for-channel (multiplier ~1.0 across the
// reliable bins), and only the shadow toe diverges -- Fuji film sims lift
// blacks. So the camera look is ONE shared luma curve (all three channel LUTs
// identical): the ACR baseline everywhere except a NEUTRAL shadow lift. Color
// stays in the WB / profile ops, which know the scene.
// ponytail: fitted on one camera (X100V) -- per-camera curves are the upgrade
// path (extract the embedded JPEG per camera, re-run the fit probe).
// ponytail: the toe's exact lift (floor 0.0065, junction 0.026) is a rough
// calibration -- tune against the camera back on real files.
export function cameraOutput(o: number): number {
  // Midtones/highlights (o >= ~0.026 linear): the camera JPEG matches the ACR
  // baseline (fit m ~= 1.0), so identity.
  if (o >= 0.026) return o;
  // Shadow toe: film-sim black lift. Power ramp from the JPEG black floor
  // (~0.0065 linear) to identity at o = 0.026; exponent 4/3 makes the junction
  // slope-continuous with the identity line (no visible knee).
  const t = Math.pow(Math.max(o, 0) / 0.026, 4 / 3);
  return 0.0065 + (0.026 - 0.0065) * t;
}

// Log2-luminance domain for tone. The visible tonal range of a raw sits
// roughly in [2^-12, 2^4] (a few stops below deep shadow noise to a few stops
// above mid-gray). These MUST stay in sync with tone.wgsl's LOG_MIN/LOG_MAX.
export const LOG_MIN = -12;
export const LOG_MAX = 4;

// Maps linear luminance to the LUT's [0,1] domain. lum is clamped from below
// (log2(0) = -Infinity) and from above (domain ceiling); identical to the
// shader's helper.
export function logToNorm(lum: number): number {
  const clamped = Math.min(LOG_MAX, Math.max(LOG_MIN, Math.log2(Math.max(lum, 1e-6))));
  return (clamped - LOG_MIN) / (LOG_MAX - LOG_MIN);
}

// ACR's default tone curve -- the "Adobe Camera Raw default curve" applied
// whenever a DCP carries no explicit ProfileToneCurve tag (Adobe Standard
// omits it), i.e. the baseline look every LrC photo opens with: shadows and
// midtones lifted (mid-gray +1.11 EV), highlights rolled off (slope ~0.13 at
// white). Source: RawTherapee rtengine/dcp.cc `adobe_camera_raw_default_curve`
// (1025 entries), linearly resampled to 512 -- entry k = output for linear
// input k/511, max error < 1e-4 (rawpedia confirms identity with ACR's
// default; ACR = LrC's engine). Applied PER-CHANNEL to linear RGB after the
// color matrix in ACR. Its only role here: the neutral base of the tone LUT
// (buildToneLut starts from it), which tone.wgsl applies per-channel --
// toneBaselinePass is the CPU twin. The per-channel application is the
// saturation fix: a luma-only baseline preserves a colored highlight's cast
// while LrC rolls the hottest channel toward white.
export const ACR_DEFAULT_CURVE = new Float32Array([
  0.000000, 0.001603, 0.003146, 0.004609, 0.006244, 0.008080, 0.010146, 0.012413, 0.014891, 0.017559, 0.020388, 0.023376, 0.026506, 0.029755, 0.033124, 0.036583,
  0.040132, 0.043742, 0.047431, 0.051171, 0.054980, 0.058840, 0.062760, 0.066731, 0.070760, 0.074831, 0.078951, 0.083121, 0.087331, 0.091583, 0.095884, 0.100225,
  0.104604, 0.109017, 0.113477, 0.117968, 0.122500, 0.127062, 0.131664, 0.136304, 0.140976, 0.145677, 0.150410, 0.155172, 0.159975, 0.164806, 0.169667, 0.174551,
  0.179474, 0.184426, 0.189399, 0.194409, 0.199443, 0.204505, 0.209589, 0.214711, 0.219851, 0.224971, 0.230077, 0.235164, 0.240222, 0.245259, 0.250274, 0.255262,
  0.260229, 0.265166, 0.270080, 0.274967, 0.279824, 0.284658, 0.289465, 0.294241, 0.298995, 0.303721, 0.308418, 0.313091, 0.317727, 0.322343, 0.326926, 0.331489,
  0.336015, 0.340520, 0.344992, 0.349438, 0.353850, 0.358235, 0.362600, 0.366932, 0.371237, 0.375508, 0.379753, 0.383978, 0.388169, 0.392333, 0.396468, 0.400579,
  0.404653, 0.408707, 0.412737, 0.416731, 0.420705, 0.424655, 0.428568, 0.432462, 0.436326, 0.440165, 0.443978, 0.447767, 0.451520, 0.455259, 0.458966, 0.462655,
  0.466308, 0.469941, 0.473549, 0.477131, 0.480694, 0.484226, 0.487734, 0.491216, 0.494678, 0.498110, 0.501527, 0.504914, 0.508280, 0.511622, 0.514944, 0.518235,
  0.521507, 0.524758, 0.527989, 0.531195, 0.534376, 0.537537, 0.540678, 0.543789, 0.546890, 0.549960, 0.553016, 0.556046, 0.559056, 0.562047, 0.565017, 0.567967,
  0.570893, 0.573803, 0.576693, 0.579563, 0.582413, 0.585246, 0.588062, 0.590851, 0.593631, 0.596386, 0.599120, 0.601845, 0.604548, 0.607233, 0.609896, 0.612551,
  0.615180, 0.617799, 0.620394, 0.622977, 0.625542, 0.628090, 0.630619, 0.633137, 0.635635, 0.638120, 0.640588, 0.643037, 0.645475, 0.647899, 0.650307, 0.652695,
  0.655073, 0.657431, 0.659778, 0.662113, 0.664430, 0.666735, 0.669022, 0.671297, 0.673557, 0.675801, 0.678038, 0.680255, 0.682459, 0.684656, 0.686833, 0.688997,
  0.691154, 0.693291, 0.695415, 0.697531, 0.699635, 0.701722, 0.703798, 0.705862, 0.707908, 0.709952, 0.711979, 0.713992, 0.715998, 0.717984, 0.719968, 0.721934,
  0.723888, 0.725833, 0.727767, 0.729685, 0.731598, 0.733494, 0.735387, 0.737261, 0.739126, 0.740981, 0.742825, 0.744660, 0.746484, 0.748297, 0.750093, 0.751887,
  0.753670, 0.755444, 0.757200, 0.758953, 0.760696, 0.762421, 0.764144, 0.765858, 0.767553, 0.769246, 0.770929, 0.772603, 0.774257, 0.775911, 0.777555, 0.779188,
  0.780821, 0.782434, 0.784038, 0.785641, 0.787224, 0.788808, 0.790371, 0.791934, 0.793487, 0.795030, 0.796564, 0.798097, 0.799610, 0.801123, 0.802626, 0.804119,
  0.805601, 0.807074, 0.808547, 0.810000, 0.811453, 0.812895, 0.814328, 0.815761, 0.817174, 0.818586, 0.819989, 0.821382, 0.822774, 0.824156, 0.825529, 0.826891,
  0.828244, 0.829596, 0.830938, 0.832270, 0.833593, 0.834916, 0.836227, 0.837530, 0.838831, 0.840114, 0.841396, 0.842678, 0.843940, 0.845203, 0.846464, 0.847706,
  0.848949, 0.850180, 0.851402, 0.852625, 0.853837, 0.855048, 0.856240, 0.857441, 0.858624, 0.859804, 0.860976, 0.862139, 0.863301, 0.864453, 0.865604, 0.866744,
  0.867876, 0.868998, 0.870121, 0.871241, 0.872343, 0.873445, 0.874545, 0.875637, 0.876719, 0.877799, 0.878871, 0.879933, 0.880995, 0.882045, 0.883097, 0.884139,
  0.885171, 0.886201, 0.887223, 0.888245, 0.889257, 0.890266, 0.891268, 0.892260, 0.893249, 0.894231, 0.895213, 0.896185, 0.897154, 0.898116, 0.899067, 0.900019,
  0.900968, 0.901907, 0.902842, 0.903770, 0.904692, 0.905614, 0.906526, 0.907434, 0.908336, 0.909234, 0.910126, 0.911011, 0.911889, 0.912771, 0.913643, 0.914511,
  0.915372, 0.916224, 0.917076, 0.917924, 0.918765, 0.919603, 0.920434, 0.921256, 0.922078, 0.922899, 0.923711, 0.924518, 0.925320, 0.926117, 0.926909, 0.927700,
  0.928482, 0.929259, 0.930035, 0.930802, 0.931563, 0.932325, 0.933082, 0.933833, 0.934579, 0.935321, 0.936057, 0.936789, 0.937515, 0.938247, 0.938958, 0.939680,
  0.940386, 0.941097, 0.941799, 0.942490, 0.943186, 0.943873, 0.944559, 0.945240, 0.945912, 0.946588, 0.947249, 0.947920, 0.948571, 0.949227, 0.949878, 0.950530,
  0.951171, 0.951807, 0.952438, 0.953069, 0.953696, 0.954321, 0.954933, 0.955548, 0.956159, 0.956760, 0.957361, 0.957963, 0.958558, 0.959149, 0.959730, 0.960311,
  0.960892, 0.961467, 0.962038, 0.962606, 0.963170, 0.963725, 0.964282, 0.964834, 0.965378, 0.965926, 0.966464, 0.967001, 0.967532, 0.968063, 0.968588, 0.969109,
  0.969630, 0.970141, 0.970652, 0.971156, 0.971667, 0.972160, 0.972659, 0.973150, 0.973641, 0.974124, 0.974605, 0.975086, 0.975560, 0.976031, 0.976501, 0.976962,
  0.977423, 0.977884, 0.978337, 0.978788, 0.979239, 0.979680, 0.980121, 0.980562, 0.980993, 0.981424, 0.981846, 0.982277, 0.982698, 0.983111, 0.983530, 0.983941,
  0.984343, 0.984744, 0.985145, 0.985546, 0.985938, 0.986329, 0.986720, 0.987109, 0.987491, 0.987863, 0.988242, 0.988613, 0.988984, 0.989346, 0.989707, 0.990067,
  0.990428, 0.990780, 0.991131, 0.991481, 0.991822, 0.992163, 0.992503, 0.992835, 0.993175, 0.993496, 0.993827, 0.994147, 0.994468, 0.994789, 0.995099, 0.995411,
  0.995721, 0.996022, 0.996332, 0.996633, 0.996924, 0.997215, 0.997505, 0.997796, 0.998086, 0.998367, 0.998647, 0.998918, 0.999198, 0.999469, 0.999739, 1.000000,
]);

// Linear-domain interpolation of the ACR default curve (input clamped to
// [0,1] -- super-white raw highlights roll to white, exactly what ACR does).
export function sampleAcrCurve(linearIn: number): number {
  const x = Math.min(1, Math.max(0, linearIn));
  const pos = x * (ACR_DEFAULT_CURVE.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, ACR_DEFAULT_CURVE.length - 1);
  const f = pos - i0;
  return ACR_DEFAULT_CURVE[i0] + f * (ACR_DEFAULT_CURVE[i1] - ACR_DEFAULT_CURVE[i0]);
}

// Rec.709 luma -- identical to sRGB luma and to LibRaw's xyz_rgb[1] row, so it
// is consistent with the camera-color matrix the base came through. Must stay
// in sync with tone.wgsl's LUMA const.
export const LUMA_WEIGHTS = [0.2126729, 0.7151522, 0.072175] as const;

// Linear-interpolated LUT lookup (the CPU twin of tone.wgsl's lutSample).
export function sampleToneLut(lut: Float32Array, x: number): number {
  const xc = Math.min(1, Math.max(0, x));
  const pos = xc * (TONE_LUT_SIZE - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, TONE_LUT_SIZE - 1);
  return lut[i0] + (pos - i0) * (lut[i1] - lut[i0]);
}

// CPU twin of tone.wgsl's per-channel LUT application. LrC applies the tone
// curve to each linear channel independently, so the hottest channel of a
// colored highlight compresses the most and the cast desaturates on BOTH the
// baseline and the recover direction (LrC shows no red at Highlights +/-); a
// luma-ratio path scales every channel equally and keeps the cast. For gray
// pixels every channel samples the same LUT position, so the output luma
// equals the LUT target exactly -- the user-validated brightness is
// bit-identical to a luma-target pass.
export function toneBaselinePass(c: [number, number, number], lut: Float32Array): [number, number, number] {
  const map = (v: number) => 2 ** (LOG_MIN + sampleToneLut(lut, logToNorm(v)) * (LOG_MAX - LOG_MIN));
  return [map(c[0]), map(c[1]), map(c[2])];
}

export function isNeutralTone(p: ToneParams): boolean {
  return p.contrast === 0 && p.highlights === 0 && p.shadows === 0 && p.whites === 0 && p.blacks === 0;
}

// Smoothstep ramps 0->1 between a and b; used to confine a region tool's
// influence to its tonal band (see buildToneLut stages 3/4).
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Which base curve the neutral tone renders: 'camera' = the fitted camera look
// (the default -- render like the camera back), 'standard' = the ACR baseline,
// 'film' = a film-stock H-D response (per-channel, unlike the other two which
// share one curve across all three channels).
export type ToneLook = 'camera' | 'standard' | 'film';

export function buildToneLut(p: ToneParams): Float32Array {
  return buildToneLutForChannel(p, 'standard');
}

// The tone op's neutral response is now the CAMERA look by default (3 LUTs --
// the camera's film-sim shadow lift; all three carry the same shared curve
// today, the per-channel layout stays for future per-camera fits, see
// cameraOutput). 'standard' reproduces the ACR-baseline single curve (all
// three channels identical) -- profile 'neutral' selects it as the generic
// fallback. 'film' builds three DIFFERENT per-channel LUTs (each channel's own
// film H-D curve) -- the stock's color character lives in those differences.
// Concatenated R,G,B, 3*512.
export function buildToneLuts(p: ToneParams, look: ToneLook = 'camera', filmStock?: FilmStock): Float32Array {
  const luts = new Float32Array(TONE_LUT_SIZE * 3);
  if (look === 'film') {
    // Each stock has its own H-D curves, scan gain, and exposure scale (the
    // mid-gray anchor -- filmExposureScale keeps a stock switch a look swap,
    // not a re-exposure). The per-channel shape differences carry the color.
    const stock = filmStock ?? PORTRA_400;
    const scale = filmExposureScale(stock);
    for (let ch = 0; ch < 3; ch++) {
      luts.set(buildToneLutForChannel(p, 'film', { ch: stock.channels[ch], gain: stock.gain[ch], scale }), ch * TONE_LUT_SIZE);
    }
    return luts;
  }
  const channelLut = buildToneLutForChannel(p, look);
  for (let ch = 0; ch < 3; ch++) {
    luts.set(channelLut, ch * TONE_LUT_SIZE);
  }
  return luts;
}

// The per-channel film base for buildToneLutForChannel: which channel's H-D
// curve and what scanner output gain to apply (see film.ts -- the gain
// neutralizes mid-gray, the curve carries the stock's shape).
export interface FilmToneConfig {
  ch: FilmChannelParams;
  gain: number;
  scale: number;
}

export function buildToneLutForChannel(p: ToneParams, look: ToneLook, film?: FilmToneConfig): Float32Array {
  // Normalize to [-1,1] (sliders are step 1, so exact 0 is the neutral point).
  const c = p.contrast / 100;
  const h = p.highlights / 100;
  const s = p.shadows / 100;
  const w = p.whites / 100;
  const k = p.blacks / 100;

  // Region-confined endpoint/band deltas, LrC-style (all four live in the
  // loop below; order is contrast then deltas). Blacks and Whites are NOT
  // redundant with Shadows and Highlights -- in LrC they act on the very ends
  // of the tonal scale, and Blacks runs OPPOSITE to Shadows: Blacks + deepens
  // the bottom (crush toward black, the "add punch" move), Blacks - lifts it;
  // Whites + brightens the top toward clipping, Whites - darkens it
  // (recover). Every tool shifts y by strength*weight where the smoothstep
  // weight is ~1 in the tool's own band and ~0 elsewhere, so no tool moves
  // the midtones it shouldn't.
  // Bands sit on the VISIBLE tonal range (display black ~ -9 EV .. mid-gray
  // 0 EV), not the log-domain extremes -- a band pinned to -12 EV would
  // touch nothing the eye can see: blacks full at -9 EV gone by ~-5 EV;
  // shadows -8 .. -2.4 EV; highlights ~0 .. +3 EV; whites full by +0.5 EV
  // gone below -3 EV.
  // ponytail: strengths are rough; calibrate vs LrC screenshots.
  const kB = 0.15; // blacks delta strength
  const kW = 0.15; // whites delta strength
  const kHi = 0.5; // highlights + top-roll strength (see stage 3)
  const kRec = 0.15; // highlights - pull-down strength (recover, matches other bands)
  const kLo = 0.15; // shadows delta strength
  // Base curve for this channel: the camera look (ACR output through the
  // shared camera curve), the ACR default curve, or a film-stock H-D response
  // (filmCh), mapped into the log domain. The shared camera curve
  // (cameraOutput) is channel-independent -- all three channel LUTs carry it
  // identically (no per-channel cast, the ฟ้าส้ม fix). The film base is
  // per-channel: filmRenderLinear returns the stock's linear output for this
  // channel's H-D curve (see film.ts). Neutral params are NOT identity -- they
  // render the import look (camera back, the ACR baseline LrC opens with, or
  // the film stock). The sliders perturb on top.
  const base = (xLin: number): number => {
    if (look === 'camera') return logToNorm(cameraOutput(sampleAcrCurve(xLin)));
    if (look === 'film') {
      return logToNorm(filmRenderLinear(xLin, film!.ch, film!.scale) * film!.gain);
    }
    return logToNorm(sampleAcrCurve(xLin));
  };

  // Contrast pivots at the BASE-LIFTED mid-gray (0.18 linear through this
  // channel's base), NOT the domain midpoint: LrC anchors contrast at the
  // visible midtones, and a pivot at y=0.5 (-4 EV, deep shadow) darkened
  // shadows out of proportion. Anchoring at the lifted value means contrast
  // pivots exactly where mid-gray now renders (the camera look lifts it far
  // above the ACR baseline).
  const yMid = base(0.18);

  const lut = new Float32Array(TONE_LUT_SIZE);
  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    const xLin = 2 ** (LOG_MIN + (i / (TONE_LUT_SIZE - 1)) * (LOG_MAX - LOG_MIN));
    let y = base(xLin);

    // 1. Contrast (c): S-curve about yMid. g=2^c: c=0 -> identity, c>0
    // steepens (more contrast), c<0 flattens. Both halves stay in [0,1] and
    // monotonic by construction.
    const g = Math.pow(2, c);
    if (y <= yMid) {
      y = yMid * Math.pow(Math.max(y / yMid, 1e-6), g);
    } else {
      y = 1 - (1 - yMid) * Math.pow((1 - y) / (1 - yMid), g);
    }

    // 2. Blacks (k), Shadows (s), Whites (w) deltas. Blacks is the odd one
    // out: k>0 SUBTRACTS (crush), k<0 adds (lift); the other two brighten
    // their band on +. (Highlights is stage 3.)
    const bW = 1 - smoothstep(0.19, 0.42, y); // blacks band: full at display black (-9 EV), gone by ~-5 EV
    const loW = 1 - smoothstep(0.25, 0.6, y); // shadows band
    const wW = smoothstep(0.55, 0.78, y); // whites band: full by ~+0.5 EV, gone below -3 EV
    y = Math.min(1, Math.max(0, y - kB * k * bW + kLo * s * loW + kW * w * wW));

    // 3. Highlights (h). + LIFTS the bright end with a top-roll
    // y = 1-(1-y)*(1-kHi*h*hiW): the band rolls smoothly toward white, no hard
    // clip. The old additive delta was too weak in the visible 0.75-0.85 zone
    // (where real highlight pixels live) and pinned the near-white zone at 1.0
    // -- which read as "Highlights + does nothing". - RECOVERS additively: the
    // roll's darkening is too weak right at the top (where 1-y is tiny), which
    // is exactly the blown pixels recover needs to pull down.
    const hiW = smoothstep(0.6, 0.92, y); // highlights band: gone below ~-1.5 EV
    if (h > 0) y = 1 - (1 - y) * (1 - kHi * h * hiW);
    else if (h < 0) y = y + kRec * h * hiW;
    y = Math.min(1, Math.max(0, y));

    lut[i] = y;
  }
  // Monotonic guard: a strong negative endpoint/band delta can dip its end of
  // the curve (the delta falls faster than the base response rises); a
  // running max keeps the response inversion-free so no tones band.
  for (let i = 1; i < TONE_LUT_SIZE; i++) {
    if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
  }
  return lut;
}

// Builds the sampled LUT for a point tone curve from a flat [x0,y0,x1,y1,...]
// list (x/y in [0,1]). Interpolation is a monotone cubic (Fritsch-Carlson /
// PCHIP), NOT Catmull-Rom: Catmull-Rom overshoots [0,1] and can invert a
// monotone control set, which band/crushes a tone curve. Values outside the
// curve's x-range clamp to the end values. Returns a non-decreasing LUT for
// monotone control points.
export function buildToneCurveLut(points: number[]): Float32Array {
  if (points.length < 4 || points.length % 2 !== 0) {
    throw new Error(`Expected flat [x,y] pairs (even length >= 4), got ${points.length}`);
  }
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i += 2) {
    pts.push({ x: Math.min(1, Math.max(0, points[i])), y: Math.min(1, Math.max(0, points[i + 1])) });
  }
  pts.sort((a, b) => a.x - b.x);
  // Dedupe x (keep the last y for a repeated x -- a Hermite segment needs a
  // strictly increasing x span).
  const uniq: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    if (uniq.length > 0 && uniq[uniq.length - 1].x === p.x) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  const n = uniq.length;

  const lut = new Float32Array(TONE_LUT_SIZE);
  if (n === 1) {
    lut.fill(Math.min(1, Math.max(0, uniq[0].y)));
    return lut;
  }

  const xs = uniq.map((p) => p.x);
  const ys = uniq.map((p) => p.y);
  const h: number[] = [];
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    secant.push((ys[i + 1] - ys[i]) / Math.max(h[i], 1e-9));
  }

  // Knot slopes. Fritsch-Carlson interior: weighted harmonic mean of the two
  // adjacent secants (0 on a sign change); endpoints take the one-sided
  // secant. Every slope is clamped >= 0 so a monotone control set always
  // yields a non-decreasing LUT (no tone inversion).
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const d1 = secant[i - 1];
    const d2 = secant[i];
    if (d1 * d2 <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i - 1] + 2 * h[i];
    m[i] = Math.max(0, (w1 + w2) / (w1 / d1 + w2 / d2));
  }
  m[0] = Math.max(0, secant[0]);
  m[n - 1] = Math.max(0, secant[n - 2]);

  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    const x = i / (TONE_LUT_SIZE - 1);
    lut[i] = samplePchip(x, xs, ys, h, m, n);
  }
  return lut;
}

// LrC-style parametric "Region" curve (the Tone Curve panel's default): four
// sliders (highlights/lights/darks/shadows, each -100..100) bend the curve
// around fixed tonal anchors. It shares the same PCHIP machinery as the point
// curve -- the region is just a different source of control points. Slider
// signs follow LrC: dragging a region slider RIGHT moves that segment of the
// curve UP (lighter), LEFT moves it DOWN (darker) -- so each slider + lightens
// its region, and "recovering" (darkening) highlights is Highlights dragged
// LEFT. All-zero params yield the diagonal control points -> exact identity
// (PCHIP reproduces a straight line, and Fritsch-Carlson slopes of a straight
// line are all 1 = its secant).
// The anchors sit at FIXED x (0.12/0.40/0.60/0.88), one slider per band -- no
// anchor x-drift. That makes the map invertible: fitRegionParams() reads the
// curve's height at those x's and recovers the sliders exactly, so the Region
// sliders and the Point curve stay the SAME underlying value (adjust one, the
// other moves), which is how LrC's Tone Curve works.
export function parametricControlPoints(
  highlights: number,
  lights: number,
  darks: number,
  shadows: number,
): number[] {
  const h = highlights / 100, l = lights / 100, d = darks / 100, s = shadows / 100;
  return [
    0.0, 0.0,
    0.12, 0.12 + 0.12 * s,
    0.40, 0.40 + 0.12 * d,
    0.60, 0.60 + 0.12 * l,
    0.88, 0.88 + 0.12 * h,
    1.0, 1.0,
  ];
}

export function buildParametricToneLut(
  highlights: number,
  lights: number,
  darks: number,
  shadows: number,
): Float32Array {
  return buildToneCurveLut(parametricControlPoints(highlights, lights, darks, shadows));
}

// Inverse of parametricControlPoints: recovers the four region slider values
// from an arbitrary point curve by reading its height at the fixed region
// anchors (0.12/0.40/0.60/0.88). EXACT for a curve parametricControlPoints
// produced (each anchor sits at y = x + 0.12·slider, and the LUT reproduces it
// to LUT-quantization); best-effort for a freely-dragged point curve -- the
// same approximate fit LrC makes when you switch a custom point curve back to
// Region. This is what keeps Region and Point one shared value.
export function fitRegionParams(points: number[]): { highlights: number; lights: number; darks: number; shadows: number } {
  const lut = buildToneCurveLut(points);
  // Linear-interpolate the LUT at the anchor x (the 512-sample grid rounds a
  // single sample ~0.5 LUT bin off the anchor, which is a ~1 slider-unit bias).
  const at = (x: number) => {
    const f = Math.max(0, Math.min(TONE_LUT_SIZE - 1, x * (TONE_LUT_SIZE - 1)));
    const i = Math.floor(f);
    const j = Math.min(TONE_LUT_SIZE - 1, i + 1);
    return lut[i] + (lut[j] - lut[i]) * (f - i);
  };
  const slider = (x: number) => {
    const v = Math.round(Math.max(-100, Math.min(100, ((at(x) - x) / 0.12) * 100)));
    return v === 0 ? 0 : v; // -0 === 0, so deep-equality sees a clean zero
  };
  return { highlights: slider(0.88), lights: slider(0.60), darks: slider(0.40), shadows: slider(0.12) };
}

function samplePchip(
  x: number,
  xs: number[],
  ys: number[],
  h: number[],
  m: number[],
  n: number,
): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let seg = 0;
  while (seg < n - 2 && x > xs[seg + 1]) seg++;
  const t = (x - xs[seg]) / h[seg];
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
  const h10 = t ** 3 - 2 * t ** 2 + t;
  const h01 = -2 * t ** 3 + 3 * t ** 2;
  const h11 = t ** 3 - t ** 2;
  return h00 * ys[seg] + h10 * h[seg] * m[seg] + h01 * ys[seg + 1] + h11 * h[seg] * m[seg + 1];
}
