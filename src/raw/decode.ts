import { getLibRawModule } from './librawModule';

// LibRaw's LibRaw::COLOR() return values, matched to wrapper.cpp's packing:
// 0=R, 1=G, 2=B, 3=G (second green in a Bayer quad).
const CFA_COLORS = ['R', 'G', 'B', 'G'] as const;

// wrapper.cpp packs the 2x2 CFA sample MSB-first into a uint32_t:
// bits [31:24]=(row0,col0), [23:16]=(row0,col1), [15:8]=(row1,col0), [7:0]=(row1,col1).
// Documented unpack formula there: for i in 0..3, byte i (MSB-first) is
// (packed >> ((3-i)*8)) & 0xFF. This loop walks i from 3 down to 0 so that
// the byte shifted by (i*8) is read out in MSB-first order (i=3 -> bits
// [31:24] first, ..., i=0 -> bits [7:0] last), which produces the same
// ordering as the documented formula.
function unpackCfaPattern(packed: number): string {
  let pattern = '';
  for (let i = 3; i >= 0; i--) {
    const colorIndex = (packed >> (i * 8)) & 0xff;
    pattern += CFA_COLORS[colorIndex] ?? '?';
  }
  return pattern;
}

export class DecodeError extends Error {
  constructor(public readonly code: number) {
    super(`LibRaw decode failed with code ${code}`);
    this.name = 'DecodeError';
  }
}

export interface CameraMeta {
  iso: number; // ISO speed; 0 = not reported
  shutter: number; // exposure time in seconds (1/140s -> 0.00714); 0 = not reported
  aperture: number; // f-number; 0 = not reported
  focal: number; // focal length in mm; 0 = not reported
}

export interface DecodedRaw {
  width: number;
  height: number;
  // Effective (cropped) image area inside the raw buffer. raw_width/raw_height
  // include sensor margins (Fuji X100V RAF reports 6384x4182 vs 6240x4160
  // real); LrC and the camera JPEG both render the effective area, so the
  // GPU texture / render must crop to it or dark margin pixels drag exposure
  // down. leftMargin/topMargin are the pixel offsets of the effective area
  // within the raw buffer (0 when raw == effective).
  effectiveWidth: number;
  effectiveHeight: number;
  leftMargin: number;
  topMargin: number;
  blackLevel: number;
  whiteLevel: number;
  cfaPattern: string;
  // Full 6x6 CFA from the wrapper (one byte per position, row-major, 0=R
  // 1=G 2=B). Bayer cameras tile their 2x2 to fill it, so demosaic.wgsl can
  // always use a 6x6 lookup.
  cfa6: Uint8Array;
  bayerData: Uint16Array;
  // Camera -> linear sRGB 3x3 (row-major), folded from LibRaw's rgb_cam by
  // the wrapper (see wrapper.cpp). Always a valid matrix: identity when the
  // camera has no usable one (hasColorMatrix false).
  colorMatrix: Float32Array;
  hasColorMatrix: boolean;
  // The camera's XYZ->camera 3x3 (LibRaw cam_xyz), row-major -- the
  // colorimetric matrix the LrC temp/tint readout decomposes As-Shot gains
  // through (rgb_cam is row-normalized and destroys chromaticity, so it
  // cannot serve). Undefined when the camera has no usable matrix
  // (hasColorMatrix false) -- the readout then falls back to the legacy axes.
  camXyz?: Float32Array;
  // As-shot white balance, normalized by green (g=1) from LibRaw's cam_mul
  // [R, G1, B, G2]. Absent when the camera reports no usable values. The app
  // opens files at this WB ("As Shot", like LrC) and preserves the exact
  // gains until the user touches the WB sliders.
  asShotGains?: { r: number; g: number; b: number };
  // Shooting metadata (iso/shutter/aperture/focal), 0 when not reported.
  cameraMeta: CameraMeta;
  // Camera identity from EXIF, as LibRaw normalizes it (title-cased brand,
  // e.g. "Fujifilm" / "X100V", "Nikon" / "D800"). Empty string when the file
  // reports none. The per-camera WB-readout calibration registry keys on
  // `${make} ${model}` (see uniforms.ts cameraCalibrationKey).
  make: string;
  model: string;
}

