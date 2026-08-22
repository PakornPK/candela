# WebGPU Raw Pipeline Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a WebGPU pipeline can decode a raw photo (via a self-compiled LibRaw/WASM), demosaic and adjust it entirely on the GPU, and hit the brief's perf targets (< 2s decode+demosaic on 60MP, < 50ms slider→frame update, stable across 10 file loads).

**Architecture:** LibRaw is compiled to WASM via a hand-written CMake + Emscripten build (git submodule for LibRaw source). A thin C++ wrapper exposes one `decode()` call returning Bayer data + black/white levels + CFA pattern. TypeScript loads that WASM module, uploads the Bayer data to a `r16uint` GPU texture, and runs the rest of the pipeline (normalize → demosaic → adjust → blit) as WebGPU compute/render passes with no CPU readback. UI is vanilla DOM (file input + 2 sliders + canvas), decoupled from the pipeline through a plain `load()`/`render()` interface.

**Tech Stack:** TypeScript (strict), Vite, Vitest, WGSL, WebGPU, C++17, CMake, Emscripten, LibRaw (git submodule).

**Spec:** [`docs/superpowers/specs/2026-08-23-webgpu-raw-pipeline-spike-design.md`](../specs/2026-08-23-webgpu-raw-pipeline-spike-design.md)

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/vite-env.d.ts`, `.gitignore`
- Test: `src/sanity.test.ts` (deleted at the end of this task once real tests exist elsewhere)

- [ ] **Step 1: Scaffold with Vite**

Run:
```bash
npm create vite@latest . -- --template vanilla-ts
```

If prompted about a non-empty directory (there's already `CLAUDE.md` and `docs/`), confirm proceeding — it only adds files, it won't touch existing ones.

- [ ] **Step 2: Add Vitest and WebGPU types**

Run:
```bash
npm install -D vitest @webgpu/types
```

- [ ] **Step 3: Set `tsconfig.json` to strict and register WebGPU types**

Edit `tsconfig.json`, inside `compilerOptions`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["@webgpu/types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Add npm scripts**

Edit `package.json`, add to `"scripts"`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  }
}
```

- [ ] **Step 5: Write a sanity test to confirm Vitest runs against this TS config**

Create `src/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('project scaffold', () => {
  it('runs TypeScript tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npm test`
Expected: `1 passed`

- [ ] **Step 7: Delete the sanity test (its only job was to prove the harness works)**

Run: `rm src/sanity.test.ts`

- [ ] **Step 8: Replace the template's `index.html` body with the real UI skeleton**

Edit `index.html`, replace the `<body>` contents with:

```html
<body>
  <div id="app">
    <input type="file" id="file" accept=".dng,.nef,.cr3,.arw" />
    <canvas id="canvas"></canvas>
    <label>Exposure <input type="range" id="exposure" min="-3" max="3" step="0.1" value="0" /></label>
    <label>White balance <input type="range" id="wb" min="-1" max="1" step="0.05" value="0" /></label>
    <p id="error" role="alert"></p>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- [ ] **Step 9: Empty out the template's `src/main.ts` and `src/counter.ts`/`src/style.css` boilerplate**

Run:
```bash
rm -f src/counter.ts
```

Replace `src/main.ts` with a single line for now (filled in for real in Task 8):

```ts
// wired up in Task 8
```

- [ ] **Step 10: `.gitignore` build/native artifacts**

Create `.gitignore`:

```
node_modules/
dist/
src/wasm/
native/libraw-wrapper/build-wasm/
native/libraw-wrapper/build-native/
*.local
```

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json index.html src/main.ts .gitignore
git commit -m "chore: scaffold Vite + TS strict + Vitest project"
```

---

## Task 2: Adjustment math & CFA packing (pure logic, TDD)

These are the pure-function pieces that feed the GPU uniform buffers — worth unit testing because a sign or clamp mistake here silently corrupts every frame.

