Evidence gathered. All fifteen files read in full; no file edited, no test/build run, no git write command executed.

---

### src/catalog/culling.ts (45 lines — `wc -l` reports 44; file has no trailing newline)
exports: `setCull` (function) — apply one flag/rating/color change to a file row via get-merge-put; `applyCullResult` (function) — sync a saved row back onto the in-memory record the grid renders from
imports: `./types` (type-only, :1)
device-api hits: `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`device.`/`writeBuffer`/`createBindGroup`/`createShaderModule`/`requestAdapter`/`.wgsl`/`fetch` — **none in code**. `IDBDatabase` :9; IDB calls `db.transaction` :14, `store.get` :15, `store.put` :27
pure ranges: 40-45 (`applyCullResult` — plain key deletion, no API); 22-26 (the domain rule: spread-merge + `rating === 0`/`color === 0` → delete) — but nested inside the IDB callback
impure ranges: 8-33 (`setCull`, whole transaction wrapper 13-32)
verdict: **split → domain: 40-45 + 22-26 (extracted as a normaliser), adapters/idb: 8-33**
test importers: 1 — `src/catalog/culling.test.ts`
name-vs-content: Name accurate (cull marks only). Center of gravity inverted vs the ADR row: 26 of 45 lines are IDB plumbing; the pure payload is 5 lines of normalisation plus 6 lines of record sync. `setCull`'s merge-normalisation is **inside** the `request.onsuccess` closure (:16-30), so the split is not two contiguous blocks.

---

### src/catalog/iptc.ts (271 lines)
exports: `IptcFields` (interface) — the six editable IPTC fields; `IptcFileRow` (type) — `FileRecord` + `iptc` bag; `MetadataPreset` (interface) — a named preset row; `METADATA_PRESET_STORE` (const) — IDB store name :46; `IptcFieldKey` (type) — canonical key union; `presetToPatch` (function) — preset → sparse patch omitting blanks; `fieldsFromPresetForm` (function) — panel form → storable fields; `describePreset` (function) — one-line summary; `diffIptc` (function) — differing keys; `newPresetId` (function) — preset id; `mergeIptc` (function) — merge semantics for the `iptc` bag; `setFileIptc` (function) — IDB write of per-file IPTC; `listMetadataPresets`/`saveMetadataPreset`/`deleteMetadataPreset` (functions) — preset CRUD
imports: `./types` (type-only, :24)
device-api hits: `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`fetch`/`.wgsl` — none. `crypto` (browser global) :107 (×2), :108. `Math.random`/`Date.now` :110. `IDBDatabase` :128, :203, :219, :241, :260; `IDBTransaction` :137, :222, :246; `db.objectStoreNames.contains` :205; `transaction`/`objectStore`/`getAll`/`put`/`delete` :137-141, :226, :232, :250, :264
pure ranges: 26-53 (vocabulary: interfaces + `IPTC_KEYS` :51), 57-101 (`clean`, `presetToPatch`, `fieldsFromPresetForm`, `describePreset`, `diffIptc`), 113-117 (`isValidPresetRow`), 189-196 (`mergeIptc`), 213-217 (`missingStoreError`)
impure ranges: 106-111 (`newPresetId` — browser `crypto.randomUUID`), 127-182 (`setFileIptc`), 203-211 (`hasPresetStore`), 219-239, 241-258, 260-271
verdict: **split → domain: 26-101, 113-117, 189-196, 213-217; adapters/idb: 127-182, 203-211, 219-271; `newPresetId` 106-111 → `domain/ports/` (an id source) or an adapter helper**
test importers: 1 — `src/catalog/iptc.test.ts`
name-vs-content: Partly misleading. The name covers IPTC fields (26-101, 127-196), but ~70 lines are a **generic named-preset store** — `MetadataPreset` :40-44, `METADATA_PRESET_STORE` :46, and the list/save/delete triple 219-271 — whose only IPTC tie is that its `fields: IptcFields`. Also: `mergeIptc` (189-196) is pure yet sits *below* the `// ---- IndexedDB: per-file IPTC ----` header at :119, so a header-guided split misfiles it into the adapter.

---

