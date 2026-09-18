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

// A transient wasm fetch failure (offline blip, stale deploy racing a hard
// refresh) must not be a permanent one: the Emscripten abort text ("both
// async and sync fetching of the wasm failed") was un-retryable because the
// REJECTED promise was cached forever -- only a page reload could recover.
// Failed loads now drop the cache entry so the next open retries.
let modulePromise: Promise<LibRawModule> | null = null;

export function getLibRawModule(): Promise<LibRawModule> {
  if (!modulePromise) {
    const pending = createLibRawModule() as Promise<LibRawModule>;
    modulePromise = pending;
    pending.catch(() => {
      if (modulePromise === pending) modulePromise = null;
    });
  }
  return modulePromise;
}

export function isWasmLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('fetching of the wasm failed') || msg.includes('WebAssembly');
}