**Files:**
- Create: `src/gpu/uniforms.ts`
- Test: `src/gpu/uniforms.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/gpu/uniforms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evToGain, wbShiftToGains, packAdjustUniforms, packCfaPattern } from './uniforms';

describe('evToGain', () => {
  it('returns 1 at EV 0', () => {
    expect(evToGain(0)).toBe(1);
  });

  it('doubles at EV +1 and halves at EV -1', () => {
    expect(evToGain(1)).toBeCloseTo(2);
    expect(evToGain(-1)).toBeCloseTo(0.5);
  });
});

describe('wbShiftToGains', () => {
  it('returns equal gains at shift 0', () => {
    expect(wbShiftToGains(0)).toEqual({ rGain: 1, bGain: 1 });
  });

  it('boosts red and cuts blue for positive shift', () => {
    const { rGain, bGain } = wbShiftToGains(1);
    expect(rGain).toBeGreaterThan(1);
    expect(bGain).toBeLessThan(1);
  });

  it('clamps shift outside [-1, 1]', () => {
    expect(wbShiftToGains(5)).toEqual(wbShiftToGains(1));
    expect(wbShiftToGains(-5)).toEqual(wbShiftToGains(-1));
  });
});

describe('packAdjustUniforms', () => {
  it('produces a 4-float array matching the WGSL Adjust struct layout', () => {
    const packed = packAdjustUniforms({ exposureEV: 0, wbShift: 0 });
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed.length).toBe(4);
    expect(packed[0]).toBe(1); // exposureGain
    expect(packed[1]).toBe(1); // rGain
    expect(packed[2]).toBe(1); // bGain
  });
});

describe('packCfaPattern', () => {
  it('maps RGGB to [0, 1, 1, 2]', () => {
    expect(Array.from(packCfaPattern('RGGB'))).toEqual([0, 1, 1, 2]);
  });

  it('throws on an unknown color letter', () => {
    expect(() => packCfaPattern('RGGX')).toThrow('Unknown CFA color');
  });

  it('throws on the wrong length', () => {
    expect(() => packCfaPattern('RGB')).toThrow('4-character');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './uniforms'`

- [ ] **Step 3: Implement**

Create `src/gpu/uniforms.ts`:

```ts
export function evToGain(ev: number): number {
  return Math.pow(2, ev);
}

export interface WhiteBalanceGains {
  rGain: number;
  bGain: number;
}

// wbShift in [-1, 1]: positive shifts warmer (boost red, cut blue).
export function wbShiftToGains(wbShift: number): WhiteBalanceGains {
  const clamped = Math.max(-1, Math.min(1, wbShift));
  return {
    rGain: 1 + clamped * 0.5,
    bGain: 1 - clamped * 0.5,
  };
}

export interface AdjustState {
  exposureEV: number;
  wbShift: number;
}

// Layout must match the `Adjust` uniform struct in adjust.wgsl:
// struct Adjust { exposureGain: f32, rGain: f32, bGain: f32, _pad: f32 }
export function packAdjustUniforms(state: AdjustState): Float32Array {
  const exposureGain = evToGain(state.exposureEV);
  const { rGain, bGain } = wbShiftToGains(state.wbShift);
  return new Float32Array([exposureGain, rGain, bGain, 0]);
}

const CFA_COLOR_CODE: Record<string, number> = { R: 0, G: 1, B: 2 };

// Layout must match the `Cfa` uniform struct in demosaic.wgsl:
// struct Cfa { pattern: vec4<u32> }
export function packCfaPattern(cfaPattern: string): Uint32Array {
  if (cfaPattern.length !== 4) {
    throw new Error(`Expected a 4-character CFA pattern, got "${cfaPattern}"`);
  }
  return Uint32Array.from(cfaPattern, (ch) => {
    const code = CFA_COLOR_CODE[ch];
    if (code === undefined) {
      throw new Error(`Unknown CFA color "${ch}"`);
    }
    return code;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add src/gpu/uniforms.ts src/gpu/uniforms.test.ts
git commit -m "feat: add exposure/WB/CFA uniform packing with tests"
```

---

## Task 3: LibRaw submodule + CMake skeleton + native dimension validation

Sets up the C++ build (native ctest path first — fast, no Emscripten needed to iterate on pure logic) before touching WASM at all.

**Files:**
- Create: `native/libraw-wrapper/CMakeLists.txt`, `native/libraw-wrapper/wrapper_core.h`, `native/libraw-wrapper/wrapper_core.cpp`, `native/libraw-wrapper/test/wrapper_core_test.cpp`, `native/libraw-wrapper/build-test.sh`, `.gitmodules`

- [ ] **Step 1: Add the LibRaw submodule, pinned to a release tag**

Run:
```bash
git submodule add https://github.com/LibRaw/LibRaw.git native/libraw-wrapper/third_party/libraw
cd native/libraw-wrapper/third_party/libraw
git checkout 0.21.2
cd -
git add .gitmodules native/libraw-wrapper/third_party/libraw
git commit -m "chore: vendor LibRaw 0.21.2 as a submodule"
```

- [ ] **Step 2: Write the failing native test**

Create `native/libraw-wrapper/test/wrapper_core_test.cpp`:

