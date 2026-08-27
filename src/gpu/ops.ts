import exposureShader from '../shaders/exposure.wgsl?raw';
import wbShader from '../shaders/wb.wgsl?raw';
import toneShader from '../shaders/tone.wgsl?raw';
import tonecurveShader from '../shaders/tonecurve.wgsl?raw';
import cameraColorShader from '../shaders/cameraColor.wgsl?raw';
import presenceShader from '../shaders/presence.wgsl?raw';
import vignetteShader from '../shaders/vignette.wgsl?raw';
import grainShader from '../shaders/grain.wgsl?raw';
import lightleakShader from '../shaders/lightleak.wgsl?raw';
import frameShader from '../shaders/frame.wgsl?raw';
import bwShader from '../shaders/bw.wgsl?raw';
import cropShader from '../shaders/crop.wgsl?raw';
import { evToGain, kelvinToShift, packColorMatrix, wbShiftToGains, type WhiteBalanceGains } from './uniforms';
import { buildParametricToneLut, buildToneCurveLut, buildToneLuts, TONE_LUT_SIZE, type ToneParams, type ToneLook } from './tone';
import { isPresenceOp, isBwOp, isCropOp, isExposureOp, isFrameOp, isGrainOp, isLightleakOp, isProfileOp, isToneCurveOp, isToneOp, isVignetteOp, isWhiteBalanceOp, type Op, type WbGains } from '../catalog/types';
import { packPresence, type PresenceParams } from './presence';
import { packVignette, type VignetteParams } from './vignette';
import { packGrain, getGrainSeed, type GrainParams } from './grain';
import { packLightleak, type LightleakParams } from './lightleak';
import { packFrame } from './frame';
import { packBw } from './bw';
import { cropFracFromOps, packCrop, type CropParams } from './crop';
import { FILM_STOCKS, isFilmStockId } from './film';
import type { FilmStock } from './film';

// The currently loaded raw's camera color matrix (LibRaw rgb_cam). The
// `profile` op's 'camera' choice resolves against THIS -- a profile op is
// "use this file's embedded camera profile", and the matrix is a property of
// the loaded file, not of the edit. That's why it lives here (updated per
// load by pipeline.load()) instead of inside the op in history: an undo back
// to an old 'camera' snapshot applies the *current* file's matrix, which is
// the Lightroom behavior.
let cameraColorMatrix: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function setCameraColorMatrix(m: Float32Array): void {
  cameraColorMatrix = m;
}

// Read the current camera matrix -- the WB temp/tint readout decomposes
// As-Shot gains through the camera color matrix (the LrC/DNG model), so the
// readout needs it where pure gains used to suffice.
export function getCameraColorMatrix(): Float32Array {
  return cameraColorMatrix;
}

// The loaded raw's camera XYZ->camera colorimetric matrix (LibRaw cam_xyz) --
// what the WB temp/tint readout decomposes As-Shot gains through (the LrC/DNG
// model). rgb_cam (cameraColorMatrix above) is row-normalized and destroys
// chromaticity, so it cannot serve. Undefined when the file has no usable
// matrix (the readout falls back to the legacy axes). Same per-file lifetime
// as cameraColorMatrix.
let cameraXyz: Float32Array | undefined;

export function setCameraXyz(m: Float32Array | undefined): void {
  cameraXyz = m;
}

export function getCameraXyz(): Float32Array | undefined {
  return cameraXyz;
}

// The loaded file's as-shot white-balance gains (LibRaw cam_mul, normalized
// by green), the default the whiteBalance op applies when no WB op is present
// -- a fresh open renders at the camera's own WB ("As Shot"), like LrC. Same
// per-file lifetime as cameraColorMatrix: updated by pipeline.load().
let asShotGains: WhiteBalanceGains = { rGain: 1, gGain: 1, bGain: 1 };

export function setAsShotGains(g: WbGains): void {
  asShotGains = { rGain: g.r, gGain: g.g, bGain: g.b };
}

// The loaded raw's effective size (set by pipeline.load()) -- the crop op's
// geometry (crop.ts) and the vignette/frame cropFrac it feeds are fractions of
// this. Same per-file lifetime as cameraColorMatrix.
let imageSize: [number, number] = [0, 0];

export function setImageSize(w: number, h: number): void {
  imageSize = [w, h];
}

// One GPU pass per edit kind. Pipeline.render() dispatches every renderer
// whose op is present in the current Op[] (in registry order, against the
// ping-pong textures) so the op chain is composable -- the next roadmap op
// (tone curve) lands here as one more entry instead of a rewrite of a fused
// shader. Ops never clamp intermediates: rgba16float carries values > 1 into
// the next op and the srgb8 canvas blit clamps at display time, so the output
// is identical to the old fused adjust.wgsl (which clamped the final product
// of the same gains).
export interface OpRenderer {
  kind: Op['kind'];
  shader: string;
  uniformSize: number; // bytes; matches the scalar-padded WGSL uniform struct
  packParams(ops: Op[]): Float32Array; // full ops list; finds its own op by kind
}

