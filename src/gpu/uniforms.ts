import type { WbGains } from '../catalog/types';

export function evToGain(ev: number): number {
  return Math.pow(2, ev);
}

export interface WhiteBalanceGains {
  rGain: number;
  gGain: number;
  bGain: number;
}

// wbShift in [-1, 1]: positive shifts warmer (boost red, cut blue).
// tint in [-150, 150] (LrC's range): positive shifts magenta (cut green),
// negative shifts green (boost green) -- the green/magenta axis orthogonal to
// the blue/yellow Kelvin axis.
export function wbShiftToGains(wbShift: number, tint = 0): WhiteBalanceGains {
  // Exponential gains: ±1 shift = ±1 stop (2x / 0.5x). The old linear gains
  // (1 ± 0.5c) capped at 1.5x / 0.67x -- the "extremes too weak" complaint.
  // 2^c is always positive, so no gain can go negative (the previous clamp
  // existed to stop 1 + 0.5c dipping below 0).
  const c = Math.max(-1, Math.min(1, wbShift));
  // tint exponent 2: +150 cuts green to 2^-2 = 0.25 (strong magenta), +30 ->
  // 2^-0.4 = 0.76 -- a small move is already visible, matching LrC's
  // "นิดเดียวก็เข้ม" response.
  const t = Math.max(-1, Math.min(1, tint / 150));
  return {
    rGain: Math.pow(2, c),
    gGain: Math.pow(2, -t * 2),
    bGain: Math.pow(2, -c),
  };
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

// Re-indexes a 6x6 CFA pattern for a cropped texture whose pixel (x,y) is the
// source buffer's pixel (x+left, y+top). The demosaic reads pattern[(y%6)*6 +
// x%6] at texture position (x,y), so the cropped pattern must look up the
// source pattern at ((y+top)%6, (x+left)%6). A no-op when the crop offsets are
// whole pattern periods (e.g. top=6 on X-Trans) -- but Bayer cameras with odd
// margins would mis-phase every pixel without it.
export function shiftCfa6(cfa6: Uint8Array, left: number, top: number): Uint8Array {
  const out = new Uint8Array(36);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      out[y * 6 + x] = cfa6[((y + top) % 6) * 6 + ((x + left) % 6)];
    }
  }
  return out;
}

// Camera -> linear sRGB 3x3 (row-major, 9 floats) padded to 3 vec4s, matching
// the `ColorMat` struct in cameraColor.wgsl (one vec4 per output row, .w pad).
export function packColorMatrix(m: Float32Array): Float32Array {
  if (m.length !== 9) {
    throw new Error(`Expected 9 matrix entries, got ${m.length}`);
  }
  return new Float32Array([
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
  ]);
}

export const WB_NEUTRAL_KELVIN = 5500;
export const WB_MIN_KELVIN = 2000;
export const WB_MAX_KELVIN = 50000;

// UI-facing conversion only: the WB slider is displayed in Kelvin (2000..50000,
// LrC's full range), but the gain math above (wbShiftToGains) and the GPU
// uniform layout stay in their existing [-1, 1] shift space. MIRED-linear:
// mired = 1e6/K is the perceptually uniform temperature scale, so shift is
// linear in mired and each equal slider step is an equal warmth step. This is
// the fix for "temp slider is clustered": on a linear-Kelvin track the whole
// cool half of the response (2000..5500K) sat in the left ~7% of the width.
// Both ends still reach ±1 (full shift). 5500K -> 0. Not a physically
// accurate color-temperature model.
export function kelvinToShift(kelvin: number): number {
  const m = 1e6 / kelvin;
  const mN = 1e6 / WB_NEUTRAL_KELVIN;
  if (m > mN) return -(m - mN) / (1e6 / WB_MIN_KELVIN - mN); // cool: 5500..2000K -> 0..-1
  if (m < mN) return (mN - m) / (mN - 1e6 / WB_MAX_KELVIN); // warm: 5500..50000K -> 0..+1
  return 0; // exact neutral (m == mN): avoid the cool branch's -0
}