### src/catalog/keywords.ts (500 lines)
exports: `KeywordSource`/`KeywordFile`/`KeywordSuggestionSource`/`KeywordTally` (interfaces) — narrow structural input shapes; `normalizeKeyword` (function) — strip `,;|`, collapse whitespace, drop trailing `*`, preserve case; `keywordKey` (function) — case-insensitive identity key; `sanitizeKeywords` (function) — dedupe + keep first-seen order; `parseKeywordField` (function) — comma/newline text → tags; `addKeywords` (function); `removeKeywords` (function); `toggleKeyword` (function); `renameKeywordIn` (function) — one-list rename, `null` if unchanged; `DEFAULT_SUGGESTION_WINDOW_MS` (const) — 2 h window :210; `buildKeywordList` (function) — derived catalog tally, count-desc then alpha; `filesMatchingKeyword` (function); `keywordSuggestions` (function) — time-neighbour suggestions
imports: `./types` (type-only, :17)
device-api hits: `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`fetch`/`crypto`/`.wgsl` — none. `IDBDatabase` :278, :287, :298, :331, :448; `IDBTransaction` :350, :457; `IDBCursorWithValue` :380; `db.transaction` :353, :460; `store.get` :470, `store.put` :485, `store.openCursor` :386, `cursor.update` :415, `cursor.continue` :391
pure ranges: 19-267 (all of it — types 24-40, normalisation 42-158, derived list/filter/suggest 160-259, `captureTime` 261-267)
impure ranges: 269-500 (IDB layer: `setFileKeywords` 277-284, `addKeywordsToFiles` 286-295, `removeKeywordsFromFiles` 297-306, `renameKeywordAcrossCatalog` 330-429, `writeKeywords` 433-441, `updateFiles` 447-500)
verdict: **split → domain: 19-267 (proposal `<area>` = `keywords/`), adapters/idb: 269-500**
test importers: 1 — `src/catalog/keywords.test.ts`
name-vs-content: Accurate, and it is the one catalog file whose internal section headers match the real boundary exactly (headers at :19, :42, :160, :269; the pure/IDB line falls at 267/269). Not function-interleaved — the IDB writers *call* the pure functions (`sanitizeKeywords` :283, `addKeywords` :291, `removeKeywords` :302, `renameKeywordIn` :412), they do not mix rules into callbacks.

---

### src/catalog/thumbnails.ts (282 lines)
exports: `loadThumbnail`/`saveThumbnail` (functions) — camera-image cache rows; `RENDER_DIGEST_VERSION` (const) `'v2'` :68 — cache-invalidating render-format version; `opDigest` (function) — FNV-1a fingerprint of an op chain; `loadEditedThumbnail`/`deleteEditedThumbnail`/`saveEditedThumbnail` (functions) — developed-render rows; `developedRenderNeeded` (function) — the pure freshness decision; `needsEditedThumbnail` (function) — async decision over a cached row; `getThumbnailBlob` (function) — the blob a cell should show; `getEmbeddedThumbnail` (function) — camera JPEG only; `getOrExtractThumbnail` (function) — cache-or-extract. Private: `ThumbnailRow`, `EditedThumbnailRow` (row shapes), `extractCameraThumbnail`, `createImageThumbnail`
imports: `./types` (:1, type-only), `../raw/thumbnail` (:2), `./import` (:3), `./permissions` (:4), `./editsStore` (:5), `./editHistory` (:6)
device-api hits: `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`device.`/`fetch`/`.wgsl` — none. `IDBDatabase` :17, :28, :130, :138, :146, :182, :205, :221, :228, :255; IDB `transaction`/`objectStore`/`get`/`put`/`delete` :19, :30, :132, :139, :148; **File System Access** `record.handle` :229, :234, `.getFile()` :234, `file.arrayBuffer()` :235; **`Blob` ctor** :264; **`createImageBitmap`** :265; **`OffscreenCanvas`** :272; **`canvas.getContext('2d')`** :273; **`ctx.drawImage`** :278; `bitmap.close()` :275, :279; **`canvas.convertToBlob`** :281; `console.warn` :249; `Date.now()` :30, :148. Calls `extractThumbnail` (LibRaw) :241
pure ranges: 68 (`RENDER_DIGEST_VERSION`), 70-121 (`opDigest` — FNV-1a, per-kind op field selection), 169-177 (`developedRenderNeeded`)
impure ranges: 1-6 (imports across four adapters), 8-12 + 123-128 (IDB row shapes), 17-35, 130-153, 181-194, 205-217, 220-225, 227-253, 255-259, 261-282
verdict: **split → domain: 68, 70-121, 169-177 (proposal `<area>` = `thumbnails/`, or fold into a `develop/` cache-rules area); adapters/idb: 17-35, 123-153, 181-194, 205-259; adapters/dom (browser imaging) : 261-282; the FS + raw calls at 229-243 stay in `adapters/idb` only as a caller of `adapters/fs` and `adapters/raw`**
test importers: 1 — `src/catalog/thumbnails.test.ts`
name-vs-content: Misleading in scale. The name reads as one cache adapter; the file owns (a) the pipeline-wide cache-invalidation rule — `opDigest` + `RENDER_DIGEST_VERSION` 68-121, whose header says bumping it "makes every row written before it stale in one stroke" — which is a **domain** decision affecting the whole develop path, and (b) two `app`-shaped orchestrators, `needsEditedThumbnail` 181-194 and `getThumbnailBlob` 205-217, which sequence `loadEditState` → `currentOps` → `opDigest` → IDB read → fallback extract. `getThumbnailBlob` interleaves that decision logic with awaited I/O inside one `try` (:206-213) — not math-vs-buffer interleaving, but decision code that cannot move to `domain/` as written.

---

### src/gpu/crop.ts (293 lines)
exports: `ASPECT_PRESETS` (const) — the eight preset labels; `ASPECT_RATIO` (const) — ratio per preset; `CropParams` (interface) — op shape incl. freeform x/y/w/h; `isFreeformCrop`/`isNeutralCrop` (functions); `CropHandleMode` (type) — move/edges/corners; `cropHandleAt` (function) — hit-test a pointer; `lockedCropAspect` (function); `dragCropRect` (function) — apply a pointer drag, clamped to source; `cropRect` (function) — source-space capture rect; `CropGeometry` (interface); `cropGeometry` (function) — mask bbox + LrC frame extents; `packCrop` (function) — uniform Float32Array; `CropOverlayRect` (interface); `cropOverlayRect` (function); `cropRegion` (function) — normalized frame rect, Post-Crop source of truth
imports: `../catalog/types` (:44) — `isCropOp`, `AspectPreset`, `Op`
device-api hits: **none**. The only grep hit is the word "fit-to-window" inside a comment (:27). `crop.wgsl` appears only in comments (:1, :18, :250). `new Float32Array` :253 (a plain typed array, not a device call)
pure ranges: 46-248 (vocabulary, geometry, drag math, `cropGeometry`), 261-293 (`CropOverlayRect`, `cropOverlayRect`, `cropRegion`)
impure ranges: 251-254 (`packCrop` — buffer layout for the `Crop` struct in crop.wgsl, 6 f32 + 2 pad)
verdict: **split → domain: 46-248, 261-293 (proposal `<area>` = `crop/`); adapters/gpu: 251-254**
test importers: 1 — `src/gpu/crop.test.ts`
name-vs-content: Accurate. Two notes: (1) the adapter side is **4 lines of 293** — the ADR's `split` label is correct but the cost is trivial, not comparable to ops.ts; (2) `cropHandleAt`/`dragCropRect`/`CropOverlayRect`/`cropOverlayRect` carry overlay/DOM vocabulary ("the DOM workbench drags" :87, "The DOM selection frame" :272) while touching no DOM API — they will land in `domain/` under names that read like adapter code.

