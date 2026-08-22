# Raw Photo Editor — Spike Brief

## Project context

A raw photo editor that runs 100% client-side in the browser. No backend, no uploads.

**Target user:** Enthusiasts and semi-pros with tens of thousands of raw files, looking for a way off Adobe Lightroom after the price increases.

**Positioning:** Opens instantly, no install, no subscription, photos never leave the machine.

**This is not a Lightroom clone.** The goal is not feature parity — it is to win at one thing: culling and developing raw files fast on a large catalog.

---

## Scope of this spike (2 weeks)

One goal: **prove the WebGPU pipeline is fast enough.**

This is not the start of the product. It is a test of a technical assumption.

### Must work

1. Pick a single raw file (CR3 or ARW) via file picker
2. Decode with LibRaw (WASM) to get Bayer data
3. Upload to a GPU texture
4. Demosaic in a compute shader
5. Adjust exposure and white balance via sliders
6. Render to canvas

### Pass/fail criteria

| Metric | Target | If missed |
|---|---|---|
| Decode + demosaic, 60MP | < 2s | Profile whether the cost is in decode or upload |
| Slider → frame update | < 50ms | **Pipeline is still touching the CPU. Fix immediately.** |
| Memory stability | Open 10 files in a row without crashing | Check that textures are being destroyed |

The 50ms number is the single most important metric. Missing it means the architecture is wrong from the start.

---

## Architectural constraints

### 1. GPU-first, non-negotiable

WASM32 has a 4GB address space. A 60MP image at 16-bit float RGBA is **~960MB for a single buffer.** A CPU-side pipeline hits the ceiling on the second image.

**Rule:** WASM only decodes the raw, then uploads straight to a GPU texture. Every stage after that stays on the GPU. No readback to the WASM heap except on export.

GPU memory does not count against the 4GB limit.

### 2. Chromium-only is an accepted decision

The File System Access API (`showDirectoryPicker`) is supported only in Chrome, Edge, and Opera. Safari and Firefox ship only OPFS, which is sandboxed and cannot substitute.

Do not spend time on fallbacks for other browsers in this spike.

### 3. No network calls of any kind

No backend, no telemetry, no CDN for user data. This is the product's selling point, not an implementation detail.

---

## Recommended stack

**For this spike: TypeScript + WGSL + LibRaw (WASM)**

Fastest setup, and **WGSL shaders written now port to Rust + wgpu unchanged.** The shaders are the reusable asset; glue code is cheap to rewrite.

Long-term plan (not now): move the core to Rust + wgpu so it compiles to both web and native from one codebase.

### Libraries

- `libraw-wasm` or another LibRaw port for decode
- WebGPU API directly, no wrapper
- No UI framework — two `<input type="range">` elements is enough

---

## Do not do these in this spike

This list matters as much as the list above.

- **Do not touch DCP or camera color profiles.** Use whatever color matrix LibRaw provides. Color science is a bottomless pit; defer it.
- **Do not design a clean op graph.** Hardcode the shader chain. Refactor later.
- **Do not pick a UI framework.** Vanilla DOM.
- **Do not build a catalog, database, or thumbnail cache.**
- **Do not build masking, healing, lens correction, or export presets.**
- **Do not add any AI features.**

Wanting to start any of these means avoiding the actually hard part.

---

## Known trouble spots

**Bayer upload** — LibRaw returns 16-bit single-channel data. Pick the right texture format (`r16uint` or `r32float`) and watch for row padding.

**Demosaic algorithm** — Start with bilinear. It looks bad but takes 30 minutes to write and is sufficient for measuring performance. Move to Malvar-He-Cutler or AMaZE later. Do not start with AMaZE.

**Black level / white level** — LibRaw provides these. Normalize before demosaic or the image will be crushed or clipped.

**Color space** — Output to canvas as `srgb` first. Worry about display-p3 later.

**WebGPU device loss** — No need to handle it in the spike, but be aware it exists.

---

## After the spike

If the numbers pass and the work is still enjoyable, the order is:

1. Make the internal op graph composable (for undo/history and non-destructive edits)
2. Catalog, thumbnail cache, virtual scroll — tedious work, but the only reason anyone picks this over darktable
3. A genuinely good tone curve, especially highlight rolloff. 90% of "why doesn't this look as good as Lightroom" comes from tone mapping, not the color matrix.
4. DCP loader — let users point at their own files. Bundling Adobe's profiles is not permitted under their EULA.
5. Preset import/export — the photography ecosystem runs on presets, not plugins, and presets are data rather than code. Safer, and it does not lock down any API.

**Do not build a plugin API** until there are tens of thousands of users. It freezes refactoring before anyone is even using the product.