// Inverse of kelvinToShift. Used for the WB slider readout when an edit
// carries exact As-Shot gains -- the slider is still a kelvin track. Clamps
// like the forward direction (which is bounded to [-1, 1] by the Kelvin
// range), so an out-of-range shift reads as the corresponding end.
export function shiftToKelvin(c: number): number {
  const s = Math.max(-1, Math.min(1, c));
  const mN = 1e6 / WB_NEUTRAL_KELVIN;
  if (s < 0) return 1e6 / (mN + -s * (1e6 / WB_MIN_KELVIN - mN));
  if (s > 0) return 1e6 / (mN - s * (mN - 1e6 / WB_MAX_KELVIN));
  return WB_NEUTRAL_KELVIN;
}

// ---------------------------------------------------------------------------
// As-Shot gains -> LrC temp/tint readout (display only; the render keeps the
// exact gains until the user drags)
// ---------------------------------------------------------------------------
// The DNG model LrC's readout follows: the camera neutral (reciprocal of the
// As-Shot gains) is mapped through the camera's XYZ->camera matrix (cam_xyz)
// to CIE XYZ, its chromaticity decomposed on the Planckian locus (Robertson
// 1968) into temperature + D_uv, and tint = -3000 * D_uv (LrC's tint scale).
// rgb_cam (the render matrix) is row-normalized and destroys chromaticity, so
// cam_xyz is required -- these functions take it as an optional argument and
// fall back to the legacy R/B-ratio axes (below) when the file has no usable
// matrix.
//
// Calibration of the readout to LrC, per camera. The DNG model (cam_xyz
// inverse -> xy -> Robertson -> temp/tint) matches LrC when LibRaw's camera
// matrix is colorimetrically close to Adobe's; cameras whose LibRaw matrix
// deviates need a per-camera correction keyed by make+model. Default is
// identity (no correction), so an accurate-matrix camera reads the raw
// formula and the X100V's correction never leaks onto it.
//
// The ONE measured camera is the Fuji X100V fixture (sample.raf): LrC opens
// it at 5350K / +35 (user-measured on DSCF8946.RAF, re-fit 2026-08-26), while
// the As-Shot gains decompose through LibRaw's cam_xyz as 4521.83 K / +46.50.
// LibRaw's X100V matrix is known-anomalous -- its Z-row R coefficient
// (+0.058) flips sign vs the whole X100 family in LibRaw's own table (X100F
// -0.067, X100S/T -0.087), a ~900K-too-warm white point -- so a constant
// mired/tint offset calibrates the whole X100V range, not just the anchor.
// ponytail: one anchor per camera -> constant offset; fit a second anchor for
// a camera and fitWbCalibration upgrades it to a slope (a 2-point line).
export interface WbCalibration {
  miredSlope: number;
  miredIntercept: number;
  tintSlope: number;
  tintIntercept: number;
}

export interface WbAnchor {
  formulaKelvin: number; // DNG-model readout of the camera's As-Shot gains
  displayKelvin: number; // what LrC actually reads at that white point
  formulaTint: number;
  displayTint: number;
}

