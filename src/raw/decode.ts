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

export interface DecodedRaw {
  width: number;
  height: number;
  blackLevel: number;
  whiteLevel: number;
  cfaPattern: string;
  // Full 6x6 CFA from the wrapper (one byte per position, row-major, 0=R
  // 1=G 2=B). Bayer cameras tile their 2x2 to fill it, so demosaic.wgsl can
  // always use a 6x6 lookup.
  cfa6: Uint8Array;
  bayerData: Uint16Array;
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
  const blackLevel = module.ccall('decode_result_black_level', 'number', ['number'], [resultPtr]);
  const whiteLevel = module.ccall('decode_result_white_level', 'number', ['number'], [resultPtr]);
  const cfaPacked = module.ccall('decode_result_cfa_pattern', 'number', ['number'], [resultPtr]);
  const bayerPtr = module.ccall('decode_result_bayer_ptr', 'number', ['number'], [resultPtr]);
  const cfa6Ptr = module.ccall('decode_result_cfa6', 'number', ['number'], [resultPtr]);

  const pixelCount = width * height;
  const bayerData = module.HEAPU16.slice(bayerPtr / 2, bayerPtr / 2 + pixelCount);
  // HEAPU8.slice copies -- safe to read after free_decoded() below.
  const cfa6 = module.HEAPU8.slice(cfa6Ptr, cfa6Ptr + 36);

  module.ccall('free_decoded', null, ['number'], [resultPtr]);

  return { width, height, blackLevel, whiteLevel, cfaPattern: unpackCfaPattern(cfaPacked), cfa6, bayerData };
}