---

### src/gpu/ops.ts (336 lines)
exports: `setCameraColorMatrix`/`getCameraColorMatrix` (functions), `setCameraXyz`/`getCameraXyz`, `setAsShotGains`, `setImageSize` — module-level per-file state accessors written by `pipeline.load()`; `OpRenderer` (interface) — one GPU pass descriptor; `OP_RENDERERS` (const) — the ordered 14-pass registry; `presentOpIndices` (function) — which registry indices run
imports: 14 × `../shaders/*.wgsl?raw` (:1-14, verified: 19 `.wgsl` files exist in `src/shaders/`), `./uniforms` :15, `./tone` :16, `../catalog/types` :17, `./presence` :18, `./vignette` :19, `./grain` :20, `./lightleak` :21, `./frame` :22, `./bw` :23, `./crop` :24, `./geometry` :25, `./dodge` :26, `./film` :27, `./film` (type) :28
device-api hits: **`.wgsl` imports :1-14** (the shader sources that `createShaderModule` consumes). No `GPUDevice`/`device.`/`writeBuffer`/`createBindGroup`/`createShaderModule`/`requestAdapter`/`document`/`window`/`indexedDB`/`navigator`/`fetch`. Buffer-layout markers: `uniformSize` :96, :109, :127, :137, :152, :177, :190, :208, :222, :241, :256, :271, :288, :302, :316; `new Float32Array` :37, :121, :130, :140
pure ranges: 93-98 (the `OpRenderer` interface — but it declares `shader: string` + `uniformSize` in bytes, so as written it is a **GPU pass port**, not domain vocabulary); 331-336 (`MANDATORY_KINDS` + `presentOpIndices` — the op-chain ordering rule, pure); plus nine inline domain defaults inside the closures: :155 (tone), :180 (bw), :211 (presence), :225 (geometry), :244 (lightleak), :259 (crop), :274 (vignette), :291 (dodgeBurn), :305 (grain)
impure ranges: 1-28 (`.wgsl` + 14 local modules), 37-88 (mutable per-file cache: `cameraColorMatrix` :37, `cameraXyz` :56, `asShotGains` :70, `imageSize` :79, with setters/getters :39-83), 100-330 (`OP_RENDERERS` — 14 entries each pairing shader source + byte size + packer)
verdict: **split → domain: 331-336 + the nine neutral-default literals extracted from the closures; adapters/gpu: 1-28, 37-88, 100-330 (the remainder) — ~95% adapter**
**⚠ NOT a contiguous-range split. Every one of the 14 `packParams` closures interleaves the two kinds inside a single function body:** e.g. `whiteBalance` :110-122 chooses the *domain* fallback (`asShotGains` when the op is absent, :120) and the *domain* conversion (`wbShiftToGains(kelvinToShift(...))`, :118) and then returns a uniform-format array (:121) in one 13-line closure; `crop` :257-261 reads the module-level `imageSize` (:260) into `packCrop`; `vignette` :272-276 and `frame` :318-320 pass `cropRegion(ops, imageSize[0], imageSize[1])` — a domain query — directly into a packer; `lightleak` :242-245 pulls `getGrainSeed()` (cross-op hidden state) and `ops.some(isBwOp)` into `packLightleak`'s third argument; `grain` :303-306 likewise calls `getGrainSeed()`. The object-literal entries (`kind`/`shader`/`uniformSize`/`packParams`) cannot be split by line range at all without changing `OpRenderer`'s shape. Functions to split by hand: all 14 `packParams` closures (:110, :128, :138, :153, :178, :191, :209, :223, :242, :257, :272, :289, :303, :317) plus the state block 37-88.
test importers: 2 — `src/gpu/ops.test.ts`, `src/gpu/presence.test.ts`
name-vs-content: **The most misleading name of the fifteen.** "ops" implies op vocabulary; every op type guard and the `Op` union itself live in `../catalog/types` (imported :17, 15 guards used). What the file actually holds is (1) the GPU pass registry (shader source + uniform byte size per WGSL struct) and (2) a **module-level mutable singleton cache** of the loaded file's camera matrices, As-Shot gains and image size (:37, :56, :70, :79), written per-load from outside. A `renderPassRegistry.ts` name would self-classify it as `adapters/gpu`.

---