// Affine fit in mired/tint space: display = formula * slope + intercept.
// One anchor -> constant offset (slope 1); two or more -> least-squares line
// (exact through 2, which is the "2-point fit"). The fit lives in mired
// (1e6/K), not Kelvin, because isotemperature lines are near-parallel in
// mired and nearly hyperbolic in Kelvin.
export function fitWbCalibration(anchors: WbAnchor[]): WbCalibration {
  const fitLine = (ax: number[], ay: number[]): [number, number] => {
    const n = ax.length;
    if (n === 0) return [1, 0];
    if (n === 1) return [1, ay[0] - ax[0]];
    const mx = ax.reduce((s, v) => s + v, 0) / n;
    const my = ay.reduce((s, v) => s + v, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (ax[i] - mx) ** 2;
      sxy += (ax[i] - mx) * (ay[i] - my);
    }
    const slope = sxx > 0 ? sxy / sxx : 1;
    return [slope, my - slope * mx];
  };
  const mired = fitLine(
    anchors.map((a) => 1e6 / a.formulaKelvin),
    anchors.map((a) => 1e6 / a.displayKelvin),
  );
  const tint = fitLine(
    anchors.map((a) => a.formulaTint),
    anchors.map((a) => a.displayTint),
  );
  return { miredSlope: mired[0], miredIntercept: mired[1], tintSlope: tint[0], tintIntercept: tint[1] };
}

const WB_CALIBRATIONS: Readonly<Record<string, WbCalibration>> = {
  'Fujifilm X100V': fitWbCalibration([
    { formulaKelvin: 4521.83, displayKelvin: 5350, formulaTint: 46.5, displayTint: 35 },
  ]),
};

// Normalized "MAKE MODEL" key for the registry. LibRaw title-cases the EXIF
// identity (verified: "Fujifilm X100V", "Nikon D800"), so the registry keys
// use that exact form; trimming here tolerates files whose fields carry
// trailing whitespace.
export function cameraCalibrationKey(make: string, model: string): string {
  return `${(make || '').trim()} ${(model || '').trim()}`.trim();
}

export function wbCalibrationFor(cameraKey?: string): WbCalibration {
  return (cameraKey && WB_CALIBRATIONS[cameraKey]) || { miredSlope: 1, miredIntercept: 0, tintSlope: 1, tintIntercept: 0 };
}

// Robertson (1968) isotemperature table: [i, u, v, dv/du] in CIE-1960 uv
// (colour-science `_uv_to_CCT_Robertson1968`, verbatim). The temperature is
// found by interpolating in mired between the two nearest isotemperature
// lines; D_uv is the signed distance from the interpolated line.
const ROBERTSON_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0.18006, 0.26352, -0.24341],
  [10, 0.18066, 0.26589, -0.25479],
  [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.3047],
  [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156],
  [70, 0.18611, 0.28342, -0.37915],
  [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278],
  [100, 0.19032, 0.29326, -0.47888],
  [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471],
  [175, 0.20525, 0.31647, -0.84901],
  [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512],
  [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637],
  [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814],
  [400, 0.27218, 0.35407, -4.3633],
  [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262],
  [475, 0.29685, 0.35823, -8.5955],
  [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325],
  [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
];

// xy chromaticity -> (correlated color temperature, tint) via Robertson
// (1968), exactly the colour-science `_uv_to_CCT_Robertson1968` algorithm.
// tint = -3000 * D_uv, already on LrC's -150..+150 tint scale.
export function xyToCctAndTint(x: number, y: number): { kelvin: number; tint: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { kelvin: WB_NEUTRAL_KELVIN, tint: 0 };
  const d = 1.5 - x + 6 * y;
  if (d <= 0) return { kelvin: WB_NEUTRAL_KELVIN, tint: 0 };
  const u = (2 * x) / d;
  const v = (3 * y) / d;
  let lastDt = 0;
  let lastDu = 0;
  let lastDv = 0;
  let kelvin = WB_NEUTRAL_KELVIN;
  let D = 0;
  for (let i = 1; i <= 30; i++) {
    const [curT, curU, curV, slope] = ROBERTSON_TABLE[i];
    const [prevT, prevU, prevV] = ROBERTSON_TABLE[i - 1];
    let du = 1;
    let dv = slope;
    let len = Math.hypot(1, dv);
    du /= len;
    dv /= len;
    const uu = u - curU;
    const vv = v - curV;
    let dt = -uu * dv + vv * du;
    if (dt <= 0 || i === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = i === 1 ? 0 : dt / (lastDt + dt);
      const r = prevT * f + curT * (1 - f);
      kelvin = 1e6 / r;
      let a = u - (prevU * f + curU * (1 - f));
      let b = v - (prevV * f + curV * (1 - f));
      du = du * (1 - f) + lastDu * f;
      dv = dv * (1 - f) + lastDv * f;
      len = Math.hypot(du, dv);
      du /= len;
      dv /= len;
      D = a * du + b * dv;
      break;
    }
    lastDt = dt;
    lastDu = du;
    lastDv = dv;
  }
  return { kelvin, tint: -3000 * D };
}

