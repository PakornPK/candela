# WebGPU Raw Pipeline Spike — Design

**Date:** 2026-08-23
**Scope:** 2-week technical spike per [`CLAUDE.md`](../../../CLAUDE.md). Goal: prove the WebGPU pipeline is fast enough (< 2s decode+demosaic on 60MP, < 50ms slider→frame update, stable across 10 file loads). This is not the start of the product — it is a test of one technical assumption.

## 1. Project structure & LibRaw wrapper

LibRaw is compiled from source ourselves (Emscripten toolchain already installed locally), not via the `libraw-wasm` npm package, to control the exact output shape and avoid depending on an external wasm build.

```
candela/
  native/libraw-wrapper/
    third_party/libraw/       # git submodule, pinned to a specific LibRaw release
    CMakeLists.txt            # add_subdirectory(third_party/libraw); wrapper target
    wrapper.cpp                # C++ shim exposing decode()
    build.sh                   # emcmake cmake -B build && cmake --build build
                                # outputs libraw.js + libraw.wasm -> src/wasm/
  src/
    wasm/                      # compiled output (gitignored, produced by build.sh)
    shaders/
      unpack.wgsl              # raw16 -> normalized float (black/white level)
      demosaic.wgsl            # bilinear Bayer -> RGBA
      adjust.wgsl               # exposure + white balance gain
      blit.wgsl                 # texture -> canvas (srgb)
    gpu/pipeline.ts            # WebGPU device/texture/shader orchestration
    main.ts                    # file picker, sliders, glue (vanilla DOM)
  index.html
  tsconfig.json                # strict: true
```

LibRaw source is vendored as a **git submodule** (pinned commit) rather than an untracked download, so the exact decode output is reproducible across machines — important because the pass/fail metrics depend on measuring against a known input.

`wrapper.cpp` exposes a single function:

```
decode(fileBytes: ArrayBuffer) -> {
  width: number,
  height: number,
  bayerData: Uint16Array,
  blackLevel: number,
  whiteLevel: number,
  cfaPattern: string   // e.g. "RGGB"
}
```

No color matrix, no thumbnails, no metadata beyond what normalize/demosaic need — per brief, color science (DCP, camera profiles) is explicitly out of scope for this spike.

`wrapper.cpp` is written in modern C++ (C++17): RAII/smart pointers for any owned buffer, no manual `new`/`delete`, `std::span` for viewing LibRaw's output instead of raw pointer+length pairs. This is also what makes the bounds-checking in section 6 straightforward to get right.

## 2. GPU pipeline

`gpu/pipeline.ts` runs everything after upload on the GPU — no readback to the WASM heap except on export (not built in this spike).

1. **Upload**: `bayerData` (`Uint16Array`) → texture `r16uint`, size width×height, 1 channel.
2. **Unpack + normalize** (compute shader): read `r16uint` → subtract `blackLevel`, divide by `(whiteLevel - blackLevel)` → write to `r32float` texture.
3. **Demosaic** (compute shader, **bilinear**): read CFA pattern from a uniform → write `rgba16float`. Bilinear is the deliberate starting point per brief — it's cheap and isolates whether the *pipeline* is fast, separate from demosaic quality. Upgrading to Malvar-He-Cutler is a later step, only once the bilinear baseline passes the 50ms/2s targets; starting with a heavier algorithm would make a missed target ambiguous (architecture problem vs. algorithm cost).
4. **Adjust** (compute shader): multiply exposure gain (`2^EV`) and white balance gain per R/B channel.
5. **Blit** (render pass, fragment shader): draw `rgba16float` → canvas context, format `srgb`.

Both sliders write into one uniform buffer (`{ exposureEV: f32, wbShift: f32 }`). A slider move re-runs only stages 4–5 (not demosaic), which is what keeps slider→frame updates under the 50ms target.

Old GPU textures are `.destroy()`ed on every new file load — this is what the "open 10 files without crashing" test is actually checking.

