// @ts-expect-error -- Emscripten glue has no bundled types
import createLibRawModule from '../wasm/libraw.js';

interface LibRawModule {
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => number;
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
}

let modulePromise: Promise<LibRawModule> | null = null;

function getModule(): Promise<LibRawModule> {
  if (!modulePromise) {
    modulePromise = createLibRawModule() as Promise<LibRawModule>;
  }
  return modulePromise;
}

export class ThumbnailError extends Error {
  constructor(public readonly code: number) {
    super(`LibRaw thumbnail extraction failed with code ${code}`);
    this.name = 'ThumbnailError';
  }
}

export async function extractThumbnail(fileBytes: ArrayBuffer): Promise<Blob> {
  const module = await getModule();
  const bytes = new Uint8Array(fileBytes);

  const inputPtr = module._malloc(bytes.length);
  // _malloc returns 0 on failure rather than throwing (e.g. growth refused
  // or MAXIMUM_MEMORY reached). Writing through a null pointer via
  // HEAPU8.set would silently corrupt address 0 instead of failing cleanly,
  // so this must be checked before the write. Mirrors decode.ts.
  if (inputPtr === 0) {
    throw new ThumbnailError(-1003);
  }
  module.HEAPU8.set(bytes, inputPtr);

  const resultPtr = module.ccall('extract_thumbnail', 'number', ['number', 'number'], [inputPtr, bytes.length]);
  module._free(inputPtr);

  // extract_thumbnail() returns a null (0) pointer in the rare case where
  // the ThumbnailResult struct's own heap allocation failed -- there is
  // nothing to free and no error_code to read in that case, so this must be
  // checked before touching any thumbnail_result_*/free_thumbnail functions
  // with resultPtr. Mirrors decode.ts.
  if (resultPtr === 0) {
    throw new ThumbnailError(-1002);
  }

  const errorCode = module.ccall('thumbnail_result_error_code', 'number', ['number'], [resultPtr]);
  if (errorCode !== 0) {
    module.ccall('free_thumbnail', null, ['number'], [resultPtr]);
    throw new ThumbnailError(errorCode);
  }

  const length = module.ccall('thumbnail_result_length', 'number', ['number'], [resultPtr]);
  const dataPtr = module.ccall('thumbnail_result_data_ptr', 'number', ['number'], [resultPtr]);

  // Copies the bytes out of wasm memory before free_thumbnail() releases
  // them -- same pattern as decode.ts's bayerData handling.
  const jpegBytes = module.HEAPU8.slice(dataPtr, dataPtr + length);

  module.ccall('free_thumbnail', null, ['number'], [resultPtr]);

  return new Blob([jpegBytes], { type: 'image/jpeg' });
}