### src/gpu/grain.ts (175 lines)
exports: `GrainParams` (interface); `GRAIN_DEFAULTS` (const) `{amount:0,size:25,roughness:50}`; `isNeutralGrain` (function); `setGrainSeed`/`getGrainSeed` (functions) — the loaded photo's seed; `seedFromPath` (function) — FNV-1a path → [0,1); `packGrain` (function) — uniform array; `hashU32`/`hash01`/`gauss` (functions) — the shader-identical hash + Box-Muller; `gradientNoise` (function) — Perlin clumps; `seedU32` (function) — the shader's float→u32 key; `grainNoise` (function); `grainResponse` (function) — linear luma in/out; `linearToSrgb` (function)
imports: none
device-api hits: **none** — `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`device.`/`fetch`/`fetch` all absent; `grain.wgsl` referenced only in comments (:1, :66, :71). `new Float32Array` :68
pure ranges: 27-64, 71-175 (vocabulary, defaults, the whole seeded-noise model, colour helpers)
impure ranges: 66-69 (`packGrain`, layout of the `Grain` struct — 4 f32 + 4 pad); 41-53 (`let currentGrainSeed = 0.5` :45 + accessors) — not a device API, but per-file mutable state written by `pipeline.load()` per the comment at :43-44
verdict: **split → domain: 27-40, 55-64, 71-175 (proposal `<area>` = `grain/`); adapters/gpu: 66-69 + the seed cache 41-53**
test importers: 3 — `src/gpu/grain.test.ts`, `src/gpu/lightleak.test.ts`, `src/gpu/ops.test.ts` (highest churn of the fifteen)
name-vs-content: Accurate; header line 1 declares it a CPU-side model. Note the split is **not function-interleaved** — every math function takes `seed` as a parameter (`grainNoise` :135, `grainResponse` :148, `packGrain` :67), so the mutable cache at :45 is read only by ops.ts:305/:245 via `getGrainSeed`. Two adapter islands (:41-53 and :66-69) sit inside one domain file. Also duplicated domain helpers to reconcile at move time: `linearToSrgb` :160-163, `mix01` :165, `smoothstep01` :169, `clamp01` :173 — the same three exist privately in lightleak.ts (:120, :124, :128) and publicly in vignette.ts (:29).

---

### src/gpu/film.ts (246 lines)
exports: `FilmChannelParams`/`FilmStock` (interfaces); `PORTRA_400` (const); `FILM_EXPOSURE_SCALE` (const) 17668; `filmDensity` (function) — H-D logistic; `filmicNegative` (function) — filmr scan curve; `srgbToLinear` (function); `filmRenderLinear` (function) — the per-channel composite; `FILM_MID_GRAY_TARGET` (const) 0.39; `filmExposureScale` (function) — 45-iteration bisection; `neutralGain` (function); `PORTRA_160`/`PORTRA_800`/`GOLD_200`/`EKTAR_100`/`SUPERIA_400`/`EKTACHROME_100`/`PROVIA_100F`/`VELVIA_50`/`CINESTILL_800T` (consts); `FILM_STOCKS` (const) — the picker's registry; `isFilmStockId` (function)
imports: `../catalog/types` (:27, type-only — `FilmStockId`)
device-api hits: **none at all.** No `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`device.`/`writeBuffer`/`createBindGroup`/`createShaderModule`/`requestAdapter`/`.wgsl`/`fetch`. No `Float32Array`. No `pack*` export
pure ranges: 27-246 — the entire file below the header
impure ranges: **none**
verdict: **move → `domain/`** (proposal `<area>` = `film/`)
test importers: 1 — `src/gpu/film.test.ts`
name-vs-content: Accurate — it is the film-stock model and registry. **This contradicts the ADR row that bundles it as `split`.** Its only shader coupling is a comment claim (:2 "the GPU tone op only looks up the baked LUTs") — the baking happens in tone.ts, not here. Note it is imported by 5 modules (`ops.ts`, `bw.ts`, `tone.ts`, `main.ts`, `catalog/editsStore.ts`), so a move is churn-bearing but layer-clean.

---

### src/gpu/bw.ts (147 lines)
exports: `BW_BAND_CENTERS` (const) — 8 hue-band centres; `BwParams` (interface); `BW_TONE_IDS` (const); `BwFilterId` (type); `BW_FILTERS` (const) — LrC camera-filter presets seeding the mix; `BW_TONES` (const) — mono tone control points; `isNeutralBw` (function); `hueDeg` (function); `bandWeight` (function) — piecewise-linear wrap; `bwLuminance` (function) — CPU mirror of bw.wgsl; `buildBwToneLut` (function) — log-domain bake; `packBw` (function) — uniform array
imports: `./film` (:26, `srgbToLinear`), `./tone` (:27, `TONE_LUT_SIZE`, `logToNorm`, `buildToneCurveLut`, `LUMA_WEIGHTS`), `../catalog/types` (:28, type-only — `BwMix`, `BwToneId`)
device-api hits: **none.** `bw.wgsl` in comments only (:2, :16, :105, :138). `new Float32Array` :125, :141
pure ranges: 33-136 (vocabulary incl. `BW_FILTERS` 45-52 and `BW_TONES` 60-66, `hueDeg`, `bandWeight`, `bwLuminance`, `buildBwToneLut`)
impure ranges: 140-147 (`packBw` — the `Bw` struct layout: mix 8 + tone id 4 + LUT 512 = 2096 B, multiple of 16)
verdict: **split → domain: 33-136 (proposal `<area>` = `bw/`); adapters/gpu: 140-147**
test importers: 2 — `src/gpu/bw.test.ts`, `src/gpu/ops.test.ts`
name-vs-content: Accurate. One judgment the owner must make: `buildBwToneLut` (:124-136) returns the `Float32Array` that `packBw` embeds. It is pure math (identity LUT for `'none'`, log-domain point mapping) and the LUT size/`logToNorm` come from `./tone`, so it reads as domain; but it exists only as uniform payload. Boundary is contiguous either way (:124 or :140). Also `out[8] = BW_TONE_IDS.indexOf(p.tone)` :145 — the uniform encodes tone as an array index, so `BW_TONE_IDS`' *order* (:40) becomes adapter-significant.

---

### src/gpu/lightleak.ts (130 lines)
exports: `LightleakParams` (interface); `LIGHTLEAK_DEFAULTS` (const) `{amount:0,hue:0,fade:0,pattern:-1}`; `isNeutralLightleak` (function); `packLightleak` (function) — uniform array; `LEAK_WIDTH` (const) 0.35; `edgeDistance` (function); `leakWeights` (function) — hue → 3 texture weights; `leakFade` (function); `leakColor` (function); `leakAdd` (function) — additive linear RGB; `leakResponse` (function)
imports: `./grain` (:20, `seedU32`)
device-api hits: **none.** `lightleak.wgsl` in comments only (:1, :37, :48). `new Float32Array` :44
pure ranges: 22-35 (interface, defaults, neutrality rule), 49-130 (`LEAK_WIDTH`, `edgeDistance`, `leakWeights`, `leakFade`, `WARM`/`MID`/`COOL` 83-85, `leakColor`, `TEX_FALLOFF` :99, `leakAdd`, `leakResponse`, helpers)
impure ranges: 37-45 (`packLightleak` — the `Lightleak` struct, 8 f32: amount, hue, fade, seed, patternMode, patternSel, bw flag, pad)
verdict: **split → domain: 22-35, 49-130 (proposal `<area>` = `lightleak/`); adapters/gpu: 37-45.** Not function-interleaved, but the adapter island sits **mid-file** at 37-45, so the domain side is two non-contiguous blocks.
test importers: 1 — `src/gpu/lightleak.test.ts`
name-vs-content: **This is the ADR's specifically-flagged row and the flag overstates it.** There is **no `LIGHTLEAK_PATTERN_NAMES`-style map here** — `pattern` is a bare `number` whose set labels exist only as comments (:26 "-1 auto (seed picks the set), 0 Set A, 1 Set B, 2 Set C, 3 Set D"; :39 "patternSel (0-3 = Set A..D)"). The human strings are produced elsewhere: `src/main.ts:1303` builds `' · Set A'`/`' · Set B'` inline, `src/main.ts:779` reads the select, and `src/catalog/types.ts:127` re-documents the same numeric code. So the "vocabulary that is the root of R1-1/R1-22" is a numeric convention spread over three files, with `lightleak.ts` holding only defaults + a `pack` that encodes it twice (`mode`/`sel`, :42-43). Second content caveat: the header states the CPU model **cannot** mirror the real effect — "the shader samples twelve vendored textures (public/leaks/*.png …) which the CPU can't" (:14-17) — so 49-130 is an admitted approximation of adapter data, not a spec.

