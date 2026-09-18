import { beforeEach, describe, expect, it, vi } from 'vitest';

// The glue is Emscripten JS with no types and a real wasm fetch on call; what
// is under test is the cache around the factory promise, so the factory is a
// controllable fake. modulePromise is module state, so every test loads a
// fresh copy of the module (resetModules + dynamic import).
const factory = vi.fn();
vi.mock('../wasm/libraw', () => ({ default: (...a: unknown[]) => factory(...a) }));

async function fresh() {
  vi.resetModules();
  const m = await import('./librawModule');
  return { getLibRawModule: m.getLibRawModule, isWasmLoadError: m.isWasmLoadError };
}

beforeEach(() => factory.mockReset());

describe('getLibRawModule retry-on-failure cache', () => {
  it('caches a successful load (one instantiation for many callers)', async () => {
    factory.mockResolvedValue({ tag: 'ok' });
    const { getLibRawModule } = await fresh();
    const a = await getLibRawModule();
    const b = await getLibRawModule();
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('drops a failed load so the next call retries (a blip is not permanent)', async () => {
    factory.mockRejectedValueOnce(new Error('Aborted(both async and sync fetching of the wasm failed)'));
    factory.mockResolvedValueOnce({ tag: 'second' });
    const { getLibRawModule } = await fresh();
    await expect(getLibRawModule()).rejects.toThrow('fetching of the wasm failed');
    const ok = await getLibRawModule(); // retry after the failure
    expect(ok).toEqual({ tag: 'second' });
    expect(factory).toHaveBeenCalledTimes(2);
    const again = await getLibRawModule();
    expect(again).toBe(ok); // cached now that it succeeded
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('isWasmLoadError', () => {
  it('matches the Emscripten abort and WebAssembly RuntimeError text', async () => {
    const { isWasmLoadError } = await fresh();
    expect(isWasmLoadError(new Error('Aborted(both async and sync fetching of the wasm failed). Build with -sASSERTIONS for more info.'))).toBe(true);
    expect(isWasmLoadError(new WebAssembly.RuntimeError('WebAssembly instantiate failed'))).toBe(true);
  });
  it('does not match ordinary failures', async () => {
    const { isWasmLoadError } = await fresh();
    expect(isWasmLoadError(new Error('permission denied'))).toBe(false);
    expect(isWasmLoadError('not granted')).toBe(false);
  });
});
