# Candela — Production Roadmap

**Goal:** Make Candela a complete, daily-driver raw photo editor for enthusiasts and semi-pros with large catalogs.

**Current state (post-spike):**
- WebGPU pipeline proven fast enough (<50ms slider response)
- Core develop tools: WB, tone, presence, curve, effects, crop, geometry, dodge & burn, B&W, film stocks
- Library module: folder-based catalog, culling (rating/flag/color), metadata, virtualized grid
- History, presets, export, keyboard shortcuts
- 63 source files, 25 test files

**Target user:** Enthusiasts/semi-pros with 10k+ raw files, looking for a Lightroom alternative without subscription.

---

## Phase 1: Core Workflow (Critical — blocks daily use)

**Duration:** 2-3 weeks  
**Goal:** Make the develop loop fast and fluid

### 1.1 Zoom & Pan in Develop Module
**Problem:** Can't check focus/sharpness without crop overlay  
**Solution:**
- Mouse wheel → zoom (centered on cursor)
- Middle-click drag → pan
- Keyboard: `Z` = toggle zoom (Fit → 100% → 200% → Fit)
- Touchpad pinch → zoom (trackpad gesture API)
- Zoom indicator in top-right corner

**Implementation:**
- Add `viewState: { zoom: number, panX: number, panY: number }` to develop state
- Canvas click handler: track pointer position, apply inverse transform to hit-test
- Render pipeline: pass zoom/pan as uniforms, adjust vertex shader sampling
- Cursor: change to grab/grabbing when panning

**Files to modify:**
- `src/main.ts` — wheel/pointer handlers on canvas
- `src/gpu/pipeline.ts` — zoom/pan uniforms
- `src/gpu/ops.ts` — view transform in render chain
- `index.html` — zoom indicator UI

**Tests:**
- Zoom preserves cursor position
- Pan bounded by image edges
- Zoom state persists across file switches

### 1.2 Copy/Paste Settings
**Problem:** Sync is batch-only; need single-photo copy/paste for develop workflow  
**Solution:**
- `Ctrl+Shift+C` → copy current ops to clipboard (JSON)
- `Ctrl+Shift+V` → paste ops to selected photo(s)
- `Ctrl+Alt+V` → paste only selected adjustments (dialog with checkboxes)

**Implementation:**
- Clipboard API: `navigator.clipboard.writeText(JSON.stringify(ops))`
- Extend `keyToAction` with `copy`/`paste` actions
- Paste applies as new history entry (non-destructive)

**Files to modify:**
- `src/app/shortcuts.ts` — add copy/paste actions
- `src/main.ts` — clipboard handlers
- `src/catalog/editHistory.ts` — paste validation

**Tests:**
- Copy/paste preserves all ops
- Paste onto multiple photos applies to all
- Invalid clipboard JSON → error toast