---

### src/gpu/frame.ts (69 lines)
exports: `FrameStyle` (type) `'none'|'135'|'120'|'print'`; `FRAME_BORDER` (const) — border fraction per style; `PRINT_KEYLINE` (const) 0.005; `isNeutralFrame` (function); `frameStyleId` (function) — style → 3/0/1/2; `packFrame` (function) — uniform array; `imageSource` (function) — output→source fraction across the border; `isPrintKeyline` (function)
imports: none
device-api hits: **none.** `frame.wgsl` in comments only (:1, :20, :29, :35, :51). `new Float32Array` :53
pure ranges: 17-43, 58-68
impure ranges: 52-54 (`packFrame` — style id + crop rect + 3 pad); **plus 45-47 contested**: `frameStyleId` returns the numbers that the comment block says are the WGSL texture-array layer indices — "style id 3, border 0" (:8), "frame.wgsl as one texture_2d_array, layer = style" (:35-36)
verdict: **split → domain: 17-43, 58-68 (proposal `<area>` = `frame/`); adapters/gpu: 52-54 (+ 45-47 if the layer-index meaning is treated as adapter, not vocabulary)**
test importers: 1 — `src/gpu/frame.test.ts`
name-vs-content: Misleading by omission of what does the work. Only 17 lines of the file are logic; the actual visual result is three **vendored PNG textures** and the file's own note (:32-39) says "all three frame bands are REAL vendored photographs (public/frames/{135,120,print}-strip.png …) sampled by frame.wgsl" and that `FRAME_HOLE`/`inSprocketHole` "were removed with the old procedural holes". So `frame.ts` today is border fractions + a style→layer id map + a keyline hit-test. Moving the vocabulary half to `domain/` leaves an `adapters/gpu` partner whose real content is `public/frames/*.png` — outside `src/`, and the ADR's §3 table has no row for it.

---

### src/gpu/geometry.ts (76 lines)
exports: `GeometryParams` (interface) — vertical/horizontal keystone, rotate, aspect, scale, offsetX/Y; `isNeutralGeometry` (function); `geometryMap` (function) — the output→source homography; `packGeometry` (function) — uniform array
imports: none
device-api hits: **none.** `geometry.wgsl` in comments only (:1, :64). `new Float32Array` :65
pure ranges: 26-62
impure ranges: 65-76 (`packGeometry` — the `Geometry` struct, 8 f32, with the /100 and degrees→radians conversions duplicated from `geometryMap` :45-53)
verdict: **split → domain: 26-62 (proposal `<area>` = `transform/` — see naming warning); adapters/gpu: 65-76.** Clean two-block.
test importers: 1 — `src/gpu/geometry.test.ts`
name-vs-content: The contents match the name, but **the name collides with an ADR decision**: §3.1 already assigns `src/app/navigator.ts` → `domain/geometry/` and `src/app/viewState.ts` → `domain/geometry/` — that is *viewport/scroll* geometry. This file is LrC's **Transform** panel op (keystone/rotate/aspect/scale, header :1-2). Two different meanings of "geometry" would merge into one domain area. Also note this file exports **no** `GEOMETRY_DEFAULTS`; the neutral values (`scale: 100`, rest 0) exist only as the inline literal at `ops.ts:225`, so the ADR row's "defaults → domain" harvest for geometry.ts has nothing to move for that default. Same gap in vignette.ts (default literal only at `ops.ts:274`) and presence.ts (`ops.ts:211`) and dodge.ts (`ops.ts:291`).

---

### src/gpu/presence.ts (63 lines)
exports: `PresenceParams` (interface) — texture/clarity/dehaze/vibrance/saturation; `isNeutralPresence` (function); `packPresence` (function) — uniform array; `chromaBoost` (function) — combined chroma scale; `CLARITY_STRENGTH`/`CLARITY_MID_LOG`/`CLARITY_GATE_WIDTH` (consts); `clarityGate` (function) — midtone bell; `clarityLogLuma` (function) — CPU mirror of the clarity term
imports: none
device-api hits: **none.** `presence.wgsl` in comments only (:1, :18, :35, :55). `new Float32Array` :20
pure ranges: 6-16, 23-63
impure ranges: 19-21 (`packPresence` — the `Presence` struct, 5 f32 + 3 pad)
verdict: **split → domain: 6-16, 23-63 (proposal `<area>` = `presence/`); adapters/gpu: 19-21** — a 3-line adapter island mid-file, so the domain side is two blocks. Not function-interleaved.
test importers: 1 — `src/gpu/presence.test.ts` (which also imports `ops`, the only cross-pairing of the fifteen)
name-vs-content: The name is LrC's panel label and it over-promises. Header :4 states "The spatial texture/clarity part lives only in the shader", and :35 requires the constants to "MUST stay in sync with presence.wgsl (the shader can't import TS)". So 6-16 + 19-21 are the full uniform surface, 23-33 is the one term the CPU genuinely models, and 35-63 is a partial mirror of a term it cannot verify against the shader. Two of these five sliders (`texture`, `dehaze`) have no CPU model here at all — the neutral-default literal `ops.ts:211` and the packer are their only presence-side code.

