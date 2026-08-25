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
// across the whole domain and both tools act where the eye cares. The neutral
// response is exact identity: lut[i] = i/(N-1) maps back through the shader's
// exp2 to the same luminance.
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

export interface ToneParams {
  contrast: number; // -100..100, 0 neutral
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export const TONE_LUT_SIZE = 512;

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

export function isNeutralTone(p: ToneParams): boolean {
  return p.contrast === 0 && p.highlights === 0 && p.shadows === 0 && p.whites === 0 && p.blacks === 0;
}

// Smoothstep ramps 0->1 between a and b; used to confine a region tool's
// influence to its tonal band (see buildToneLut stages 3/4).
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function buildToneLut(p: ToneParams): Float32Array {
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
  // Contrast pivots at mid-gray (0.18 linear = display mid-gray), NOT the
  // domain midpoint: LrC anchors contrast at the visible midtones, and a
  // pivot at y=0.5 (-4 EV, deep shadow) darkened shadows out of proportion
  // -- the "contrast scale doesn't match" feel.
  const yMid = logToNorm(0.18);

  const lut = new Float32Array(TONE_LUT_SIZE);
  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    let y = i / (TONE_LUT_SIZE - 1);

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
// ponytail: anchor positions (0.12/0.40/0.60/0.88) and per-slider strengths
// approximate LrC's; tune against screenshots.
export function parametricControlPoints(
  highlights: number,
  lights: number,
  darks: number,
  shadows: number,
): number[] {
  const h = highlights / 100, l = lights / 100, d = darks / 100, s = shadows / 100;
  return [
    0.0, 0.0,
    0.12 + 0.03 * d, 0.12 + 0.12 * s,
    0.40 - 0.05 * d - 0.02 * l, 0.40 + 0.12 * d,
    0.60 + 0.05 * l + 0.02 * h, 0.60 + 0.12 * l,
    0.88 - 0.03 * h, 0.88 + 0.12 * h,
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