## 3. UI

Vanilla DOM, no framework — the entire UI surface is one file input, two range sliders, and a canvas. State is 3 primitives (`exposureEV`, `wbShift`, current decoded file) plus a reference to the current GPU texture set. There's no list rendering, no routing, no shared state across components — the surface a framework would help with doesn't exist here. If the product moves past the spike into a real catalog/thumbnail-grid UI (see brief's "After the spike"), framework choice gets revisited then, not now.

This is a cheap decision to reverse: `main.ts` is the only thing that talks to the DOM. `gpu/pipeline.ts` and the wasm wrapper expose a plain `load()`/`render()` API and know nothing about how state is managed. Swapping in a framework later means rewriting `main.ts` alone — the GPU pipeline is untouched.

```ts
// main.ts — single file, plain event listeners
const fileInput = document.querySelector<HTMLInputElement>('#file')!;
let state = { exposureEV: 0, wbShift: 0 };

fileInput.addEventListener('change', async (e) => {
  const decoded = await decode(await file.arrayBuffer());
  pipeline.load(decoded);   // destroys old textures, uploads new
  pipeline.render(state);
});

for (const [slider, key] of sliderBindings) {
  slider.addEventListener('input', () => {
    state[key] = Number(slider.value);
    pipeline.render(state);  // re-runs stage 4+5 only
  });
}
```

## 4. Perf harness

No dashboard — `performance.now()` around two spans, logged to console:

- decode+demosaic total (file selected → first frame on screen)
- slider → frame update (slider `input` event → frame complete)

This is what the pass/fail table in the brief is measured against.

## 5. Error handling

- **WebGPU unsupported**: check `navigator.gpu` at startup; if absent, show a short message in place of the canvas.
- **Decode failure** (corrupt file, unsupported format): `wrapper.cpp` checks every LibRaw return code before reading output and returns an error rather than throwing from C++; `main.ts` catches it and writes a short message via `textContent` near the file input.
- **WebGPU device lost**: not handled in this spike, per brief.

## 6. Security

Scope, given there is no network/backend/account at all:

- **Malformed/malicious raw files**: `wrapper.cpp` checks every LibRaw call's return code before touching its output, and validates `width`/`height` against a sane upper bound (e.g. < 200MP) before allocating/copying into a `Uint16Array`. WASM's memory sandbox already contains the blast radius of a native memory-safety bug, but the goal is to fail cleanly (an error to `main.ts`) rather than crash or hand back garbage.
- **LGPL compliance**: LibRaw is LGPL. Both the wrapper source and the LibRaw submodule live in this repo and build from source via the checked-in `build.sh` — satisfies the relink/source-availability requirement as long as the repo (or an equivalent source drop) stays available to users.

## 7. Maintainability & deployment cost

- TypeScript: `tsconfig.json` with `strict: true` — no additional code, just a config flag.
- C++: one CMake target, one exported function (`decode`). Surface is intentionally small.
- Deployment cost is ~$0 by construction — the brief's "no backend, no network calls" already means the build output is static files (`vite build`) that can be hosted on any free static host (GitHub Pages, Cloudflare Pages) or run purely from local dev during the spike. No infrastructure to design for this phase.

## 8. Business model (non-technical note, out of scope for this spike)

Considered auth server + subscription + PostgreSQL backend — rejected: it directly contradicts the brief's stated positioning ("no subscription... photos never leave the machine") and is an unrelated subsystem to the pipeline spike. Decided instead: **donationware / GitHub Sponsors**, which requires no server, no auth, and no change to the client-only architecture. This is a placeholder decision to revisit after the spike proves the pipeline is viable — it does not affect anything in sections 1–7.

## Out of scope (per brief, unchanged)

DCP/color profiles, op graph, UI framework, catalog/thumbnail cache, masking/healing/lens correction/export presets, AI features, plugin API.