---

### src/gpu/vignette.ts (60 lines)
exports: `VignetteParams` (interface) — amount/midpoint/roundness/feather/highlights; `isNeutralVignette` (function); `packVignette` (function) — uniform array incl. the crop rect; `smoothstep01` (function); `vignetteFactor` (function) — multiplicative falloff vs radius; `vignetteFactorProtected` (function) — with LrC highlights protection
imports: none
device-api hits: **none.** `vignette.wgsl` in comments only (:1, :21, :36). `new Float32Array` :26
pure ranges: 6-19, 29-60
impure ranges: 25-27 (`packVignette` — the `Vignette` struct, 5 f32 + crop rect 4 + 1 pad)
verdict: **split → domain: 6-19, 29-60 (proposal `<area>` = `vignette/`); adapters/gpu: 25-27** — 3-line adapter island mid-file. Not function-interleaved.
test importers: 1 — `src/gpu/vignette.test.ts`
name-vs-content: Accurate. Two coupling notes: (1) `packVignette`'s second parameter is the crop frame rect, supplied at `ops.ts:275` from `cropRegion(ops, imageSize[0], imageSize[1])` — so post-crop vignetting is a cross-module dependency between the `vignette` and `crop` domain areas, not a self-contained packer; (2) `roundness` is in the interface (:11) and the uniform (:26) but has **no CPU model** — `vignetteFactor` :37 says it ignores roundness and highlights.

---

### src/gpu/orient.ts (121 lines)
exports: `Orientation` (interface) — swap/flipY/flipX bits; `orientationFromFlip` (function) — LibRaw flip code → bits; `flippedDims` (function) — output dims under a flip; `mapOutputPoint` (function) — forward sensor→output texel map; `remapCfa6` (function) — 6×6 CFA pattern remap under flip
imports: none
device-api hits: **none.** No `GPUDevice`/`device.`/`writeBuffer`/`createBindGroup`/`createShaderModule`/`requestAdapter`/`document`/`window`/`indexedDB`/`navigator`/`fetch`. `unpack.wgsl` appears only in comments (:20, :52). `new Uint8Array(36)` :101 is a plain CPU array — the header :78-79 says explicitly "metadata: 36 tiny bytes -- CPU-legal, same standing as packCfa6/shiftCfa6"
pure ranges: 30-121 — the entire file below the header
impure ranges: **none**
verdict: **move → `domain/`** (proposal `<area>` = `orientation/`)
test importers: 1 — `src/gpu/orient.test.ts`
name-vs-content: The name is adequate but the file's *allegiance* is not what its location suggests. Lines 1-28 are a transcription of vendored LibRaw C++ with source citations (`src/metadata/tiff.cpp:631`, `src/metadata/identify.cpp:1287-1305`, `src/write/file_write.cpp:20-29`, `:224-226`, `:182-183`, `mem_image.cpp:220-230`) and it is also the CPU twin of the shader's scatter formula (:52-53 "the GPU normalize pass's scatter formula (unpack.wgsl keeps the identical line order)"). By §2.2's identifier rule it is unambiguously `domain`; by knowledge it encodes two adapter contracts (LibRaw's flip-code semantics and `unpack.wgsl`'s line order). **This contradicts the ADR row that bundles it as `split`** — there is no uniform packing in it. The owner needs to decide whether `domain/` may hold vendor-format knowledge.

---

## Summary

### 1. File → verdict → test-importer count (import-path churn size)

| File | Lines | Verdict | Test files importing it | Churn note |
|---|---|---|---|---|
| `src/gpu/ops.ts` | 336 | **split** (interleaved) | **2** | + `pipeline.ts`, `main.ts` |
| `src/gpu/grain.ts` | 175 | split | **3** | + `lightleak.ts`, `offscreenRenderer.ts`, `ops.ts`, `main.ts` |
| `src/gpu/bw.ts` | 147 | split | 2 | + `ops.ts`, `main.ts` |
| `src/gpu/crop.ts` | 293 | split (4 adapter lines) | 1 | + `pipeline.ts`, `ops.ts`, `main.ts` |
| `src/gpu/presence.ts` | 63 | split | 1 | presence.test.ts also imports `ops` |
| `src/gpu/orient.ts` | 121 | **move → domain** | 1 | + `pipeline.ts`, `main.ts` |
| `src/gpu/film.ts` | 246 | **move → domain** | 1 | + 5 non-test importers incl. `catalog/editsStore.ts` |
| `src/gpu/lightleak.ts` | 130 | split | 1 | |
| `src/gpu/frame.ts` | 69 | split | 1 | only `ops.ts` (non-test) |
| `src/gpu/geometry.ts` | 76 | split | 1 | |
| `src/gpu/vignette.ts` | 60 | split | 1 | |
| `src/catalog/culling.ts` | 45 | split (interleaved) | 1 | |
| `src/catalog/iptc.ts` | 271 | split | 1 | |
| `src/catalog/keywords.ts` | 500 | **split (clean 2-block)** | 1 | |
| `src/catalog/thumbnails.ts` | 282 | **split (4 destinations)** | 1 | imports `../raw/thumbnail`, `./permissions`, `./editsStore`, `./import`, `./editHistory` |

Distinct `*.test.ts` files touched by a move of any of these fifteen: **17** of the 47 (`culling`, `iptc`, `keywords`, `thumbnails`, `crop`, `ops`, `presence`, `grain`, `lightleak`, `film`, `bw`, `frame`, `geometry`, `vignette`, `orient` — each its own, plus `ops.test.ts` and `presence.test.ts` and `lightleak.test.ts` and `bw.test.ts` cross-importing `ops`/`grain`). Total import edges to rewrite: **18**.