// 3x3 inverse (row-major), null when singular -- cam_xyz is a genuine camera
// matrix, but a corrupt file could zero it, and the fallback below is safe.
function invert3x3(m: Float32Array): Float32Array | null {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];
  const e = m[4];
  const f = m[5];
  const g = m[6];
  const h = m[7];
  const i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  return new Float32Array([
    A / det, D / det, G / det,
    B / det, E / det, H / det,
    C / det, F / det, I / det,
  ]);
}

// Full readout: the LrC/DNG model when the camera's XYZ->camera matrix is
// available, else the legacy R/B-ratio axes (below). cameraKey (the
// normalized "MAKE MODEL", see cameraCalibrationKey) selects the per-camera
// calibration; absent/unknown cameras read the raw formula (identity).
export function gainsToReadout(g: WbGains, camXyz?: Float32Array, cameraKey?: string): { kelvin: number; tint: number } {
  const r = Math.max(g.r, 1e-6);
  const b = Math.max(g.b, 1e-6);
  if (camXyz) {
    const inv = invert3x3(camXyz);
    if (inv) {
      // Camera neutral = reciprocal of the As-Shot gains; green-normalized
      // files carry g=1, but a tint-tweaked op carries gGain != 1 and it must
      // move the tint readout too.
      const cw = [1 / r, 1 / Math.max(g.g, 1e-6), 1 / b];
      const X = inv[0] * cw[0] + inv[1] * cw[1] + inv[2] * cw[2];
      const Y = inv[3] * cw[0] + inv[4] * cw[1] + inv[5] * cw[2];
      const Z = inv[6] * cw[0] + inv[7] * cw[1] + inv[8] * cw[2];
      const sum = X + Y + Z;
      if (sum > 1e-12) {
        const raw = xyToCctAndTint(X / sum, Y / sum);
        const cal = wbCalibrationFor(cameraKey);
        const kelvin = 1e6 / (cal.miredSlope * (1e6 / raw.kelvin) + cal.miredIntercept);
        const tint = Math.max(-150, Math.min(150, cal.tintSlope * raw.tint + cal.tintIntercept));
        return { kelvin: Math.max(2000, Math.min(50000, kelvin)), tint };
      }
    }
  }
  // Legacy fallback: temp axis is the R/B ratio (wbShiftToGains maps shift c
  // to rGain=2^c, bGain=2^-c, so the shift matching a (r,b) pair is the
  // midpoint of the two log gains); tint is the green residual -- a pure
  // temperature keeps rGain*bGain=1, so a product >1 means both R and B need
  // green cut (magenta cast, +tint), <1 a green boost (-tint).
  const c = Math.max(-1, Math.min(1, 0.5 * (Math.log2(r) - Math.log2(b))));
  const p = Math.log2(r) + Math.log2(b);
  return { kelvin: shiftToKelvin(c), tint: Math.max(-150, Math.min(150, 37.5 * p)) };
}

export function gainsToKelvin(g: WbGains, camXyz?: Float32Array, cameraKey?: string): number {
  return gainsToReadout(g, camXyz, cameraKey).kelvin;
}

export function gainsToTint(g: WbGains, camXyz?: Float32Array, cameraKey?: string): number {
  return gainsToReadout(g, camXyz, cameraKey).tint;
}
