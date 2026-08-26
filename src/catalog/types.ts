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

export type Op =
  | { kind: 'profile'; profile: ProfileKind }
  | { kind: 'exposure'; ev: number }
  | { kind: 'whiteBalance'; kelvin: number; tint: number; gains?: WbGains }
  | { kind: 'tone'; contrast: number; highlights: number; shadows: number; whites: number; blacks: number }
  | ToneCurveOp
  | { kind: 'presence'; texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number }
  | { kind: 'vignette'; amount: number; midpoint: number; roundness: number; feather: number; highlights: number };
  // future op kinds (crop, ...) extend this union.

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

export interface EditState {
  history: Op[][]; // one snapshot per commit, oldest first
  cursor: number;  // current state = history[cursor]
}