### 2. Interleaved files (the expensive ones)

Ranked by split cost:

1. **`src/gpu/ops.ts` — 14 functions, all of them.** Every `packParams` closure mixes the domain rule (which op to find, what the neutral default is when absent, which conversion applies) with adapter work (uniform-format `Float32Array`, module-level per-file state reads). Named closures: :110 `whiteBalance`, :128 `profile`, :138 `exposure`, :153 `tone`, :178 `bw`, :191 `toneCurve`, :209 `presence`, :223 `geometry`, :242 `lightleak`, :257 `crop`, :272 `vignette`, :289 `dodgeBurn`, :303 `grain`, :317 `frame`. Compounding factors: the `OpRenderer` object literal (:93-98) carries `shader` and `uniformSize` in the same record as `packParams`, so it cannot be partitioned by line range; `imageSize` (:79), `asShotGains` (:70), `cameraColorMatrix` (:37) are module-level mutable state read *inside* the closures (:120, :130, :260, :275, :316); `lightleak` :245 and `grain` :306 reach across op boundaries into `getGrainSeed()`. **Splitting this file correctly requires changing `OpRenderer`'s shape, not just moving lines.**
2. **`src/catalog/thumbnails.ts`** — `getThumbnailBlob` :205-217 and `needsEditedThumbnail` :181-194 interleave the freshness *decision* with awaited IDB reads inside one `try`. Not math-vs-buffer, but app-vs-adapter interleaving; the domain pieces were already extracted (`opDigest` 70-121, `developedRenderNeeded` 169-177), so what remains is an `app` body that inlines I/O and has no `app/` target in the ADR row.
3. **`src/catalog/culling.ts`** — `setCull` :8-33: the domain normalisation (`merged.rating === 0 → delete`, `color === 0 → delete`, :22-26) sits inside the `request.onsuccess` callback (:16-30), between `store.get`'s result read and `store.put`. Cheap to extract (5 contiguous lines) but not a line-range split.

Not interleaved but **non-contiguous** (a `pack` island of 3-12 lines inside an otherwise-domain file → domain lands in two blocks): `grain.ts` (:66-69, plus state :41-53), `lightleak.ts` (:37-45), `frame.ts` (:52-54, contested :45-47), `presence.ts` (:19-21), `vignette.ts` (:25-27), `crop.ts` (:251-254 — end-of-file, single block), `bw.ts` (:140-147 — end-of-file, single block), `geometry.ts` (:65-76 — end-of-file, single block). The last three are the cheapest possible split.

Clean two-block, no interleaving at all: **`keywords.ts`** (19-267 pure / 269-500 IDB, boundary exactly at its own `// ---- IndexedDB layer ----` header :269) and **`iptc.ts`** (except `mergeIptc` :189-196 is pure code filed under the IDB header at :119 — a section-comment error, not a function-level mix).

### 3. Files whose NAME misled about contents

- **`src/gpu/ops.ts`** — the worst. Contains no op vocabulary: the `Op` union and all 15 `isXOp` guards live in `../catalog/types` (imported :17). Real contents = the GPU render-pass registry (14 `.wgsl?raw` sources + per-struct byte sizes) **plus a module-level mutable cache of the loaded file's camera matrices / As-Shot gains / image size** (:37, :56, :70, :79). The name implies `domain/`; the content is `adapters/gpu`.
- **`src/gpu/lightleak.ts`** — the ADR flags it as the vocabulary root, but it holds **no pattern names**, only a numeric `pattern: number` documented in comments (:26, :39). The strings "Set A"/"Set B" are built in `src/main.ts:1303`; the same numeric contract is restated at `src/catalog/types.ts:127`. Its 80 lines of "model" are, per its own header, an approximation of twelve textures the CPU cannot sample (:14-17).
- **`src/catalog/thumbnails.ts`** — reads as one IDB adapter; also owns the pipeline-wide cache-invalidation rule (`opDigest`/`RENDER_DIGEST_VERSION`, 68-121), two app-shaped orchestrators (:181-194, :205-217), a browser rasteriser (:261-282), and FS/Raw calls (:229-243).
- **`src/gpu/frame.ts`** — 69 lines that name the effect; the effect lives in three vendored PNGs in `public/frames/` (:32-39), and the file is border fractions + a style→WGSL-layer-id map. The ADR §3 has no row for `public/*`.
- **`src/gpu/geometry.ts`** — name collides with the ADR's existing `domain/geometry/` (claimed twice in §3.1 by `app/navigator.ts` and `app/viewState.ts`, both *viewport* geometry). This file is LrC's **Transform** op.
- **`src/gpu/presence.ts`** — implies a complete CPU model; header :4 says the spatial half "lives only in the shader", and `texture`/`dehaze` have no CPU representation anywhere in it.
- **`src/gpu/crop.ts`** — contents match the name, but `cropHandleAt`/`dragCropRect`/`cropOverlayRect`/`CropOverlayRect` will land in `domain/` under overlay/DOM-sounding names; their own comments call them DOM-side (:87, :272).
- **`src/catalog/iptc.ts`** — half the file is a generic named-preset store (`MetadataPreset` 40-44, `METADATA_PRESET_STORE` :46, CRUD 219-271), not IPTC.

Accurate names: `culling.ts`, `keywords.ts`, `grain.ts`, `film.ts`, `bw.ts`, `orient.ts`, `vignette.ts`.

### 4. ADR §3 rows the evidence contradicts

**(a) §3.3 grouped row — `film.ts` and `orient.ts` are `move`, not `split`.**
> ADR: `grain.ts film.ts bw.ts lightleak.ts frame.ts geometry.ts presence.ts vignette.ts orient.ts | 1,090 รวม | แต่ละไฟล์: vocabulary/defaults/clamp → `domain/<area>/`; uniform packing → `adapters/gpu/` | **split (verify รายไฟล์)**`