```cpp
#include <cassert>
#include "../wrapper_core.h"

int main() {
    using namespace candela;

    assert(validate_dimensions(6000, 4000) == true);    // typical 24MP
    assert(validate_dimensions(9504, 6336) == true);    // ~60MP
    assert(validate_dimensions(0, 100) == false);        // zero width
    assert(validate_dimensions(100, 0) == false);        // zero height
    assert(validate_dimensions(50000, 50000) == false);  // absurd dims from a corrupt file

    return 0;
}
```

- [ ] **Step 2b: Write the header the test expects (declaration only, no implementation yet)**

Create `native/libraw-wrapper/wrapper_core.h`:

```cpp
#pragma once
#include <cstdint>

namespace candela {

struct DimensionLimits {
    static constexpr uint32_t kMaxWidth = 20000;
    static constexpr uint32_t kMaxHeight = 20000;
    static constexpr uint64_t kMaxPixels = 200'000'000; // 200MP ceiling
};

// True if width/height are plausible for a camera raw file. Used to reject
// corrupt files before we allocate a buffer sized from their claimed dimensions.
bool validate_dimensions(uint32_t width, uint32_t height);

} // namespace candela
```

- [ ] **Step 3: Wire up CMake so the native test can build (no Emscripten involved yet)**

Create `native/libraw-wrapper/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.20)
project(libraw_wrapper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(wrapper_core STATIC wrapper_core.cpp)
target_include_directories(wrapper_core PUBLIC .)

if(EMSCRIPTEN)
  add_subdirectory(third_party/libraw)
  add_executable(libraw wrapper.cpp)
  target_link_libraries(libraw PRIVATE wrapper_core raw_r)
  target_link_options(libraw PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createLibRawModule"
    "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\"]"
    "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\"]"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sENVIRONMENT=web,node"
  )
  set_target_properties(libraw PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/../../src/wasm
  )
else()
  enable_testing()
  add_executable(wrapper_core_test test/wrapper_core_test.cpp)
  target_link_libraries(wrapper_core_test PRIVATE wrapper_core)
  add_test(NAME wrapper_core_test COMMAND wrapper_core_test)
endif()
```

Note: `add_subdirectory(third_party/libraw)` and the `libraw` wasm target only build under `EMSCRIPTEN` — the native test path (this step) doesn't need to compile all of LibRaw, so it stays fast.

- [ ] **Step 4: Add a stub `wrapper_core.cpp` that fails the assertions (proves the test actually runs)**

Create `native/libraw-wrapper/wrapper_core.cpp`:

```cpp
#include "wrapper_core.h"

namespace candela {

bool validate_dimensions(uint32_t width, uint32_t height) {
    (void)width;
    (void)height;
    return false; // stub — Step 6 implements this for real
}

} // namespace candela
```

- [ ] **Step 5: Build and run the native test to confirm it fails**

Create `native/libraw-wrapper/build-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cmake -B build-native
cmake --build build-native
ctest --test-dir build-native --output-on-failure
```

Run:
```bash
chmod +x native/libraw-wrapper/build-test.sh
./native/libraw-wrapper/build-test.sh
```

Expected: `wrapper_core_test` FAILS (assertion on `validate_dimensions(6000, 4000) == true`).

- [ ] **Step 6: Implement `validate_dimensions` for real**

Edit `native/libraw-wrapper/wrapper_core.cpp`:

```cpp
#include "wrapper_core.h"

namespace candela {

bool validate_dimensions(uint32_t width, uint32_t height) {
    if (width == 0 || height == 0) return false;
    if (width > DimensionLimits::kMaxWidth || height > DimensionLimits::kMaxHeight) return false;
    uint64_t pixels = static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
    return pixels <= DimensionLimits::kMaxPixels;
}

} // namespace candela
```

- [ ] **Step 7: Run the native test to confirm it passes**

Run: `./native/libraw-wrapper/build-test.sh`
Expected: `100% tests passed, 0 tests failed out of 1`

- [ ] **Step 8: Commit**

```bash
git add native/libraw-wrapper/CMakeLists.txt native/libraw-wrapper/wrapper_core.h \
        native/libraw-wrapper/wrapper_core.cpp native/libraw-wrapper/test/wrapper_core_test.cpp \
        native/libraw-wrapper/build-test.sh
git commit -m "feat: add CMake skeleton and tested dimension-validation logic"
```

---

## Task 4: `wrapper.cpp` decode() + WASM build

**Files:**
- Create: `native/libraw-wrapper/wrapper.cpp`, `native/libraw-wrapper/build.sh`

- [ ] **Step 1: Write `wrapper.cpp`**

Create `native/libraw-wrapper/wrapper.cpp`:

```cpp
#include <emscripten.h>
#include <libraw/libraw.h>
#include <cstdint>
#include <cstring>
#include <memory>
#include "wrapper_core.h"

extern "C" {

// Ownership crosses the JS/WASM boundary as a raw pointer by necessity —
// Emscripten's ccall interface has no concept of RAII on the JS side. JS
// must call free_decoded() exactly once per successful decode() call.
struct DecodeResult {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t black_level = 0;
    uint32_t white_level = 0;
    uint32_t cfa_pattern = 0; // 4 packed bytes, one per 2x2 position: 0=R,1=G,2=B
    uint16_t* bayer_data = nullptr;
    int error_code = 0; // 0 = success, LibRaw error codes otherwise, -1 = implausible dimensions
};

EMSCRIPTEN_KEEPALIVE
DecodeResult* decode(const uint8_t* file_bytes, uint32_t length) {
    auto* result = new DecodeResult{};
    LibRaw processor;

    int ret = processor.open_buffer(const_cast<uint8_t*>(file_bytes), length);
    if (ret != LIBRAW_SUCCESS) {
        result->error_code = ret;
        return result;
    }

    ret = processor.unpack();
    if (ret != LIBRAW_SUCCESS) {
        result->error_code = ret;
        return result;
    }

    const auto& raw = processor.imgdata.rawdata;
    uint32_t width = processor.imgdata.sizes.raw_width;
    uint32_t height = processor.imgdata.sizes.raw_height;

    if (!candela::validate_dimensions(width, height) || raw.raw_image == nullptr) {
        result->error_code = -1;
        return result;
    }

    size_t pixel_count = static_cast<size_t>(width) * height;
    auto bayer_owned = std::make_unique<uint16_t[]>(pixel_count);
    std::memcpy(bayer_owned.get(), raw.raw_image, pixel_count * sizeof(uint16_t));

    result->width = width;
    result->height = height;
    result->black_level = processor.imgdata.color.black;
    result->white_level = processor.imgdata.color.maximum;
    result->bayer_data = bayer_owned.release(); // ownership crosses to JS; freed via free_decoded()
    result->error_code = 0;

    uint32_t packed = 0;
    for (int row = 0; row < 2; ++row) {
        for (int col = 0; col < 2; ++col) {
            packed = (packed << 8) | static_cast<uint8_t>(processor.COLOR(row, col));
        }
    }
    result->cfa_pattern = packed;

    return result;
}

EMSCRIPTEN_KEEPALIVE
uint16_t* decode_result_bayer_ptr(DecodeResult* r) { return r->bayer_data; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_width(DecodeResult* r) { return r->width; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_height(DecodeResult* r) { return r->height; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_black_level(DecodeResult* r) { return r->black_level; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_white_level(DecodeResult* r) { return r->white_level; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_cfa_pattern(DecodeResult* r) { return r->cfa_pattern; }

EMSCRIPTEN_KEEPALIVE
int decode_result_error_code(DecodeResult* r) { return r->error_code; }

EMSCRIPTEN_KEEPALIVE
void free_decoded(DecodeResult* r) {
    if (!r) return;
    delete[] r->bayer_data;
    delete r;
}

} // extern "C"
```

- [ ] **Step 2: Add the WASM build script**

Create `native/libraw-wrapper/build.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm
```

Run:
```bash
chmod +x native/libraw-wrapper/build.sh
./native/libraw-wrapper/build.sh
```

Expected: `src/wasm/libraw.js` and `src/wasm/libraw.wasm` are produced. (First run also compiles LibRaw itself — this can take a few minutes.)

- [ ] **Step 3: Commit**

```bash
git add native/libraw-wrapper/wrapper.cpp native/libraw-wrapper/build.sh
git commit -m "feat: implement LibRaw decode() wrapper and WASM build script"
```

---

## Task 5: TS WASM loader with a real-file integration test

**Prerequisite:** copy one small `.dng` or `.nef` sample file to `src/raw/__fixtures__/sample.dng` (or `.nef`) — pick your smallest one, it's not committed to git (binary + your own photo, kept local). Add `src/raw/__fixtures__/` to `.gitignore`.

**Files:**
- Create: `src/raw/decode.ts`, `src/raw/decode.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the fixtures directory**

Edit `.gitignore`, add:
```
src/raw/__fixtures__/
```

- [ ] **Step 2: Write the failing test**

Create `src/raw/decode.test.ts` (adjust the fixture filename to whichever you copied in):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decode, DecodeError } from './decode';

function loadFixture(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('decode', () => {
  it('decodes a real raw fixture into Bayer data with sane dimensions', async () => {
    const result = await decode(loadFixture('sample.dng'));

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.bayerData.length).toBe(result.width * result.height);
    expect(result.whiteLevel).toBeGreaterThan(result.blackLevel);
    expect(result.cfaPattern).toMatch(/^[RGB]{4}$/);
  });

  it('rejects a garbage buffer with a DecodeError', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(decode(garbage)).rejects.toBeInstanceOf(DecodeError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './decode'`

