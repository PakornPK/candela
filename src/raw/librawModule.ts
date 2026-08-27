// @ts-expect-error -- Emscripten glue has no bundled types
import createLibRawModule from '../wasm/libraw.js';

// Shared by decode.ts and thumbnail.ts so both use the same WASM module
// instance (one WebAssembly.Memory arena) instead of two independent ones
// -- see Task 2's code review in this plan for why that matters once both
// are imported together, as main.ts (this task) does.
export interface LibRawModule {
  // ret 'string' (Emscripten's UTF8ToString copy for a `const char*` return)
  // maps to JS string; everything else maps to number.
  ccall: <T extends 'number' | 'string' | null>(
    name: string, ret: T, argTypes: string[], args: unknown[],
  ) => T extends 'string' ? string : number;
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
}

let modulePromise: Promise<LibRawModule> | null = null;

export function getLibRawModule(): Promise<LibRawModule> {
  if (!modulePromise) {
    modulePromise = createLibRawModule() as Promise<LibRawModule>;
  }
  return modulePromise;
}