### 1.3 Before/After Hold-to-Peek
**Problem:** Help dialog promises `\` hold-to-peek; need to verify it works  
**Solution:**
- Hold `\` → show original (pre-edit) state
- Release → return to edited state
- Button toggle also works (already implemented)

**Implementation:**
- `keydown` on `\` → set `showOriginal = true`, re-render with neutral ops
- `keyup` → set `showOriginal = false`, re-render with current ops
- Debounce: ignore if held <100ms (prevents flicker)

**Files to modify:**
- `src/main.ts` — keydown/keyup handlers

**Tests:**
- Hold `\` shows original
- Release restores edits
- Works in Develop module only

### 1.4 Zoom Presets
**Problem:** No way to jump to 100% or fit-to-screen  
**Solution:**
- Toolbar buttons: Fit | Fill | 1:1 | 2:1
- Keyboard: `F` = Fit, `Shift+F` = Fill, `1` = 100%, `2` = 200%
- Double-click canvas → 100% at cursor

**Implementation:**
- `setView(mode: 'fit' | 'fill' | 'percent', percent?: number)`
- Fit: zoom = min(canvasW/imgW, canvasH/imgH)
- Fill: zoom = max(canvasW/imgW, canvasH/imgH)
- 1:1: zoom = 1, pan = (0,0)

**Files to modify:**
- `src/main.ts` — toolbar + keyboard handlers
- `index.html` — zoom preset buttons

### 1.5 Auto-Advance After Rating
**Problem:** Culling requires manual arrow-key advance  
**Solution:**
- Toggle in Library footer: "Auto-advance after rating"
- When enabled: rating key (1-5, P, X) → rate current → select next

**Implementation:**
- Add `autoAdvance: boolean` to app state
- After rating action: if `autoAdvance && nextFile`, call `openFile(nextFile)`
- Persist preference in localStorage

**Files to modify:**
- `src/main.ts` — rating handler, auto-advance logic
- `index.html` — checkbox in footer

---

## Phase 2: Catalog & Organization (Important — expected by target audience)

**Duration:** 3-4 weeks  
**Goal:** Manage 50k+ photos efficiently

### 2.1 Collections & Smart Collections
**Problem:** Folder-only organization is too rigid  
**Solution:**
- Collections: virtual groupings (saved searches, manual picks)
- Smart Collections: auto-updating based on criteria (rating ≥ 4, camera = X100V, date > 2024)
- Sidebar: Folders | Collections | Smart Collections

**Implementation:**
- New DB tables: `collections`, `collection_files`, `smart_collections`
- Collection: `{ id, name, fileIds[] }`
- Smart collection: `{ id, name, criteria: { rating?, camera?, dateRange?, ... } }`
- Query: rebuild smart collection on catalog change

**Files to add:**
- `src/catalog/collections.ts` — CRUD
- `src/catalog/smartCollections.ts` — criteria engine
- `src/app/collectionsPanel.ts` — sidebar UI

**Tests:**
- Collection add/remove files
- Smart collection updates on rating change
- Criteria OR/AND logic

### 2.2 Advanced Search & Filters
**Problem:** Can't find photos by filename, camera, lens, date  
**Solution:**
- Search bar in Library: text search (filename, EXIF)
- Filter panel: camera model, lens, ISO range, date range, focal length
- Combine filters: "X100V, ISO 400-1600, last 3 months"

**Implementation:**
- Search: SQL LIKE on `filename`, `camera_model`, `lens_model`
- Filters: extend `listFiles` with criteria object
- UI: collapsible filter panel below folder list

**Files to modify:**
- `src/catalog/query.ts` — extend `listFiles` with filters
- `src/main.ts` — search bar + filter panel
- `index.html` — filter UI

### 2.3 Drag & Drop Folder Import
**Problem:** Button picker is slow for frequent imports  
**Solution:**
- Drag folder onto Library → import
- Drag individual files → add to current folder
- Drop zone overlay during drag

**Implementation:**
- `dragover`/`drop` handlers on Library module
- `DataTransferItem.getAsFileSystemHandle()` for folder
- File drop: `importFiles(handles[])`

**Files to modify:**
- `src/main.ts` — drag/drop handlers
- `src/catalog/import.ts` — `importFiles` function

### 2.4 Fullscreen Mode
**Problem:** No immersive editing experience  
**Solution:**
- `F11` or `F` → toggle fullscreen
- Hide topbar/filmstrip in fullscreen
- `Esc` → exit fullscreen

**Implementation:**
- `document.documentElement.requestFullscreen()`
- `fullscreenchange` event → toggle UI visibility

**Files to modify:**
- `src/main.ts` — fullscreen toggle
- `src/app/shortcuts.ts` — `F` key action

### 2.5 Second Monitor Support
**Problem:** Dual-display workflow (loupe on main, controls on secondary)  
**Solution:**
- "Move to Secondary Display" button
- Opens controls in separate window
- Main window: full-screen loupe only

**Implementation:**
- `window.open('controls.html', 'controls', 'width=400,height=800')`
- PostMessage API: sync state between windows
- Controls window: sliders, history, presets
- Main window: canvas only

**Files to add:**
- `controls.html` — controls-only UI
- `src/app/secondMonitor.ts` — PostMessage sync

---

## Phase 3: Quality of Life (Nice-to-have — improves daily use)

**Duration:** 2-3 weeks  
**Goal:** Polish and power-user features

### 3.1 Loupe Info Overlay
**Problem:** Can't see EXIF while editing  
**Solution:**
- Hover top-left corner → show overlay: filename, camera, lens, ISO, shutter, aperture
- Auto-hide after 3s

**Implementation:**
- `pointermove` on canvas: if cursor in top-left 100x100px, show overlay
- Overlay: absolute-positioned div with EXIF data

**Files to modify:**
- `src/main.ts` — overlay logic
- `index.html` — overlay element

### 3.2 Compare View
**Problem:** Can't compare two photos side-by-side  
**Solution:**
- Select 2-4 photos → `Ctrl+M` → Compare view
- Grid: 2x2 (or 1x2, 1x3, 1x4)
- Click any photo → open in Develop

**Implementation:**
- New module: `module-compare`
- Render: multiple canvases, each with own pipeline
- Keyboard: `Tab` → cycle focus

**Files to add:**
- `src/app/compareModule.ts` — compare view logic
- `index.html` — compare module HTML

### 3.3 Batch Export with Progress
**Problem:** Export is one-at-a-time, no progress feedback  
**Solution:**
- Select multiple photos → Export → batch export
- Progress bar: "Exporting 12/48..."
- Cancel button
- Export to folder (File System Access API)

**Implementation:**
- `showDirectoryPicker()` for output folder
- Queue: process exports sequentially
- Progress: update UI after each file

**Files to modify:**
- `src/main.ts` — batch export logic
- `src/gpu/exportEncode.ts` — export queue

### 3.4 Tethered Capture
**Problem:** No auto-import from camera  
**Solution:**
- "Tethered Capture" button → watch camera folder
- New photo detected → auto-import, open in Develop
- Sound notification on import

**Implementation:**
- `FileSystemWatcher` API (Chrome 125+)
- Poll every 2s if watcher unavailable
- Play sound: `new Audio('import.wav').play()`

**Files to add:**
- `src/app/tetheredCapture.ts` — folder watcher

### 3.5 Print Module
**Problem:** No print layout  
**Solution:**
- Print module: single photo, contact sheet, or custom grid
- Page setup: A4, Letter, 4x6, 5x7
- Margins, DPI, sharpening for print

**Implementation:**
- `window.print()` with print-specific CSS
- Render: canvas → high-res PNG → `<img>` in print layout

**Files to add:**
- `src/app/printModule.ts` — print layout
- `print.html` — print-specific page

---

## Phase 4: Robustness & Performance (Technical debt)

**Duration:** Ongoing  
**Goal:** Handle edge cases, large catalogs, production use

### 4.1 WebGPU Device Loss Handling
**Problem:** Device loss → app breaks  
**Solution:**
- `device.lost.then()` → show error, attempt recovery
- Recovery: re-create device, re-upload textures

**Implementation:**
- `pipeline.ts`: `device.lost.then(async (info) => { ... })`
- Show toast: "GPU device lost. Attempting recovery..."
- Re-init: `await Pipeline.create(canvas)`

**Files to modify:**
- `src/gpu/pipeline.ts` — device loss handler

### 4.2 Large Catalog Performance
**Problem:** 50k+ photos → slow grid rebuild  
**Solution:**
- Virtualization already in place (verify with 50k mock catalog)
- Thumbnail cache: persist to IndexedDB (not just memory)
- Lazy-load metadata: only decode EXIF for visible photos

**Implementation:**
- Benchmark: create 50k mock files, measure grid rebuild time
- Thumbnail cache: `thumbnailsStore.ts` → IndexedDB
- Metadata: defer `extractThumbnail` until scroll-into-view

**Files to modify:**
- `src/catalog/thumbnails.ts` — IndexedDB persistence
- `src/main.ts` — lazy metadata loading

### 4.3 Edit State Backup
**Problem:** Crash → lose unsaved edits  
**Solution:**
- Auto-save edits every 30s
- Backup file: `.candela-backup` in catalog folder
- On startup: detect backup → offer restore

**Implementation:**
- `setInterval(() => saveAllEdits(), 30_000)`
- Backup: JSON dump of all edit states
- Restore: compare timestamps, prompt user

**Files to add:**
- `src/catalog/backup.ts` — auto-save + restore

### 4.4 Performance Profiling
**Problem:** Unknown bottlenecks on real hardware  
**Solution:**
- Add performance marks: decode time, upload time, render time
- Dev mode: show FPS counter, GPU memory usage
- Profile 60MP images on M1 Mac, Intel i7, integrated GPU

**Implementation:**
- `performance.mark()` around decode/upload/render
- Dev overlay: `requestAnimationFrame` → FPS counter
- `performance.measure()` → log to console

**Files to modify:**
- `src/main.ts` — performance marks
- `src/gpu/pipeline.ts` — timing hooks

---

## Phase 5: Advanced Features (Future — if product-market fit confirmed)

**Duration:** TBD  
**Goal:** Differentiate from Lightroom/darktable

### 5.1 AI-Assisted Culling
- Auto-rate: detect blur, exposure, composition
- Smart picks: "best 10% of this shoot"
- Face detection: group by person

### 5.2 Plugin System
- User scripts: custom export presets, batch operations
- Sandboxed: Web Workers + limited API
- Marketplace: share plugins

### 5.3 Cloud Sync (Optional)
- Opt-in: sync catalog + previews to cloud
- Multi-device: edit on laptop, review on tablet
- End-to-end encryption

### 5.4 Video Support
- Open RAW video (CinemaDNG, BRAW)
- Frame-by-frame navigation
- Basic color grading

---

## Success Criteria

**Phase 1 (Core Workflow):**
- Zoom/pan works smoothly on 60MP images
- Copy/paste settings tested with 3 users
- Before/after peek matches Lightroom behavior

**Phase 2 (Catalog):**
- 50k photo catalog loads in <5s
- Collections/smart collections used in real workflow
- Drag/drop import tested on macOS + Windows

**Phase 3 (Quality of Life):**
- Compare view used for culling sessions
- Batch export handles 100+ photos without crash
- Tethered capture tested with Canon + Fuji cameras

**Phase 4 (Robustness):**
- No data loss after 100 crash simulations
- 60MP images render at 30+ FPS on integrated GPU
- Edit state survives browser restart

---

## Technical Debt & Refactoring

**Current pain points:**
- `main.ts` is 2951 lines → split into modules (develop, library, contact)
- Global state → migrate to reactive store (Zustand or custom)
- Shader chain hardcoded → composable op graph (for undo/history)

**Refactoring plan:**
1. Extract `src/app/developModule.ts` from main.ts
2. Extract `src/app/libraryModule.ts` from main.ts
3. Introduce reactive state: `src/app/store.ts`
4. Composable op graph: `src/gpu/opGraph.ts`

---

## Prioritization

**Must-have for launch:**
- Phase 1 (Core Workflow) — blocks daily use
- Phase 2.1-2.3 (Collections, Search, Drag/Drop) — expected by target audience
- Phase 4.1 (Device Loss) — production requirement

**Should-have for competitiveness:**
- Phase 2.4-2.5 (Fullscreen, Second Monitor) — power-user features
- Phase 3.1-3.3 (Info Overlay, Compare, Batch Export) — quality of life
- Phase 4.2-4.3 (Performance, Backup) — robustness

**Nice-to-have for differentiation:**
- Phase 3.4-3.5 (Tethered, Print) — niche workflows
- Phase 5 (AI, Plugins, Cloud) — future growth

---

## Timeline

**Weeks 1-3:** Phase 1 (Core Workflow)  
**Weeks 4-7:** Phase 2 (Catalog & Organization)  
**Weeks 8-10:** Phase 3 (Quality of Life)  
**Weeks 11+:** Phase 4 (Robustness) — ongoing  
**TBD:** Phase 5 (Advanced Features) — after product-market fit

**Total to "production-ready":** 10-12 weeks (2.5-3 months)

---

## Open Questions

1. **Pricing model:** One-time purchase? Subscription? Freemium?
2. **Platform support:** Web-only? Desktop app (Electron/Tauri)? Mobile?
3. **Camera support:** Which RAW formats? (CR3, ARW, NEF, RAF, DNG?)
4. **Distribution:** Self-hosted? Marketplace? Enterprise?
5. **Support:** Community forum? Paid support? Documentation?

---

## Next Steps

1. **Validate roadmap:** Share with target users, get feedback
2. **Start Phase 1:** Zoom/pan is the biggest blocker
3. **Set up analytics:** Track feature usage, crash reports
4. **Beta program:** Recruit 10-20 testers for Phase 1 completion
5. **Marketing:** Landing page, demo video, social media

---

**Document version:** 1.0  
**Last updated:** 2026-09-14  
**Owner:** [Your name]