- [ ] **Step 4: Implement the loader**

Create `src/raw/decode.ts`:

```ts
// @ts-expect-error -- Emscripten glue has no bundled types
import createLibRawModule from '../wasm/libraw.js';

interface LibRawModule {
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => number;
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
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

const CFA_COLORS = ['R', 'G', 'B', 'G'] as const;

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
  bayerData: Uint16Array;
}

export async function decode(fileBytes: ArrayBuffer): Promise<DecodedRaw> {
  const module = await getModule();
  const bytes = new Uint8Array(fileBytes);

  const inputPtr = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, inputPtr);

  const resultPtr = module.ccall('decode', 'number', ['number', 'number'], [inputPtr, bytes.length]);
  module._free(inputPtr);

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

  const pixelCount = width * height;
  const bayerData = module.HEAPU16.slice(bayerPtr / 2, bayerPtr / 2 + pixelCount);

  module.ccall('free_decoded', null, ['number'], [resultPtr]);

  return { width, height, blackLevel, whiteLevel, cfaPattern: unpackCfaPattern(cfaPacked), bayerData };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: `2 passed` (if it fails on module resolution for `libraw.js`, confirm Task 4's `build.sh` has been run — `src/wasm/libraw.js` must exist)

- [ ] **Step 6: Commit**

```bash
git add src/raw/decode.ts src/raw/decode.test.ts .gitignore
git commit -m "feat: add TS WASM decode loader with real-fixture integration test"
```

---

## Task 6: WGSL shaders

**Files:**
- Create: `src/shaders/unpack.wgsl`, `src/shaders/demosaic.wgsl`, `src/shaders/adjust.wgsl`, `src/shaders/blit.wgsl`, `src/vite-env.d.ts` (module declaration for `?raw` imports)

No unit test here — WGSL correctness is verified visually once wired into the pipeline in Task 7. Bilinear is the deliberate algorithm per the spec (cheap, isolates pipeline speed from demosaic quality).

- [ ] **Step 1: Declare the `?raw` import type**

Create `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
```

- [ ] **Step 2: Unpack + normalize shader**

Create `src/shaders/unpack.wgsl`:

```wgsl
struct Levels {
  blackLevel: f32,
  whiteLevel: f32,
};

@group(0) @binding(0) var bayerTex: texture_2d<u32>;
@group(0) @binding(1) var normalizedTex: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> levels: Levels;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(bayerTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let raw = f32(textureLoad(bayerTex, vec2<i32>(id.xy), 0).r);
  let range = max(levels.whiteLevel - levels.blackLevel, 1.0);
  let normalized = clamp((raw - levels.blackLevel) / range, 0.0, 1.0);
  textureStore(normalizedTex, vec2<i32>(id.xy), vec4<f32>(normalized, 0.0, 0.0, 0.0));
}
```

- [ ] **Step 3: Bilinear demosaic shader**

Create `src/shaders/demosaic.wgsl`:

```wgsl
struct Cfa {
  pattern: vec4<u32>, // pattern[(y%2)*2 + x%2] = color at that CFA position, 0=R 1=G 2=B
};

@group(0) @binding(0) var normalizedTex: texture_2d<f32>;
@group(0) @binding(1) var demosaicedTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> cfa: Cfa;

fn sampleAt(coord: vec2<i32>, dims: vec2<u32>) -> f32 {
  let clamped = clamp(coord, vec2<i32>(0, 0), vec2<i32>(dims) - vec2<i32>(1, 1));
  return textureLoad(normalizedTex, clamped, 0).r;
}