export async function decode(fileBytes: ArrayBuffer): Promise<DecodedRaw> {
  const module = await getLibRawModule();
  const bytes = new Uint8Array(fileBytes);

  const inputPtr = module._malloc(bytes.length);
  // _malloc returns 0 on failure rather than throwing (e.g. growth refused
  // or MAXIMUM_MEMORY reached -- plausible with large raw files). Writing
  // through a null pointer via HEAPU8.set would silently corrupt address 0
  // instead of failing cleanly, so this must be checked before the write.
  if (inputPtr === 0) {
    throw new DecodeError(-1003);
  }
  module.HEAPU8.set(bytes, inputPtr);

  const resultPtr = module.ccall('decode', 'number', ['number', 'number'], [inputPtr, bytes.length]);
  module._free(inputPtr);

  // decode() returns a null (0) pointer in the rare case where the
  // DecodeResult struct's own heap allocation failed -- there is nothing to
  // free and no error_code to read in that case, so this must be checked
  // before touching any decode_result_*/free_decoded functions with resultPtr.
  if (resultPtr === 0) {
    throw new DecodeError(-1002);
  }

  const errorCode = module.ccall('decode_result_error_code', 'number', ['number'], [resultPtr]);
  if (errorCode !== 0) {
    module.ccall('free_decoded', null, ['number'], [resultPtr]);
    throw new DecodeError(errorCode);
  }

  const width = module.ccall('decode_result_width', 'number', ['number'], [resultPtr]);
  const height = module.ccall('decode_result_height', 'number', ['number'], [resultPtr]);
  const effectiveWidth = module.ccall('decode_result_effective_width', 'number', ['number'], [resultPtr]);
  const effectiveHeight = module.ccall('decode_result_effective_height', 'number', ['number'], [resultPtr]);
  const leftMargin = module.ccall('decode_result_left_margin', 'number', ['number'], [resultPtr]);
  const topMargin = module.ccall('decode_result_top_margin', 'number', ['number'], [resultPtr]);
  const blackLevel = module.ccall('decode_result_black_level', 'number', ['number'], [resultPtr]);
  const whiteLevel = module.ccall('decode_result_white_level', 'number', ['number'], [resultPtr]);
  const cfaPacked = module.ccall('decode_result_cfa_pattern', 'number', ['number'], [resultPtr]);
  const bayerPtr = module.ccall('decode_result_bayer_ptr', 'number', ['number'], [resultPtr]);
  const cfa6Ptr = module.ccall('decode_result_cfa6', 'number', ['number'], [resultPtr]);
  const colorMatrixPtr = module.ccall('decode_result_color_matrix', 'number', ['number'], [resultPtr]);
  const hasColorMatrix = module.ccall('decode_result_has_color_matrix', 'number', ['number'], [resultPtr]) === 1;

  const pixelCount = width * height;
  const bayerData = module.HEAPU16.slice(bayerPtr / 2, bayerPtr / 2 + pixelCount);
  // HEAPU8.slice copies -- safe to read after free_decoded() below.
  const cfa6 = module.HEAPU8.slice(cfa6Ptr, cfa6Ptr + 36);
  // Read the 9 floats via a DataView over HEAPU8.buffer rather than a
  // HEAPF32 slice -- the Emscripten glue only creates heap views it actually
  // references, and nothing referenced HEAPF32 before, so it isn't there.
  // The wrapper's 9 floats are 4-byte aligned and wasm memory is
  // little-endian.
  const colorView = new DataView(module.HEAPU8.buffer, colorMatrixPtr, 36);
  const matrix = new Float32Array(9);
  for (let i = 0; i < 9; i++) matrix[i] = colorView.getFloat32(i * 4, true);
  // Identity fallback when the camera has no usable matrix -- downstream
  // (cameraColor pass) applies colorMatrix unconditionally.
  const colorMatrix = hasColorMatrix ? matrix : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  // cam_xyz (XYZ->camera) -- same DataView read as the matrix above. Present
  // only when the camera has a usable matrix (hasColorMatrix true); the
  // readout falls back to the legacy axes when it's undefined.
  let camXyz: Float32Array | undefined;
  if (hasColorMatrix) {
    const camXyzPtr = module.ccall('decode_result_cam_xyz', 'number', ['number'], [resultPtr]);
    const camXyzView = new DataView(module.HEAPU8.buffer, camXyzPtr, 36);
    const xyz = new Float32Array(9);
    for (let i = 0; i < 9; i++) xyz[i] = camXyzView.getFloat32(i * 4, true);
    camXyz = xyz;
  }

  // Shooting metadata: 4 consecutive floats [iso, shutter, aperture, focal]
  // -- same DataView trick as color_matrix (no HEAPF32 view in the glue).
  const metaPtr = module.ccall('decode_result_camera_meta', 'number', ['number'], [resultPtr]);
  const metaView = new DataView(module.HEAPU8.buffer, metaPtr, 16);
  const cameraMeta: CameraMeta = {
    iso: metaView.getFloat32(0, true),
    shutter: metaView.getFloat32(4, true),
    aperture: metaView.getFloat32(8, true),
    focal: metaView.getFloat32(12, true),
  };

  // As-shot WB: 4 consecutive floats [R, G1, B, G2] -- same DataView trick
  // as the matrix (no HEAPF32 view in the glue). Normalized by the green
  // reference so the gains match the app's green=1 convention; skipped when
  // the camera reports no usable values.
  //
  // The green reference averages G1+G2 only when BOTH are reported: Fuji
  // stores WB as [G, R, B] (three values), so cam_mul[3] (G2) is 0 -- the
  // X100V fixture reports [567, 302, 560, 0]. Averaging 302 with 0 would
  // halve green and DOUBLE the R/B gains (a strong warm/magenta cast vs the
  // camera's actual WB, which is what LrC applies). Nonzero-green cameras
  // (Bayer) report both greens, and the average is then a no-op.
  const camMulPtr = module.ccall('decode_result_cam_mul', 'number', ['number'], [resultPtr]);
  const hasCamMul = module.ccall('decode_result_has_cam_mul', 'number', ['number'], [resultPtr]) === 1;
  let asShotGains: { r: number; g: number; b: number } | undefined;
  if (hasCamMul) {
    const camMulView = new DataView(module.HEAPU8.buffer, camMulPtr, 16);
    const g1 = camMulView.getFloat32(4, true);
    const g2 = camMulView.getFloat32(12, true);
    const green = g1 > 0 && g2 > 0 ? (g1 + g2) / 2 : (g1 > 0 ? g1 : g2);
    if (green > 0) {
      asShotGains = {
        r: camMulView.getFloat32(0, true) / green,
        g: 1,
        b: camMulView.getFloat32(8, true) / green,
      };
    }
  }

  // Camera identity -- Emscripten ccall 'string' ret copies the C string out
  // (reads the struct's fixed char[64] buffers via UTF8ToString internally).
  // Must be read before free_decoded() below, which frees the struct.
  const make = module.ccall('decode_result_make', 'string', ['number'], [resultPtr]);
  const model = module.ccall('decode_result_model', 'string', ['number'], [resultPtr]);

  module.ccall('free_decoded', null, ['number'], [resultPtr]);

  return {
    width,
    height,
    effectiveWidth,
    effectiveHeight,
    leftMargin,
    topMargin,
    blackLevel,
    whiteLevel,
    cfaPattern: unpackCfaPattern(cfaPacked),
    cfa6,
    bayerData,
    colorMatrix,
    hasColorMatrix,
    camXyz,
    asShotGains,
    cameraMeta,
    make,
    model,
  };
}
