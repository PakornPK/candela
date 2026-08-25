import exposureShader from '../shaders/exposure.wgsl?raw';
import wbShader from '../shaders/wb.wgsl?raw';
import toneShader from '../shaders/tone.wgsl?raw';
import cameraColorShader from '../shaders/cameraColor.wgsl?raw';
import presenceShader from '../shaders/presence.wgsl?raw';
import { evToGain, kelvinToShift, packColorMatrix, wbShiftToGains, type WhiteBalanceGains } from './uniforms';
import { buildParametricToneLut, buildToneCurveLut, buildToneLut, TONE_LUT_SIZE, type ToneParams } from './tone';
import { isPresenceOp, isExposureOp, isProfileOp, isToneCurveOp, isToneOp, isWhiteBalanceOp, type Op, type WbGains } from '../catalog/types';
import { packPresence, type PresenceParams } from './presence';

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

// The loaded file's as-shot white-balance gains (LibRaw cam_mul, normalized
// by green), the default the whiteBalance op applies when no WB op is present
// -- a fresh open renders at the camera's own WB ("As Shot"), like LrC. Same
// per-file lifetime as cameraColorMatrix: updated by pipeline.load().
let asShotGains: WhiteBalanceGains = { rGain: 1, gGain: 1, bGain: 1 };

export function setAsShotGains(g: WbGains): void {
  asShotGains = { rGain: g.r, gGain: g.g, bGain: g.b };
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
    uniformSize: TONE_LUT_SIZE * 4, // 2048 B = 512 f32 = array<vec4<f32>,128>
    packParams: (ops) => {
      const op = ops.find(isToneOp);
      const p: ToneParams = op ?? { contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
      return buildToneLut(p);
    },
  },
  {
    kind: 'toneCurve',
    shader: toneShader, // same LUT lookup; only the LUT contents differ
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
];

// Registry indices of the ops present in `ops`, in registry (application)
// order -- op chain order is fixed by the registry, not by Op[] order. The
// first two passes (whiteBalance As-Shot fallback + profile camera matrix)
// ALWAYS run: demosaiced camera RGB is neither white-balanced nor displayable
// without them, so even a no-ops fresh open (renderOps([])) applies both.
const MANDATORY_PASSES = 2;
export function presentOpIndices(ops: Op[]): number[] {
  return OP_RENDERERS.map((r, i) => (i < MANDATORY_PASSES || ops.some((o) => o.kind === r.kind) ? i : -1)).filter(
    (i) => i >= 0,
  );
}