fn colorAt(x: u32, y: u32) -> u32 {
  let idx = (y % 2u) * 2u + (x % 2u);
  return cfa.pattern[idx];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(normalizedTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  let center = sampleAt(vec2<i32>(x, y), dims);
  let thisColor = colorAt(id.x, id.y);

  let up    = sampleAt(vec2<i32>(x, y - 1), dims);
  let down  = sampleAt(vec2<i32>(x, y + 1), dims);
  let left  = sampleAt(vec2<i32>(x - 1, y), dims);
  let right = sampleAt(vec2<i32>(x + 1, y), dims);
  let diagUL = sampleAt(vec2<i32>(x - 1, y - 1), dims);
  let diagUR = sampleAt(vec2<i32>(x + 1, y - 1), dims);
  let diagDL = sampleAt(vec2<i32>(x - 1, y + 1), dims);
  let diagDR = sampleAt(vec2<i32>(x + 1, y + 1), dims);

  var r: f32;
  var g: f32;
  var b: f32;

  if (thisColor == 0u) { // R pixel
    r = center;
    g = (up + down + left + right) * 0.25;
    b = (diagUL + diagUR + diagDL + diagDR) * 0.25;
  } else if (thisColor == 2u) { // B pixel
    b = center;
    g = (up + down + left + right) * 0.25;
    r = (diagUL + diagUR + diagDL + diagDR) * 0.25;
  } else { // G pixel — R/B come from whichever axis has the R neighbor
    g = center;
    if (colorAt(id.x - 1u, id.y) == 0u || colorAt(id.x + 1u, id.y) == 0u) {
      r = (left + right) * 0.5;
      b = (up + down) * 0.5;
    } else {
      r = (up + down) * 0.5;
      b = (left + right) * 0.5;
    }
  }

  textureStore(demosaicedTex, vec2<i32>(x, y), vec4<f32>(r, g, b, 1.0));
}
```

- [ ] **Step 4: Exposure + white balance adjust shader**

Create `src/shaders/adjust.wgsl`:

```wgsl
struct Adjust {
  exposureGain: f32,
  rGain: f32,
  bGain: f32,
  _pad: f32,
};

@group(0) @binding(0) var demosaicedTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> adjust: Adjust;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(demosaicedTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let color = textureLoad(demosaicedTex, vec2<i32>(id.xy), 0);
  let adjusted = vec4<f32>(
    clamp(color.r * adjust.exposureGain * adjust.rGain, 0.0, 1.0),
    clamp(color.g * adjust.exposureGain, 0.0, 1.0),
    clamp(color.b * adjust.exposureGain * adjust.bGain, 0.0, 1.0),
    1.0,
  );
  textureStore(outTex, vec2<i32>(id.xy), adjusted);
}
```

- [ ] **Step 5: Blit-to-canvas shader**

Create `src/shaders/blit.wgsl`:

```wgsl
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out: VertexOut;
  out.position = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(srcTex, srcSampler, in.uv);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/shaders src/vite-env.d.ts
git commit -m "feat: add unpack/demosaic/adjust/blit WGSL shaders"
```

---

## Task 7: GPU pipeline wiring

**Files:**
- Create: `src/gpu/pipeline.ts`

- [ ] **Step 1: Implement the pipeline**

Create `src/gpu/pipeline.ts`:

```ts
import unpackShader from '../shaders/unpack.wgsl?raw';
import demosaicShader from '../shaders/demosaic.wgsl?raw';
import adjustShader from '../shaders/adjust.wgsl?raw';
import blitShader from '../shaders/blit.wgsl?raw';
import { packAdjustUniforms, packCfaPattern, type AdjustState } from './uniforms';
import type { DecodedRaw } from '../raw/decode';

export class Pipeline {
  private bayerTexture: GPUTexture | null = null;
  private normalizedTexture: GPUTexture | null = null;
  private demosaicedTexture: GPUTexture | null = null;
  private adjustedTexture: GPUTexture | null = null;

  private readonly unpackPipeline: GPUComputePipeline;
  private readonly demosaicPipeline: GPUComputePipeline;
  private readonly adjustPipeline: GPUComputePipeline;
  private readonly blitPipeline: GPURenderPipeline;

  private readonly levelsBuffer: GPUBuffer;
  private readonly cfaBuffer: GPUBuffer;
  private readonly adjustUniformBuffer: GPUBuffer;
  private readonly blitSampler: GPUSampler;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.unpackPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: unpackShader }), entryPoint: 'main' },
    });
    this.demosaicPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: demosaicShader }), entryPoint: 'main' },
    });
    this.adjustPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: adjustShader }), entryPoint: 'main' },
    });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: blitShader }), entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: blitShader }),
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.levelsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cfaBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.adjustUniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blitSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  static async create(canvas: HTMLCanvasElement): Promise<Pipeline> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter available.');
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new Pipeline(device, context, format);
  }

  // Destroys prior textures before uploading the new file's data — this is
  // what keeps GPU memory stable across repeated file loads.
  load(raw: DecodedRaw): void {
    this.bayerTexture?.destroy();
    this.normalizedTexture?.destroy();
    this.demosaicedTexture?.destroy();
    this.adjustedTexture?.destroy();

    const size: GPUExtent3DStrict = [raw.width, raw.height];

    this.bayerTexture = this.device.createTexture({
      size,
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.bayerTexture },
      raw.bayerData,
      { bytesPerRow: raw.width * 2 },
      { width: raw.width, height: raw.height },
    );

    this.normalizedTexture = this.device.createTexture({
      size,
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.demosaicedTexture = this.device.createTexture({
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.adjustedTexture = this.device.createTexture({
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.device.queue.writeBuffer(this.levelsBuffer, 0, new Float32Array([raw.blackLevel, raw.whiteLevel, 0, 0]));
    this.device.queue.writeBuffer(this.cfaBuffer, 0, packCfaPattern(raw.cfaPattern));

    const encoder = this.device.createCommandEncoder();
    this.dispatchUnpack(encoder, raw.width, raw.height);
    this.dispatchDemosaic(encoder, raw.width, raw.height);
    this.device.queue.submit([encoder.finish()]);
  }

  private workgroupCounts(width: number, height: number): [number, number] {
    return [Math.ceil(width / 8), Math.ceil(height / 8)];
  }

  private dispatchUnpack(encoder: GPUCommandEncoder, width: number, height: number): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.unpackPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.bayerTexture!.createView() },
        { binding: 1, resource: this.normalizedTexture!.createView() },
        { binding: 2, resource: { buffer: this.levelsBuffer } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.unpackPipeline);
    pass.setBindGroup(0, bindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  private dispatchDemosaic(encoder: GPUCommandEncoder, width: number, height: number): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.demosaicPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.normalizedTexture!.createView() },
        { binding: 1, resource: this.demosaicedTexture!.createView() },
        { binding: 2, resource: { buffer: this.cfaBuffer } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.demosaicPipeline);
    pass.setBindGroup(0, bindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  // Re-runs only adjust + blit — this is the < 50ms slider path (no re-demosaic).
  render(state: AdjustState): void {
    if (!this.demosaicedTexture || !this.adjustedTexture) return;
    this.device.queue.writeBuffer(this.adjustUniformBuffer, 0, packAdjustUniforms(state));

    const encoder = this.device.createCommandEncoder();
    const width = this.demosaicedTexture.width;
    const height = this.demosaicedTexture.height;

    const adjustBindGroup = this.device.createBindGroup({
      layout: this.adjustPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.demosaicedTexture.createView() },
        { binding: 1, resource: this.adjustedTexture.createView() },
        { binding: 2, resource: { buffer: this.adjustUniformBuffer } },
      ],
    });
    const adjustPass = encoder.beginComputePass();
    adjustPass.setPipeline(this.adjustPipeline);
    adjustPass.setBindGroup(0, adjustBindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    adjustPass.dispatchWorkgroups(wx, wy);
    adjustPass.end();

    const blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.adjustedTexture.createView() },
        { binding: 1, resource: this.blitSampler },
      ],
    });
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    renderPass.setPipeline(this.blitPipeline);
    renderPass.setBindGroup(0, blitBindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.bayerTexture?.destroy();
    this.normalizedTexture?.destroy();
    this.demosaicedTexture?.destroy();
    this.adjustedTexture?.destroy();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu/pipeline.ts
git commit -m "feat: wire GPU pipeline (upload, unpack, demosaic, adjust, blit)"
```

No automated test — GPU output correctness is checked visually in Task 10. Type-check now to catch binding/layout mistakes early:

Run: `npx tsc --noEmit`
Expected: no errors.

---

## Task 8: UI wiring + error handling

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Implement**

Replace `src/main.ts`:

```ts
import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError } from './raw/decode';
import type { AdjustState } from './gpu/uniforms';

const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;

const state: AdjustState = { exposureEV: 0, wbShift: 0 };

function showError(message: string): void {
  errorEl.textContent = message;
}

function clearError(): void {
  errorEl.textContent = '';
}

let pipeline: Pipeline;

async function init(): Promise<void> {
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'WebGPU is not available.');
    fileInput.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
  }
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  clearError();
  try {
    const decoded = await decode(await file.arrayBuffer());
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    pipeline.load(decoded);
    pipeline.render(state);
  } catch (err) {
    if (err instanceof DecodeError) {
      showError(`Couldn't read this file (LibRaw error ${err.code}).`);
    } else {
      showError(err instanceof Error ? err.message : 'Failed to decode file.');
    }
  }
});

