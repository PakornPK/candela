# Candela

A raw photo editor that runs 100% client-side in the browser. No backend, no
uploads, no subscription — your photos never leave the machine.

Built to win at one thing: **culling and developing raw files fast on a large
catalog**. It is deliberately not a Lightroom clone.

## How it works

The whole pipeline after decode runs on the GPU:

```
raw file → LibRaw (WASM) → Bayer/X-Trans data → GPU texture
        → demosaic → adjustment op chain → canvas
```

WASM only decodes the raw; the image is uploaded straight to a GPU texture and
every adjustment after that runs as a WGSL compute pass. No CPU readback except
on export. This is what keeps slider edits and culling fluid on 60MP files.

The shaders are the reusable asset — they're plain WGSL, written to port to
Rust + wgpu unchanged if the core ever moves to native.

## Features

**Culling**
- Open any folder of raws via the File System Access API (Chromium only)
- Virtualized contact sheet sized to each shot's true aspect, with a cull filter
- Star ratings, history

**Develop** — LrC-style collapsible panels:
- Live histogram (R/G/B + luminance)
- Color profile (camera / neutral)
- White balance: temperature + tint
- Tone: exposure, contrast, highlights, shadows, whites, blacks in log-luminance space
- Black & White treatment with an 8-band hue mix
- Presence: texture, clarity, dehaze, vibrance, saturation
- Tone curve
- Effects: vignette, grain, light leak (committed Unsplash textures)
- Dodge & Burn
- Transform: rotate, straighten, scale, aspect, offset
- Crop as an LrC-style draggable/resizable frame
- Film frame overlays

**Export**
- JPEG / PNG / 16-bit TIFF, with box-pyramid downscale (exact area-average, no
  single bilinear leap)

## Tech stack

- TypeScript + Vite, vanilla DOM (no UI framework)
- WebGPU + WGSL for the entire image pipeline
- LibRaw → WASM (Emscripten) for decode
- @tanstack/virtual-core for virtualized lists
- Vitest for tests

## Getting started

Requires a **Chromium browser with WebGPU** (Chrome / Edge / Opera). WebGPU and
the File System Access API are secure-context-only, so run over `localhost` or
HTTPS.

```sh
npm install
npm run dev        # http://localhost:5174
npm test           # vitest
npm run build      # tsc + vite build → dist/
npm run preview    # serve the production build
```

## Deploying

A GitHub Actions workflow (`.github/workflows/pages.yml`) builds and deploys to
GitHub Pages. Enable it once in the repo: **Settings → Pages → Source → GitHub
Actions**. Then every push to `main` deploys to `https://<user>.github.io/candela/`.

The built LibRaw WASM is committed so CI builds without the native toolchain.

## Project layout

```
src/
  gpu/        op chain, uniform packing, render pipeline, unit tests
  shaders/    WGSL — demosaic + every adjustment
  raw/        LibRaw decode, thumbnail
  catalog/    contact sheet, culling, virtual scroll
  wasm/       prebuilt libraw.js + libraw.wasm
native/
  libraw-wrapper/  C++ wrapper + LibRaw submodule (cmake + emcc build)
scripts/      dev-time asset vendoring (film frames, light leaks)
public/
  frames/  leaks/   vendored Unsplash textures
```

## Rebuilding the LibRaw WASM

`src/wasm/` is prebuilt. To rebuild from source:

```sh
git submodule update --init --recursive
cd native/libraw-wrapper && ./build.sh
```

## Asset provenance

Film-frame and light-leak textures are free-to-use photos vendored from Unsplash
at dev time (`scripts/vend-frames.mjs`, `scripts/vend-light-leaks.mjs`) and
committed under `public/`. No runtime network calls.

## License

MIT — see [LICENSE](LICENSE). LibRaw, used for decode via the
`native/libraw-wrapper` submodule, is LGPL-2.1/CDDL-1.0 dual-licensed and retains
its own license.
