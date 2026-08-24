# Design: LrC-style app shell (Library / Develop modules)

Date: 2026-08-24 · Status: awaiting user review · Mockup: `2026-08-24-lrc-shell-mockup.html`

## Context

Spike passed. Catalog foundation (IndexedDB, folder import, edit history) and the
virtualized thumbnail grid (Tasks 1–8) are done and verified. The product goal is
now: **replace Lightroom Classic** for enthusiasts and semi-pros — clone its basic
functions, layout/UX, and workflow.

That goal spans multiple independent subsystems. This spec covers **the first
sub-project only**: the app shell and LrC-like module layout. Everything else
(culling tools, tone curve, export, presets) hangs off this shell and gets its own
spec later.

## Goal

An app shell that reproduces LrC's core layout and module workflow:

- Top module picker: **Library | Develop**
- **Library module** — folders (left), virtualized grid (center), metadata (right), filmstrip (bottom)
- **Develop module** — history + undo/redo (left), WebGPU loupe (center), Basic panel with Exposure/WB (right), filmstrip (bottom)
- One shared filmstrip; selection stays in sync across grid, filmstrip, and loupe
- Shortcuts: `G` grid, `E` loupe, `←/→` navigate, `Ctrl+Z` undo
- Switching modules preserves the selected file and its edits

## Non-goals (deferred, each gets its own spec)

- Flags/ratings/color labels and culling shortcuts (`P`/`X`/`U`)
- Histogram, tone curve, HSL, further Develop panels
- Export, presets, DCP profiles, metadata editing
- Any new UI framework or dependency

## Approach

**A. CSS grid shell + thin module registry (chosen).** Restructure `index.html`
into topbar / left / content / right / filmstrip regions; a plain-object module
registry in TypeScript shows/hides module roots. No framework, no new deps,
matches the existing vanilla-DOM codebase. Modules later (Map, Export) are just
new registry entries.

Rejected:

- **B. Custom elements per region** — better encapsulation, but boilerplate-heavy
  and the WebGPU canvas + virtualizer integration gets awkward for no near-term payoff.
- **C. Svelte/Preact** — violates the project constraint "no UI framework"; a
  rewrite tax for features this spike doesn't need.

## Architecture

### Module registry (`src/app/modules.ts`)

```ts
interface Module {
  id: 'library' | 'develop';
  root: HTMLElement;
  onShow(): void;   // e.g. Develop: kick decode of selected file
  onHide(): void;
}
const modules: Record<ModuleId, Module>;
function switchModule(id: ModuleId): void;
```

Plain object, no class hierarchy. Switching hides the old root, shows the new
one, calls hooks, then re-runs layout (canvas fit, filmstrip scroll-into-view).

### Layout (CSS grid in `index.html`)

```
grid-template-columns: 220px 1fr 260px
grid-template-rows: auto 1fr 84px
+---------------------------------------------------+
| topbar: [Library|Develop]  ...  brand             |
+---------+-----------------------------+-----------+
| left    | content                     | right     |
| panel   | grid (Library) / loupe      | panel     |
|         | (Develop)                   |           |
+---------+-----------------------------+-----------+
| filmstrip (shared, both modules)                  |
+---------------------------------------------------+
```

Panels swap their inner content per module (same region element, different
children). The filmstrip is a single shared element outside module roots.

### State (`src/app/state.ts`)

`{ module: ModuleId; selectedId: string | null }` with one mutation path,
`selectFile(id)`, so grid, filmstrip, and loupe can never disagree. Edit ops keep
flowing through `commitEdit`/`editHistory` exactly as today.

### Filmstrip (`src/app/filmstrip.ts`)

Same thumbnail plumbing as the grid (`getOrExtractThumbnail`), horizontal strip,
windowed render (~3 screens of cells, absolutely positioned — same pattern as the
grid, rotated axis). Scrolls the selected cell into view on selection change;
clicking a cell calls `selectFile`.

### Develop loupe

Reuses the existing canvas + pipeline unchanged. On `onShow`/selection change it
decodes the selected file (already shared-WASM per commit `c036466`) and renders
fit-to-window. Selecting an already-decoded file is a no-op.

### Panels

- Library left: folder list (existing `listFolders`), click filters the grid (existing path)
- Library right: metadata readout only (filename, dimensions, capture date from the catalog)
- Develop left: edit-history list from `currentOps` + undo/redo buttons (both exist)
- Develop right: Basic panel — Exposure and White Balance sliders, restyled into panel form

### Keyboard (`src/app/shortcuts.ts`)

`G`/`E` switch modules, `←/→` move selection, `Ctrl+Z` undo. Ignored when focus
is in an `<input>` or slider so slider arrows still work.

### Error handling

Unchanged: decode failure on selection shows the existing error banner and keeps
the previous image on screen; the file stays selectable for retry.

## Testing

- **vitest** (pure logic, same style as existing tests):
  - module registry: switch calls `onHide`/`onShow`, unknown id is a no-op
  - state: `selectFile` sets id, notifies subscribers once per change
  - shortcuts: key mapping table, input-focus guard
- **Manual checklist** (Task 8 pattern, recorded in a follow-up commit):
  - both modules render per the mockup; switching preserves selection and edits
  - grid ↔ filmstrip ↔ loupe selection sync all three ways
  - arrow keys walk the folder; `G`/`E` toggle modules
  - cycling 10 files with slider edits: no crash, memory stable

## Files

- `index.html` — restructure into the five regions + panel/filmstrip styles
- `src/app/modules.ts`, `src/app/state.ts`, `src/app/filmstrip.ts`, `src/app/shortcuts.ts` — new
- `src/main.ts` — bootstrap: registry setup, topbar wiring, region query; sheds
  grid/loupe/filmstrip code into the modules above (it has grown past one purpose)
- No changes to `src/gpu`, `src/raw`, `src/catalog`, `src/shaders`

## Out of scope for this spec

`native/libraw-wrapper/wrapper.cpp` carries an uncommitted diagnostic
(`[DBG-a4f2]`, raw_pitch vs width×2). It predates this design and is not part of
it; it stays uncommitted until investigated separately.