exposureSlider.addEventListener('input', () => {
  state.exposureEV = Number(exposureSlider.value);
  pipeline?.render(state);
});

wbSlider.addEventListener('input', () => {
  state.wbShift = Number(wbSlider.value);
  pipeline?.render(state);
});

init();
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke test — WebGPU-supported path**

Run: `npm run dev`, open the printed local URL in Chrome/Edge. Select your `.dng`/`.nef` sample via the file input.
Expected: an image appears on the canvas (rough colors from bilinear demosaic are fine — sharpness/color accuracy isn't the target of this spike).

- [ ] **Step 4: Manual smoke test — decode failure path**

Create a throwaway garbage file and select it:
```bash
head -c 100 /dev/urandom > /tmp/garbage.dng
```
Expected: the `#error` paragraph shows a message; canvas is untouched (no crash, no blank white flash).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire file picker, sliders, and error handling to the pipeline"
```

---

## Task 9: Perf harness

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add timing around decode+demosaic and slider→frame**

Edit `src/main.ts`, wrap the two hot paths:

```ts
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  clearError();
  const start = performance.now();
  try {
    const decoded = await decode(await file.arrayBuffer());
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    pipeline.load(decoded);
    pipeline.render(state);
    const elapsed = performance.now() - start;
    console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);
  } catch (err) {
    if (err instanceof DecodeError) {
      showError(`Couldn't read this file (LibRaw error ${err.code}).`);
    } else {
      showError(err instanceof Error ? err.message : 'Failed to decode file.');
    }
  }
});