Evidence: each of the nine "แต่ละไฟล์ … uniform packing" has **no** uniform packing — `film.ts` exports `PORTRA_400`…`FILM_STOCKS` and `isFilmStockId`; `orient.ts` exports `orientationFromFlip`, `flippedDims`, `mapOutputPoint`, `remapCfa6`. Neither file contains a `pack*` function, a `Float32Array`/`Uint8Array` uniform layout, `.wgsl`, or any §2.2-forbidden identifier. Both should be `move → domain/` whole. ("uniform packing" holds for the other seven.)

**(b) Same row's line count.** Actual sum of the nine files = **1,087** (175+246+147+130+69+76+63+60+121), not 1,090.

**(c) §3.2 `culling.ts` — the adapter condition in the row is already true, and the domain payload is smaller than the row implies.**
> ADR: `culling.ts | 44 | domain/culling/ + adapter ถ้ามีการเขียน IDB | **verify ก่อน**`

Evidence: IDB writing is the file's majority — `db.transaction('files','readwrite')` :14, `store.get` :15, `store.put` :27, `IDBDatabase` :9. `domain/culling/` receives only :22-26 (5 lines) plus `applyCullResult` :40-45. Also 44 → 45 lines (no trailing newline).

**(d) §3.2 `thumbnails.ts` — two destinations named, four needed, and one layer missing.**
> ADR: `thumbnails.ts | 282 | adapters/idb (+ scheduling rules ออก domain/ ถ้ามี) | **split (verify)**`

Evidence: `if มี` resolves to **yes and more than scheduling** — `opDigest` :70-121 and `developedRenderNeeded` :169-177 are pure domain rules. Beyond IDB, the file calls File System Access (`record.handle.getFile()` :234), LibRaw (`extractThumbnail` :241 via `../raw/thumbnail` :2), and browser imaging (`createImageBitmap` :265, `new OffscreenCanvas` :272, `convertToBlob` :281) — `adapters/idb` is the wrong home for 261-282. And `getThumbnailBlob`/`needsEditedThumbnail` (:181-217) are `app`-layer orchestration with no target in the row.

**(e) §3.3 `ops.ts` — the `domain/ops/` half does not exist to harvest.**
> ADR: `ops.ts | 336 | domain/ops/ (op → param mapping) + adapters/gpu/ (buffer layout) | **split (verify)**`

Evidence: the op→kind discrimination is imported, not defined here — 15 `isXOp` guards + `Op` from `../catalog/types` (:17). What ops.ts actually contributes is: buffer layout (:96, :109, :127, :137, :152, :177, :190, :208, :222, :241, :256, :271, :288, :302, :316), the 14 `.wgsl?raw` sources (:1-14), mutable per-file state (:37, :56, :70, :79), nine inline neutral-default literals (:155, :180, :211, :225, :244, :259, :274, :291, :305) and one genuinely domain rule (`MANDATORY_KINDS` + `presentOpIndices` :331-336). So `domain/ops/` should be `domain/` defaults + the pass-order rule; the file is ~95% `adapters/gpu` — and the split is inside functions, not between ranges.

**(f) §3.2 `iptc.ts` — split confirmed, but the domain half is not all "iptc".**
> ADR: `iptc.ts | 271 | domain/iptc/ + adapter | **split (verify)**`

Evidence supports `split`; the correction is that `MetadataPreset` (:40-44), `METADATA_PRESET_STORE` (:46), `isValidPresetRow` (:113-117) and the preset CRUD (:219-271) are preset-store vocabulary/lifecycle, not IPTC, and `mergeIptc` (:189-196) is pure code sitting under the IDB section header (:119) where a header-guided read of the file would classify it as adapter.

**(g) §3.3 grouped row — `lightleak.ts` as the "vocabulary root".**
> ADR: `← lightleak.ts คือ U1 (vocabulary ที่เป็นรากของ R1-1/R1-22)`

Evidence: the vocabulary it means (`pattern` set names) is **not in `lightleak.ts`** — see §3 of this report. What is there is `LIGHTLEAK_DEFAULTS` :29 and `packLightleak`'s double-encoding of the pattern as `mode`+`sel` (:42-43). A correction to this row is what determines whether U1's target file is `domain/` or `main.ts`.

### 5. Total lines: `move` vs `split`

- **`move` (whole file, one layer): 2 files, 367 lines** — `film.ts` 246 + `orient.ts` 121, both → `domain/`.
- **`split` (two or more layers): 13 files, 2,447 lines** — culling 45, iptc 271, keywords 500, thumbnails 282, crop 293, ops 336, grain 175, bw 147, lightleak 130, frame 69, geometry 76, presence 63, vignette 60.
- **Total surveyed: 2,814 lines** (`wc -l` over the fifteen = 2,813; the 1-line delta is `culling.ts`'s missing trailing newline).

Within the `split` total, the adapter side is small enough that the label overstates the work for 8 of them: the eight `src/gpu/` pack functions total **54 lines** of 1,388 (crop 4, bw 8, geometry 12, grain 4, lightleak 9, frame 3, presence 3, vignette 3). Only `ops.ts` (336) and the catalog IDB files (culling 26, iptc 116, keywords 232, thumbnails ~215) carry real adapter mass.

---

noticed, not acted on: `src/catalog/iptc.ts:14-20` states a required `db.ts` v6 upgrade for the `metadataPresets` store is still a parent action (the store does not exist yet, so `listMetadataPresets` returns `[]` by the tolerance at :220) — a layering question for `adapters/idb`/`db.ts`, not part of this survey; separately, `grain.ts:165-175`, `lightleak.ts:120-130` and `vignette.ts:29-31` each carry their own copy of `mix01`/`smoothstep01`/`clamp01`, and `ops.ts:225`/`:274`/`:211`/`:291` are the sole home of the geometry/vignette/presence/dodgeBurn neutral defaults (no `*_DEFAULTS` export exists for those four), so moving the four files' vocabulary to `domain/<area>/` without also lifting those literals creates four areas whose defaults live in the adapter.