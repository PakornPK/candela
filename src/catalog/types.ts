export interface FolderRecord {
  id: number;
  handle: FileSystemDirectoryHandle;
  name: string;
  addedAt: number;
}

export interface FileRecord {
  id: number;
  folderId: number;
  path: string; // relative to the folder root, e.g. "day1/img001.cr3"
  name: string;
  handle: FileSystemFileHandle;
  size: number;
  lastModified: number;
  // Culling marks -- optional so existing rows load unchanged (IndexedDB rows
  // are schemaless; no version bump needed for these).
  flag?: boolean; // true = picked, false = rejected; absent = unflagged
  rating?: number; // 1..5 stars, absent = unrated
  color?: number; // 1..4 red/yellow/green/blue, absent = none
}

// The tone curve op has two shapes -- LrC's "Adjust:" modes. `region` is the
// parametric curve (4 tonal-region sliders), `point` is the direct curve
// editor (flat [x0,y0,...] list). Stored rows from before the region mode
// existed have `{kind:'toneCurve', points}` with no `mode`; isValidOp treats
// those as point mode.
export type ToneCurveOp =
  | { kind: 'toneCurve'; mode: 'region'; highlights: number; lights: number; darks: number; shadows: number }
  | { kind: 'toneCurve'; mode: 'point'; points: number[] };

// Raw white-balance channel gains (green-normalized: g=1). The `whiteBalance`
// op carries these when it's an As-Shot WB -- a camera's cam_mul is not
// representable as kelvin+tint in wbShiftToGains (which forces rGain*bGain=1),
// so the exact gains must survive as an op field to render the camera's own
// white point faithfully.
export interface WbGains {
  r: number;
  g: number;
  b: number;
}

// Film-stock ids, defined here (the shared type layer) and keyed by the
// FILM_STOCKS registry in gpu/film.ts. Kept as an explicit union so the
// profile picker and history rows never hold an unknown stock.
export type FilmStockId =
  | 'portra400'
  | 'portra160'
  | 'portra800'
  | 'gold200'
  | 'ektar100'
  | 'superia400'
  | 'ektachrome100'
  | 'provia100f'
  | 'velvia50'
  | 'cinestill800t';

// The color-profile picker's options. 'camera' = the loaded raw's embedded
// camera profile (LibRaw rgb_cam -- the default), 'neutral' = identity matrix,
// a FilmStockId = that stock's film-sim look (per-channel H-D tone; color stays
// camera-based -- the matrix does not change).
export type ProfileKind = 'camera' | 'neutral' | FilmStockId;

// B&W treatment (LrC's Color Mixer -> B&W): the 8 hue-band mix weights
// (Red/Orange/Yellow/Green/Aqua/Blue/Purple/Magenta, each -100..100, 0 =
// that hue contributes its normal luminance) plus an optional monochrome film
// tone curve (ACROS, Tri-X 400, Double-X, Leica Monochrom -- baked into the
// bw op's LUT).
export type BwMix = [number, number, number, number, number, number, number, number];
export type BwToneId = 'none' | 'acros' | 'tx400' | 'doublex' | 'leica';

// Film-frame style (Effects panel). 'none' = no frame.
export type FrameStyle = 'none' | '135' | '120' | 'print';

// Crop tool aspect preset ('original' = the source's own ratio, resolved per
// file at render time -- not a number here so isValidOp stays closed).
export type AspectPreset = 'original' | '1:1' | '3:2' | '4:3' | '5:4' | '16:9' | '2:3' | '4:5';

export type Op =
  | { kind: 'profile'; profile: ProfileKind }
  | { kind: 'exposure'; ev: number }
  | { kind: 'whiteBalance'; kelvin: number; tint: number; gains?: WbGains }
  | { kind: 'tone'; contrast: number; highlights: number; shadows: number; whites: number; blacks: number }
  | ToneCurveOp
  | { kind: 'presence'; texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number }
  | { kind: 'vignette'; amount: number; midpoint: number; roundness: number; feather: number; highlights: number }
  | { kind: 'grain'; amount: number; size: number; roughness: number }
  | { kind: 'lightleak'; amount: number; hue: number }
  | { kind: 'crop'; aspect: AspectPreset; rotate90: number; angle: number }
  | { kind: 'frame'; style: FrameStyle }
  | { kind: 'bw'; mix: BwMix; tone: BwToneId }
  | { kind: 'geometry'; vertical: number; horizontal: number; rotate: number; aspect: number; scale: number; offsetX: number; offsetY: number }
  | {
      kind: 'dodgeBurn';
      amount: number;    // 0..100 brush strength magnitude -> 0..4 EV
      size: number;      // 1..100 brush radius % (UI restore)
      opacity: number;   // 1..100 live mask gain, /50 (UI restore)
      feather: number;   // 0..100 live edge blur, /2500 of mask max edge (UI restore)
      mask: Int8Array;   // signed density, maskW*maskH, /127 (see gpu/dodge.ts)
      maskW: number;
      maskH: number;
    };
  // future op kinds (dodgeBurn, ...) extend this union.

export function isProfileOp(op: Op): op is { kind: 'profile'; profile: ProfileKind } {
  return op.kind === 'profile';
}

export function isExposureOp(op: Op): op is { kind: 'exposure'; ev: number } {
  return op.kind === 'exposure';
}

export function isWhiteBalanceOp(op: Op): op is { kind: 'whiteBalance'; kelvin: number; tint: number; gains?: WbGains } {
  return op.kind === 'whiteBalance';
}

export function isToneOp(op: Op): op is { kind: 'tone'; contrast: number; highlights: number; shadows: number; whites: number; blacks: number } {
  return op.kind === 'tone';
}

export function isToneCurveOp(op: Op): op is ToneCurveOp {
  return op.kind === 'toneCurve';
}

export function isPresenceOp(
  op: Op,
): op is { kind: 'presence'; texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number } {
  return op.kind === 'presence';
}

export function isVignetteOp(
  op: Op,
): op is { kind: 'vignette'; amount: number; midpoint: number; roundness: number; feather: number; highlights: number } {
  return op.kind === 'vignette';
}

export function isBwOp(op: Op): op is { kind: 'bw'; mix: BwMix; tone: BwToneId } {
  return op.kind === 'bw';
}

export function isGrainOp(op: Op): op is { kind: 'grain'; amount: number; size: number; roughness: number } {
  return op.kind === 'grain';
}

export function isLightleakOp(op: Op): op is { kind: 'lightleak'; amount: number; hue: number } {
  return op.kind === 'lightleak';
}

export function isCropOp(op: Op): op is { kind: 'crop'; aspect: AspectPreset; rotate90: number; angle: number } {
  return op.kind === 'crop';
}

export function isFrameOp(op: Op): op is { kind: 'frame'; style: FrameStyle } {
  return op.kind === 'frame';
}

export function isGeometryOp(
  op: Op,
): op is { kind: 'geometry'; vertical: number; horizontal: number; rotate: number; aspect: number; scale: number; offsetX: number; offsetY: number } {
  return op.kind === 'geometry';
}

export function isDodgeBurnOp(
  op: Op,
): op is { kind: 'dodgeBurn'; amount: number; size: number; opacity: number; feather: number; mask: Int8Array; maskW: number; maskH: number } {
  return op.kind === 'dodgeBurn';
}

export interface EditState {
  history: Op[][]; // one snapshot per commit, oldest first
  cursor: number;  // current state = history[cursor]
}