function onSliderInput(): void {
  const start = performance.now();
  pipeline?.render(state);
  const elapsed = performance.now() - start;
  console.log(`slider->frame: ${elapsed.toFixed(1)}ms`);
}

exposureSlider.addEventListener('input', () => {
  state.exposureEV = Number(exposureSlider.value);
  onSliderInput();
});

wbSlider.addEventListener('input', () => {
  state.wbShift = Number(wbSlider.value);
  onSliderInput();
});
```

Remove the two now-duplicated `addEventListener('input', ...)` blocks from Task 8's version before pasting this in.

- [ ] **Step 2: Manual check**

Run: `npm run dev`, load a file, open the browser console, drag a slider.
Expected: `decode+demosaic: ...ms` logs once per file load; `slider->frame: ...ms` logs on every slider move.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: add console-logged perf timing for decode and slider paths"
```

---

## Task 10: Pass/fail verification against the brief's targets

This is the actual spike gate — not an automated test, because it's measuring against your hardware and your specific 60MP file. Use the [`run`](../../../CLAUDE.md) workflow or `npm run dev` directly.

**Files:** none (verification only)

- [ ] **Step 1: Decode+demosaic timing on your largest file**

Load your biggest raw file (ideally ~60MP; use whatever's largest available if not). Read the `decode+demosaic: Nms` console log.
Target: < 2000ms. If missed, note in the spec whether it's decode-bound or upload-bound (add a second `performance.now()` split around just the `decode()` call vs. just `pipeline.load()`).

- [ ] **Step 2: Slider responsiveness**

Drag the exposure slider continuously for a few seconds. Watch the `slider->frame: Nms` logs.
Target: every log < 50ms. If missed, the brief is explicit: this means the pipeline is still touching the CPU somewhere in the adjust/blit path — fix before treating anything else as done.

- [ ] **Step 3: Memory stability across 10 file loads**

Load 10 different raw files in sequence (repeats are fine if you don't have 10 distinct ones). Watch for a crash or an out-of-memory tab reload.
Target: no crash. Chrome's `chrome://gpu` and the Task Manager's GPU memory column can help spot a leak if one file's textures aren't being destroyed before the next load — check `Pipeline.load()`'s `.destroy()` calls if this fails.

- [ ] **Step 4: Record the results**

Append a short "Results" section to the spec file (`docs/superpowers/specs/2026-08-23-webgpu-raw-pipeline-spike-design.md`) with the three numbers/outcomes and the hardware you tested on.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-23-webgpu-raw-pipeline-spike-design.md
git commit -m "docs: record spike pass/fail results"
```

---

## Self-Review Notes

- **Spec coverage:** §1 project structure/wrapper → Tasks 3–4. §2 GPU pipeline → Tasks 6–7. §3 UI → Task 8. §4 perf harness → Task 9 (and the actual gate in Task 10). §5 error handling → Task 8, Steps 3–4. §6 security (bounds check, LGPL via submodule) → Task 3 (`validate_dimensions`) and Task 4. §7 maintainability (`strict`, modern C++, small UI/pipeline boundary) → Task 1 Step 3, Task 4 (`std::make_unique`/`std::memcpy` at the documented FFI exception), Task 8. §8 business model — no code, intentionally not represented in the plan.
- **Type consistency checked:** `AdjustState`/`DecodedRaw` defined once (Tasks 2 and 5) and imported everywhere else rather than redeclared; `packAdjustUniforms`/`packCfaPattern` signatures match their call sites in `pipeline.ts`; WGSL struct layouts (`Levels`, `Cfa`, `Adjust`) match the byte layout written by `uniforms.ts` and `pipeline.ts`'s `writeBuffer` calls.