export const OP_RENDERERS: OpRenderer[] = [
  // whiteBalance FIRST: its gains are channel-diagonal and do NOT commute
  // with the profile color matrix, so they must scale the demosaiced camera
  // RGB before the matrix (LrC's order). profile is next (camera->sRGB), then
  // exposure (scalar, so it may sit after the matrix), then tone / tone
  // curve / presence.
  {
    kind: 'whiteBalance',
    shader: wbShader,
    uniformSize: 16, // struct Wb { rGain, gGain, bGain, _pad0 }
    packParams: (ops) => {
      const op = ops.find(isWhiteBalanceOp);
      // Exact As-Shot gains win when present (kelvin+tint can't represent an
      // arbitrary cam_mul -- it forces rGain*bGain=1). `?? 0` tolerates
      // pre-tint stored rows; an absent op falls back to the loaded file's
      // As-Shot, so a fresh open renders at the camera's own WB.
      const g: WhiteBalanceGains = op
        ? (op.gains
            ? { rGain: op.gains.r, gGain: op.gains.g, bGain: op.gains.b }
            : wbShiftToGains(kelvinToShift(op.kelvin), op.tint ?? 0))
        : asShotGains;
      return new Float32Array([g.rGain, g.gGain, g.bGain, 0]);
    },
  },
  {
    kind: 'profile',
    shader: cameraColorShader,
    uniformSize: 48, // struct ColorMat { rows: array<vec4<f32>, 3> }
    packParams: (ops) => {
      const op = ops.find(isProfileOp);
      const m = op?.profile === 'neutral' ? new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) : cameraColorMatrix;
      return packColorMatrix(m);
    },
  },
  {
    kind: 'exposure',
    shader: exposureShader,
    uniformSize: 16, // struct Exposure { gain, _pad0, _pad1, _pad2 }
    packParams: (ops) => {
      const op = ops.find(isExposureOp);
      return new Float32Array([op ? evToGain(op.ev) : 1, 0, 0, 0]);
    },
  },
  {
    kind: 'tone',
    shader: toneShader,
    // 6144 B: three 512-entry per-channel LUTs (R/G/B). The default look is
    // the CAMERA look (fitted from the embedded JPEG -- the app renders like
    // the camera back): a single shared curve (cameraOutput in tone.ts) --
    // ACR baseline + neutral film-sim shadow lift, no per-channel cast (the
    // ฟ้าส้ม fix). The 3-LUT layout stays for future per-camera fits; profile
    // 'neutral' selects the ACR baseline as the generic fallback.
    uniformSize: TONE_LUT_SIZE * 4 * 3,
    packParams: (ops) => {
      const op = ops.find(isToneOp);
      const p: ToneParams = op ?? { contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
      // The active profile picks the tone base: 'neutral' -> ACR baseline, a
      // film stock -> that stock's H-D response (per-channel), else the camera
      // look. The tone sliders perturb whichever base is active.
      const profile = ops.find(isProfileOp)?.profile;
      let look: ToneLook = 'camera';
      let stock: FilmStock | undefined;
      if (profile === 'neutral') look = 'standard';
      else if (profile !== undefined && isFilmStockId(profile)) {
        look = 'film';
        stock = FILM_STOCKS[profile];
      }
      return buildToneLuts(p, look, stock);
    },
  },
  {
    kind: 'bw',
    // AFTER `tone`: the stock's per-channel H-D tone (which differs per
    // channel and would cast gray) shapes the pre-conversion color, then this
    // pass drops chroma and applies the mono tone. toneCurve/presence/vignette
    // run on the gray image after it. Absent op = Color treatment (no-op).
    shader: bwShader,
    uniformSize: (8 + 4 + TONE_LUT_SIZE) * 4, // struct Bw { mix, mix2, tone, lut }
    packParams: (ops) => {
      const op = ops.find(isBwOp);
      const p = op ?? { mix: [0, 0, 0, 0, 0, 0, 0, 0], tone: 'none' as const };
      return packBw(p);
    },
  },
  {
    kind: 'toneCurve',
    // tonecurve.wgsl: plain luma-ratio LUT. NOT tone.wgsl -- the tone op's
    // shader now applies the ACR baseline per-channel, and re-baselining here
    // would compress the highlights a second time.
    shader: tonecurveShader,
    uniformSize: TONE_LUT_SIZE * 4,
    packParams: (ops) => {
      const op = ops.find(isToneCurveOp);
      // Region mode packs the parametric LrC curve; point (or absent -> the
      // linear default) packs the direct curve. Either way an identity LUT
      // renders as a no-op pass.
      if (op?.mode === 'region') {
        return buildParametricToneLut(op.highlights, op.lights, op.darks, op.shadows);
      }
      // After the region branch, op is point mode (or a pre-region legacy row
      // carrying `points` -- isToneCurveOp matches those too). Absent op packs
      // the linear default.
      return buildToneCurveLut(op ? op.points : [0, 0, 1, 1]);
    },
  },
  {
    kind: 'presence',
    shader: presenceShader,
    uniformSize: 32, // struct Presence { 5 f32 + 3 pad }
    packParams: (ops) => {
      const op = ops.find(isPresenceOp);
      const p: PresenceParams = op ?? { texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 };
      return packPresence(p);
    },
  },
  {
    kind: 'lightleak',
    // A creative display-level effect (not in LrC) that belongs BEFORE the
    // crop: it bakes into the cropped content (cropping a leaked shot keeps
    // the leak), and its X-Half shape spreads corner-to-corner. Seed shared
    // with grain (same film-roll character). Absent op packs the neutral
    // defaults (amount 0) so a no-op pass renders as identity.
    shader: lightleakShader,
    uniformSize: 32, // struct Lightleak { 3 f32 + 5 pad }
    packParams: (ops) => {
      const op = ops.find(isLightleakOp);
      const p: LightleakParams = op ?? { amount: 0, hue: 0 };
      return packLightleak(p, getGrainSeed());
    },
  },
  {
    kind: 'crop',
    // AFTER lightleak, BEFORE vignette/frame: the crop rect defines the
    // post-crop content the vignette (LrC's Post-Crop Vignetting) and the
    // film frame wrap, and its black bars fall through to the blit as the
    // letterbox bars. Runs only when a crop op is present (original/0°/0 is
    // neutral and never emitted).
    shader: cropShader,
    uniformSize: 32, // struct Crop { angle, zoom, halfW, halfH + 4 pad }
    packParams: (ops) => {
      const op = ops.find(isCropOp);
      const p: CropParams = op ?? { aspect: 'original', rotate90: 0, angle: 0 };
      return packCrop(p, imageSize[0], imageSize[1]);
    },
  },
  {
    kind: 'vignette',
    // A display-level effect (LrC's Effects panel applies it after the
    // color/tone chain) -- LrC calls this Post-Crop Vignetting: the cropFrac
    // uniform spans it across the image inside the crop. Absent op packs the
    // neutral defaults (amount 0, midpoint/feather 50) so a no-op pass renders
    // as identity.
    shader: vignetteShader,
    uniformSize: 32, // struct Vignette { 5 f32 + cropFracX/Y + pad }
    packParams: (ops) => {
      const op = ops.find(isVignetteOp);
      const p: VignetteParams = op ?? { amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0 };
      return packVignette(p, cropFracFromOps(ops, imageSize[0], imageSize[1]));
    },
  },
  {
    kind: 'grain',
    // LrC's Effects panel applies grain on top of the vignette. Display-
    // referred seeded luminance noise, seeded per-photo so the pattern is
    // deterministic. Absent op packs the neutral defaults (amount 0) so a
    // no-op pass renders as identity.
    shader: grainShader,
    uniformSize: 32, // struct Grain { 4 f32 + 4 pad }
    packParams: (ops) => {
      const op = ops.find(isGrainOp);
      const p: GrainParams = op ?? { amount: 0, size: 25, roughness: 50 };
      return packGrain(p, getGrainSeed());
    },
  },
  {
    kind: 'frame',
    // LAST -- the film rebate / print matte wraps everything (nothing draws
    // over it). With a crop it wraps the image inside the crop, black bars
    // beyond. A style switch like bw: absent op = 'none' = identity (no
    // frame), so the renderer is only ever present when a style is active.
    shader: frameShader,
    uniformSize: 16, // struct Frame { style + cropFracX/Y + pad }
    packParams: (ops) => {
      const op = ops.find(isFrameOp);
      return packFrame(op?.style ?? 'none', cropFracFromOps(ops, imageSize[0], imageSize[1]));
    },
  },
];

// Registry indices of the ops present in `ops`, in registry (application)
// order -- op chain order is fixed by the registry, not by Op[] order. Three
// passes ALWAYS run, even with no ops (fresh open): whiteBalance (As-Shot
// fallback) + profile (camera matrix) because demosaiced camera RGB is neither
// white-balanced nor displayable without them, and tone because neutral tone
// params now render the ACR baseline curve -- the look LrC opens every photo
// with (see tone.ts). exposure/toneCurve/presence stay optional.
const MANDATORY_KINDS: ReadonlySet<Op['kind']> = new Set(['whiteBalance', 'profile', 'tone']);
export function presentOpIndices(ops: Op[]): number[] {
  return OP_RENDERERS.map((r, i) => (MANDATORY_KINDS.has(r.kind) || ops.some((o) => o.kind === r.kind) ? i : -1)).filter(
    (i) => i >= 0,
  );
}
