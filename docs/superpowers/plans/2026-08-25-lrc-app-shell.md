# LrC App Shell (Library / Develop modules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the app into a Lightroom-Classic-style shell — top module picker (Library | Develop), five-region layout (topbar / left / content / right / filmstrip), a shared synced-selection filmstrip, and shortcuts `G`/`E`/`←/→`/`Ctrl+Z` — per spec `docs/superpowers/specs/2026-08-24-lrc-app-shell-design.md`.

**Architecture:** CSS grid shell in `index.html` (columns `220px 1fr 260px`, rows `auto 1fr 84px`) with two `.module` sections (Library, Develop) that swap into the middle row; a thin plain-object module registry (`src/app/modules.ts`) shows/hides sections and calls `onShow`/`onHide`; a small observable state (`src/app/state.ts`) holds `{ module, selectedId }` with one mutation path `selectFile(id)` so grid, filmstrip, and loupe can never disagree. The filmstrip is a new horizontal windowed strip (same `@tanstack/virtual-core` pattern as the grid, rotated axis) sharing the thumbnail cache and the `openFile` decode path. The loupe reuses the existing canvas + pipeline unchanged.

**Tech Stack:** TypeScript, vanilla DOM, CSS grid, WGSL shaders untouched, `@tanstack/virtual-core` (already installed), vitest (already installed).

---

## Deviations from the spec (deliberate, called out up front)

1. **`selectedId` is `number | null`, not `string | null`.** Catalog ids are `number` (`FileRecord.id`); the spec's `string` was a loose early draft. The state shape `{ module, selectedId }` is unchanged.
2. **The grid stays in `main.ts`.** The spec said main.ts "sheds grid/loupe/filmstrip code into the modules"; the grid is tightly coupled to `openFile` + the thumbnail cache that live in main.ts, and extracting it adds a callback tangle for no near-term gain (per spec's own ponytail/YAGNI stance). The genuinely separable new pieces — state, registry, shortcuts, filmstrip — get their own files. Revisit when modules grow.
3. **Folder filter is main.ts-local state.** The spec's state covers `{ module, selectedId }` only; the Library folder click filter (`folderFilter: number | null`) lives in main.ts and rebuilds the grid. It's one scalar; promoting it to shared state is deferred until a second consumer exists.
4. **Develop `onShow` re-renders from existing GPU textures.** The canvas sits inside a `display:none` section while Library is active; the WebGPU drawing buffer's contents are undefined after the surface is hidden/re-shown, so `onShow` re-dispatches `pipeline.render` with the current ops (cheap — no decode, textures already uploaded).

---

## Task 1: App state (`src/app/state.ts`)

**Files:**
- Create: `src/app/state.ts`
- Test: `src/app/state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getState, subscribe, selectFile, setModule, type AppState } from './state';

describe('app state', () => {
  beforeEach(() => {
    setModule('library');
  });

  // Runs first in file order: the module singleton initializes to library
  // with no selection. No later test asserts the pristine initial state
  // again, so reordering past this one is safe.
  it('starts in library with no selection', () => {
    expect(getState()).toEqual({ module: 'library', selectedId: null });
  });

  it('selectFile sets the id and notifies exactly once', () => {
    const seen: AppState[] = [];
    subscribe((s) => seen.push({ ...s }));
    selectFile(42);
    expect(getState().selectedId).toBe(42);
    expect(seen.length).toBe(1);
    expect(seen[0].selectedId).toBe(42);
  });

  it('selecting the same id again is a no-op', () => {
    selectFile(7);
    const seen: AppState[] = [];
    subscribe((s) => seen.push({ ...s }));
    selectFile(7);
    expect(seen.length).toBe(0);
  });

  it('setModule switches and notifies; same module is a no-op', () => {
    const seen: string[] = [];
    subscribe((s) => seen.push(s.module));
    setModule('develop');
    expect(getState().module).toBe('develop');
    setModule('develop');
    expect(seen).toEqual(['develop']);
  });

  it('unsubscribing stops notifications', () => {
    const seen: AppState[] = [];
    const unsubscribe = subscribe((s) => seen.push({ ...s }));
    unsubscribe();
    selectFile(9);
    expect(seen.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/state.test.ts`
Expected: FAIL — "Cannot find module './state'"

- [ ] **Step 3: Write the implementation**

```ts
export type ModuleId = 'library' | 'develop';

export interface AppState {
  module: ModuleId;
  selectedId: number | null;
}

export type StateListener = (state: AppState) => void;

const state: AppState = { module: 'library', selectedId: null };
const listeners = new Set<StateListener>();

export function getState(): AppState {
  return state;
}

export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener(state);
}

// The single mutation path for file selection: grid clicks, filmstrip
// clicks, and the arrow keys all go through here so they can never
// disagree about which file is selected. Re-selecting the same id is a
// no-op (no notify).
export function selectFile(id: number): void {
  if (state.selectedId === id) return;
  state.selectedId = id;
  notify();
}

export function setModule(id: ModuleId): void {
  if (state.module === id) return;
  state.module = id;
  notify();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/state.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/state.ts src/app/state.test.ts
git commit -m "feat: add app state with single selectFile mutation path"
```

---

## Task 2: Keyboard shortcuts (`src/app/shortcuts.ts`)

**Files:**
- Create: `src/app/shortcuts.ts`
- Test: `src/app/shortcuts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { keyToAction } from './shortcuts';

// Minimal structural stand-ins for KeyboardEvent/HTMLElement -- the
// function only reads these fields, so plain objects work (no jsdom).
function ev(p: {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  target?: unknown;
} = {}) {
  return {
    key: p.key ?? '',
    ctrlKey: p.ctrl ?? false,
    metaKey: p.meta ?? false,
    shiftKey: p.shift ?? false,
    target: p.target,
  };
}

describe('keyToAction', () => {
  it('maps module and navigation keys', () => {
    expect(keyToAction(ev({ key: 'g' }))).toBe('grid');
    expect(keyToAction(ev({ key: 'G' }))).toBe('grid');
    expect(keyToAction(ev({ key: 'e' }))).toBe('loupe');
    expect(keyToAction(ev({ key: 'ArrowLeft' }))).toBe('prev');
    expect(keyToAction(ev({ key: 'ArrowRight' }))).toBe('next');
  });

  it('maps Ctrl/Cmd+Z to undo, with Shift for redo', () => {
    expect(keyToAction(ev({ key: 'z', ctrl: true }))).toBe('undo');
    expect(keyToAction(ev({ key: 'z', meta: true }))).toBe('undo');
    expect(keyToAction(ev({ key: 'z', ctrl: true, shift: true }))).toBe('redo');
  });

  it('ignores unknown keys', () => {
    expect(keyToAction(ev({ key: 'q' }))).toBeNull();
  });

  it('does not fire when focus is in an input, select, or textarea', () => {
    expect(keyToAction(ev({ key: 'g', target: { tagName: 'INPUT' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'ArrowLeft', target: { tagName: 'SELECT' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'z', ctrl: true, target: { tagName: 'TEXTAREA' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'e', target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });

  it('does not fire on content editable elements', () => {
    expect(keyToAction(ev({ key: 'e', target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });

  it('arrows keep their native meaning when a modifier is held', () => {
    expect(keyToAction(ev({ key: 'ArrowLeft', ctrl: true }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/shortcuts.test.ts`
Expected: FAIL — "Cannot find module './shortcuts'"

- [ ] **Step 3: Write the implementation**

```ts
// Maps a keydown event to an app action. Pure (no DOM side effects) so it
// is unit-testable; main.ts wires the returned action to real behavior.
// Focus guard: when the event originated in an <input> (sliders),
// <select>, <textarea>, or content-editable region, returns null so
// arrows and Ctrl+Z keep their native meaning (slider arrows, text undo).
export type Action = 'grid' | 'loupe' | 'prev' | 'next' | 'undo' | 'redo';

// The five event fields keyToAction reads. Structural: a real KeyboardEvent
// satisfies it, and so do plain test objects (no DOM types needed).
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

function isEditable(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName ?? '';
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

export function keyToAction(e: KeyEventLike): Action | null {
  if (isEditable(e.target)) return null;

  const key = e.key.toLowerCase();
  if (key === 'g') return 'grid';
  if (key === 'e') return 'loupe';
  if ((e.ctrlKey || e.metaKey) && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowleft') return 'prev';
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowright') return 'next';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/shortcuts.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/shortcuts.ts src/app/shortcuts.test.ts
git commit -m "feat: map keyboard shortcuts with an input-focus guard"
```

---

## Task 3: Module registry (`src/app/modules.ts`)

**Files:**
- Create: `src/app/modules.ts`
- Test: `src/app/modules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getState, setModule } from './state';
import { registerModule, resetModulesForTests, switchModule, type Module } from './modules';

// modules.ts only reads root.hidden, so a duck-typed fake stands in for
// real HTMLElements in node (no jsdom dependency).
function fakeRoot() {
  return { hidden: false };
}

function makeModule(id: 'library' | 'develop', events: string[], root: { hidden: boolean }): Module {
  return {
    id,
    root: root as unknown as HTMLElement,
    onShow: () => events.push(`${id}:show`),
    onHide: () => events.push(`${id}:hide`),
  };
}

describe('module registry', () => {
  beforeEach(() => {
    // The registry is a module singleton; registerModule can only add to
    // it, so stale registrations from an earlier test would leak in (e.g.
    // test 1 registering 'develop' would make test 2's "unknown id" check
    // switch instead of no-op). resetModulesForTests clears it.
    resetModulesForTests();
    setModule('library');
  });

  it('switchModule hides the old root, shows the new one, and calls hooks in order', () => {
    const events: string[] = [];
    const libraryRoot = fakeRoot();
    const developRoot = fakeRoot();
    registerModule(makeModule('library', events, libraryRoot));
    registerModule(makeModule('develop', events, developRoot));

    switchModule('develop');
    expect(libraryRoot.hidden).toBe(true);
    expect(developRoot.hidden).toBe(false);
    expect(events).toEqual(['library:hide', 'develop:show']);
    expect(getState().module).toBe('develop');

    switchModule('library');
    expect(developRoot.hidden).toBe(true);
    expect(libraryRoot.hidden).toBe(false);
    expect(events).toEqual(['library:hide', 'develop:show', 'develop:hide', 'library:show']);
    expect(getState().module).toBe('library');
  });

  it('unknown id is a no-op', () => {
    const events: string[] = [];
    registerModule(makeModule('library', events, fakeRoot()));
    // 'develop' is not registered in this test
    switchModule('develop');
    expect(getState().module).toBe('library');
    expect(events).toEqual([]);
  });

  it('switching to the active module is a no-op', () => {
    const events: string[] = [];
    const root = fakeRoot();
    registerModule(makeModule('library', events, root));
    registerModule(makeModule('develop', events, fakeRoot()));
    switchModule('library');
    expect(events).toEqual([]);
    expect(getState().module).toBe('library');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/modules.test.ts`
Expected: FAIL — "Cannot find module './modules'"

- [ ] **Step 3: Write the implementation**

```ts
import { getState, setModule, type ModuleId } from './state';

export interface Module {
  id: ModuleId;
  root: HTMLElement;
  onShow(): void;
  onHide(): void;
}

const registry = new Map<ModuleId, Module>();

export function registerModule(module: Module): void {
  registry.set(module.id, module);
}

// Test-only: clears the registry so each test starts from a known state
// (the registry is a module singleton that registerModule can only add to).
export function resetModulesForTests(): void {
  registry.clear();
}

// Shows the target module's root, hides the current one's, calls the
// lifecycle hooks, then notifies state subscribers. Unknown ids and
// switching to the already-active module are no-ops.
export function switchModule(id: ModuleId): void {
  const current = registry.get(getState().module);
  const next = registry.get(id);
  if (!next || next === current) return;

  if (current) {
    current.onHide();
    current.root.hidden = true;
  }
  next.root.hidden = false;
  next.onShow();
  setModule(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/modules.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/modules.ts src/app/modules.test.ts
git commit -m "feat: add module registry with show/hide lifecycle"
```

---

## Task 4: App shell markup + styles (`index.html`)

**Files:**
- Rewrite: `index.html`

- [ ] **Step 1: Replace `index.html` with the shell layout**

Full file (replaces the current one; ids `add-folder`, `exposure`, `wb`, `exposure-value`, `wb-value`, `canvas`, `error`, `error-message`, `error-detail` are preserved so main.ts keeps working):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Candela</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #1e1e20;
        --panel: #26262a;
        --panel-border: #3a3a3f;
        --text: #cfcfcf;
        --text-dim: #8a8a90;
        --accent: #7db2ff;
        --thumb-bg: #333338;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 13px/1.5 system-ui, sans-serif;
      }

      /* Lightroom-style slider: filled bar grows from center (0) toward
         the thumb, instead of the browser default fill-from-left-edge. */
      input[type='range'] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: linear-gradient(
          to right,
          #444 0%,
          #444 var(--from, 50%),
          #4a90d9 var(--from, 50%),
          #4a90d9 var(--to, 50%),
          #444 var(--to, 50%),
          #444 100%
        );
      }
      input[type='range']::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #4a90d9;
        cursor: pointer;
      }
      input[type='range']::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: none;
        background: #4a90d9;
        cursor: pointer;
      }

      /* ---- five-region shell ---- */
      #app {
        display: grid;
        grid-template-columns: 220px 1fr 260px;
        grid-template-rows: auto 1fr 84px;
        height: 100vh;
      }
      #topbar {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 10px;
        background: var(--panel);
        border-bottom: 1px solid var(--panel-border);
      }
      #topbar button {
        background: none;
        border: none;
        color: var(--text-dim);
        font: inherit;
        font-weight: 600;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
      }
      #topbar button.active {
        background: #3d3d43;
        color: #fff;
      }
      #brand {
        margin-left: auto;
        color: var(--accent);
        font-weight: 600;
      }

      /* Module sections occupy the middle row; each lays out its own
         left/content/right columns. `[hidden]` must beat `.module`'s
         display:grid -- UA default is weaker than author styles. */
      .module {
        grid-column: 1 / -1;
        grid-row: 2;
        display: grid;
        grid-template-columns: 220px 1fr 260px;
        min-height: 0;
      }
      .module[hidden] {
        display: none;
      }
      .module .panel {
        background: var(--panel);
        overflow-y: auto;
        padding: 10px;
      }
      .module .panel.left {
        border-right: 1px solid var(--panel-border);
      }
      .module .panel.right {
        border-left: 1px solid var(--panel-border);
      }
      .module .content {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        position: relative;
        background: var(--bg);
      }
      .panel-title {
        margin: 0 0 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-dim);
      }

      /* ---- Library: folders + grid + metadata ---- */
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .panel-header .panel-title {
        margin-bottom: 0;
      }
      #add-folder {
        background: none;
        border: 1px solid var(--panel-border);
        color: var(--text);
        border-radius: 4px;
        padding: 1px 8px;
        cursor: pointer;
        font: inherit;
      }
      .folder-row {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: var(--text-dim);
        font: inherit;
        padding: 3px 6px;
        border-radius: 3px;
        cursor: pointer;
      }
      .folder-row:hover {
        background: #2f2f34;
        color: var(--text);
      }
      .folder-row.active {
        background: #3a4a5c;
        color: #fff;
      }

      #library-scroll {
        height: 100%;
        overflow-y: auto;
        position: relative;
      }
      #library-grid {
        position: relative;
        width: 100%;
      }
      .catalog-heading {
        position: absolute;
        left: 0;
        right: 0;
        height: 24px;
        padding: 3px 8px;
        font-size: 11px;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .catalog-row {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        gap: 4px;
      }
      .catalog-cell {
        width: 160px;
        height: 160px;
        background: var(--thumb-bg);
        cursor: pointer;
        overflow: hidden;
        flex-shrink: 0;
        border-radius: 2px;
      }
      .catalog-cell.selected {
        outline: 2px solid var(--accent);
      }
      .catalog-cell img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .meta-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 0;
        font-size: 12px;
      }
      .meta-label {
        color: var(--text-dim);
      }
      .meta-value {
        text-align: right;
        word-break: break-word;
      }

      /* ---- Develop: history + loupe + Basic ---- */
      #canvas {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
      }
      .history-row {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: var(--text-dim);
        font: inherit;
        padding: 3px 6px;
        border-radius: 3px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .history-row:hover {
        background: #2f2f34;
        color: var(--text);
      }
      .history-row.active {
        background: #3a4a5c;
        color: #fff;
      }
      .history-buttons {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .history-buttons button {
        flex: 1;
        background: none;
        border: 1px solid var(--panel-border);
        color: var(--text);
        border-radius: 4px;
        padding: 3px 8px;
        cursor: pointer;
        font: inherit;
      }
      .history-buttons button:hover {
        background: #2f2f34;
      }
      .slider-label {
        display: block;
        font-size: 12px;
        margin: 10px 0 2px;
      }
      .slider-label output {
        float: right;
        color: var(--accent);
      }

      /* ---- shared filmstrip ---- */
      #filmstrip {
        grid-column: 1 / -1;
        grid-row: 3;
        background: var(--panel);
        border-top: 1px solid var(--panel-border);
        overflow-x: auto;
        overflow-y: hidden;
        position: relative;
      }
      #filmstrip-track {
        position: relative;
        height: 100%;
      }
      .filmstrip-cell {
        position: absolute;
        top: 9px;
        width: 96px;
        height: 66px;
        background: var(--thumb-bg);
        border-radius: 2px;
        cursor: pointer;
        overflow: hidden;
      }
      .filmstrip-cell.selected {
        outline: 2px solid var(--accent);
      }
      .filmstrip-cell img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      /* ---- error toast ---- */
      #error {
        position: fixed;
        bottom: 96px;
        left: 12px;
        z-index: 10;
        max-width: 480px;
        background: #5a2226;
        border: 1px solid #7a3236;
        border-radius: 6px;
        padding: 10px 14px;
      }
      #error[hidden] {
        display: none;
      }
      #error-message {
        margin: 0 0 4px;
      }
      #error-detail {
        margin: 0;
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-word;
        color: #e0b0b0;
      }
      #error summary {
        cursor: pointer;
        font-size: 11px;
        color: #e0b0b0;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <header id="topbar">
        <button data-module="library" class="active">Library</button>
        <button data-module="develop">Develop</button>
        <span id="brand">Candela</span>
      </header>

      <section id="module-library" class="module">
        <aside class="panel left">
          <div class="panel-header">
            <h2 class="panel-title">Folders</h2>
            <button id="add-folder" title="Add folder">＋</button>
          </div>
          <div id="folder-list"></div>
        </aside>
        <main class="content">
          <div id="library-scroll">
            <div id="library-grid"></div>
          </div>
        </main>
        <aside class="panel right">
          <h2 class="panel-title">Metadata</h2>
          <div id="metadata-panel"></div>
        </aside>
      </section>

      <section id="module-develop" class="module" hidden>
        <aside class="panel left">
          <h2 class="panel-title">History</h2>
          <div id="history-list"></div>
          <div class="history-buttons">
            <button id="undo-btn">Undo</button>
            <button id="redo-btn">Redo</button>
          </div>
        </aside>
        <main class="content">
          <canvas id="canvas"></canvas>
        </main>
        <aside class="panel right">
          <h2 class="panel-title">Basic</h2>
          <label class="slider-label" for="exposure">Exposure <output id="exposure-value" for="exposure">+0.00</output></label>
          <input type="range" id="exposure" min="-3" max="3" step="0.01" value="0" />
          <label class="slider-label" for="wb">White Balance <output id="wb-value" for="wb">5500K</output></label>
          <input type="range" id="wb" min="2000" max="10000" step="50" value="5500" />
        </aside>
      </section>

      <footer id="filmstrip">
        <div id="filmstrip-track"></div>
      </footer>

      <div id="error" role="alert" hidden>
        <p id="error-message"></p>
        <details>
          <summary>See detail</summary>
          <pre id="error-detail"></pre>
        </details>
      </div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify the dev server still serves it**

Run: `npm run dev` and open `http://localhost:5173`
Expected: dark shell renders — topbar with Library/Develop tabs, empty left/content/right panels, empty filmstrip at the bottom. No console errors yet (main.ts still queries old ids like `#catalog-scroll`, so the grid area will be broken until Task 6 — that's expected and fine).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: restructure index.html into the LrC five-region shell"
```

---

## Task 5: Shared filmstrip (`src/app/filmstrip.ts`)

**Files:**
- Create: `src/app/filmstrip.ts`

No unit test: it's DOM + `@tanstack/virtual-core` glue (the same pattern the grid uses, which has no unit test either); exercised via the manual checklist in Task 7.

- [ ] **Step 1: Write the implementation**

```ts
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import type { FileRecord } from '../catalog/types';
import { getState, subscribe } from './state';

const CELL_WIDTH = 96; // px, matches index.html's .filmstrip-cell

export interface FilmstripOptions {
  scrollEl: HTMLElement; // horizontal scroll container (#filmstrip)
  trackEl: HTMLElement; // absolutely-positioned cell container (#filmstrip-track)
  getFiles(): FileRecord[];
  getThumbnail(file: FileRecord): Promise<Blob | undefined>;
  onSelect(file: FileRecord): void;
}

export interface Filmstrip {
  setFiles(count: number): void;
  destroy(): void;
}

// Horizontal windowed strip -- same pattern as the virtualized grid in
// main.ts (one Virtualizer over "N items of a fixed size", absolutely
// positioned children), rotated to the horizontal axis. It shares the
// caller's thumbnail cache (getThumbnail) and decode path (onSelect), and
// follows the shared selection from state.ts: clicking a cell selects the
// file; any external selection change (grid click, arrow keys) scrolls the
// selected cell into view and re-renders the highlight.
export function createFilmstrip(opts: FilmstripOptions): Filmstrip {
  const { scrollEl, trackEl, getFiles, getThumbnail, onSelect } = opts;

  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => CELL_WIDTH,
    horizontal: true,
    overscan: 3,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => renderVisible(),
  });
  // Same headless-package pattern as the grid in main.ts: _didMount wires
  // the resize/scroll observers and returns cleanup; _willUpdate refreshes
  // measurements before reading sizes.
  const cleanup = virtualizer._didMount();
  virtualizer._willUpdate();

  function renderVisible(): void {
    virtualizer._willUpdate();
    trackEl.style.width = `${virtualizer.getTotalSize()}px`;
    trackEl.textContent = '';
    const files = getFiles();
    const selectedId = getState().selectedId;
    for (const item of virtualizer.getVirtualItems()) {
      const file = files[item.index];
      if (!file) continue;

      const cell = document.createElement('div');
      cell.className = 'filmstrip-cell' + (file.id === selectedId ? ' selected' : '');
      cell.style.left = `${item.start}px`;
      cell.title = file.name;
      cell.addEventListener('click', () => onSelect(file));
      trackEl.appendChild(cell);

      getThumbnail(file).then((blob) => {
        if (!blob) return; // extraction failed or not yet permitted -- placeholder stays
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        img.addEventListener('error', () => {
          URL.revokeObjectURL(img.src);
          img.remove();
        }, { once: true });
        cell.appendChild(img);
      });
    }
  }

  // Re-render on every state change: highlights the selected cell and
  // (when the selection changed) scrolls it into view. Re-rendering on
  // module switches too is harmless -- cells rebuild from the thumbnail
  // promise cache, no re-extraction.
  const unsubscribe = subscribe(() => {
    const { selectedId } = getState();
    const files = getFiles();
    const index = files.findIndex((f) => f.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    renderVisible();
  });

  return {
    setFiles(count: number): void {
      virtualizer.setOptions({ ...virtualizer.options, count });
      virtualizer.measure();
      renderVisible();
    },
    destroy(): void {
      unsubscribe();
      cleanup();
    },
  };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors (filmstrip.ts isn't imported yet, but tsc compiles the whole project)

- [ ] **Step 3: Commit**

```bash
git add src/app/filmstrip.ts
git commit -m "feat: add shared horizontal filmstrip with synced selection"
```

---

## Task 6: Wire it all together (`src/main.ts`)

**Files:**
- Rewrite: `src/main.ts`

- [ ] **Step 1: Replace `src/main.ts`**

Full file. The decode/open pipeline, slider handling, and virtualized grid logic are preserved from the current main.ts (same openFile, thumbnail cache, and renderVisibleRows — with `#catalog-scroll`/`#catalog-grid` renamed to `#library-scroll`/`#library-grid`). New: folder list with filter, metadata + history readouts, undo/redo buttons, module wiring, shortcuts, and the filmstrip.

```ts
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError } from './raw/decode';
import { WB_NEUTRAL_KELVIN } from './gpu/uniforms';
import { openCatalogDb } from './catalog/db';
import { listFolders, listFiles } from './catalog/query';
import { importFolder } from './catalog/import';
import { ensureReadPermission } from './catalog/permissions';
import { loadEditState, saveEditState } from './catalog/editsStore';
import { commitEdit, undo, redo, currentOps } from './catalog/editHistory';
import { opsToAdjustState } from './catalog/adjust';
import { getOrExtractThumbnail } from './catalog/thumbnails';
import { isExposureOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord, type FolderRecord } from './catalog/types';
import { getState, selectFile, subscribe, type ModuleId } from './app/state';
import { registerModule, switchModule } from './app/modules';
import { createFilmstrip } from './app/filmstrip';
import { keyToAction } from './app/shortcuts';

const COLUMNS_PER_ROW = 6; // fixed for this pass -- see plan header
const CELL_SIZE = 160; // px, matches index.html's .catalog-cell
const HEADING_HEIGHT = 24; // px, matches index.html's .catalog-heading

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const libraryScroll = document.querySelector<HTMLDivElement>('#library-scroll')!;
const libraryGrid = document.querySelector<HTMLDivElement>('#library-grid')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLDivElement>('#error')!;
const errorMessageEl = document.querySelector<HTMLParagraphElement>('#error-message')!;
const errorDetailEl = document.querySelector<HTMLPreElement>('#error-detail')!;
const folderListEl = document.querySelector<HTMLDivElement>('#folder-list')!;
const metadataEl = document.querySelector<HTMLDivElement>('#metadata-panel')!;
const historyListEl = document.querySelector<HTMLDivElement>('#history-list')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const redoButton = document.querySelector<HTMLButtonElement>('#redo-btn')!;
const filmstripScroll = document.querySelector<HTMLElement>('#filmstrip')!;
const filmstripTrack = document.querySelector<HTMLDivElement>('#filmstrip-track')!;

function showError(message: string, detail?: string): void {
  errorMessageEl.textContent = message;
  errorDetailEl.textContent = detail ?? '';
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.hidden = true;
  errorMessageEl.textContent = '';
  errorDetailEl.textContent = '';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Colors the slider track from its neutral point toward the thumb,
// matching Lightroom's fill-from-zero style instead of the browser
// default fill-from-left-edge.
function updateSliderFill(slider: HTMLInputElement, neutral = 0): void {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const neutralPct = ((neutral - min) / (max - min)) * 100;
  const valuePct = ((Number(slider.value) - min) / (max - min)) * 100;
  slider.style.setProperty('--from', `${Math.min(neutralPct, valuePct)}%`);
  slider.style.setProperty('--to', `${Math.max(neutralPct, valuePct)}%`);
}

function updateReadout(output: HTMLOutputElement, value: number, decimals: number): void {
  output.textContent = (value >= 0 ? '+' : '') + value.toFixed(decimals);
}

function currentOpsFromSliders(): Op[] {
  return [
    { kind: 'exposure', ev: Number(exposureSlider.value) },
    { kind: 'whiteBalance', kelvin: Number(wbSlider.value) },
  ];
}

function applyOpsToSliders(ops: Op[]): void {
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  exposureSlider.value = String(exposureOp?.ev ?? 0);
  wbSlider.value = String(wbOp?.kelvin ?? WB_NEUTRAL_KELVIN);
  updateSliderFill(exposureSlider);
  updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
  updateReadout(exposureValue, Number(exposureSlider.value), 2);
  wbValue.textContent = `${Number(wbSlider.value)}K`;
}

updateSliderFill(exposureSlider);
updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
updateReadout(exposureValue, Number(exposureSlider.value), 2);
wbValue.textContent = `${Number(wbSlider.value)}K`;

// The flattened, virtualizer-facing shape of the catalog: one entry per
// folder heading, one entry per row of up to COLUMNS_PER_ROW files. This
// is what lets a single Virtualizer (which only understands "N items,
// each with a size") represent a grid grouped by folder.
type GridEntry =
  | { kind: 'heading'; folderName: string }
  | { kind: 'row'; files: FileRecord[] };

function chunkIntoRows(files: FileRecord[]): FileRecord[][] {
  const rows: FileRecord[][] = [];
  for (let i = 0; i < files.length; i += COLUMNS_PER_ROW) {
    rows.push(files.slice(i, i + COLUMNS_PER_ROW));
  }
  return rows;
}

function opsToLabel(ops: Op[]): string {
  if (ops.length === 0) return 'Import';
  return ops
    .map((op) => {
      if (isExposureOp(op)) return `Exposure ${op.ev >= 0 ? '+' : ''}${op.ev.toFixed(2)}`;
      return `WB ${op.kelvin}K`;
    })
    .join(' · ');
}

async function init(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openCatalogDb();
  } catch (err) {
    showError("Couldn't open your photo catalog.", errorDetail(err));
    addFolderButton.disabled = true;
    return;
  }

  let pipeline: Pipeline;
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError("This browser can't run the editor (WebGPU is required).", errorDetail(err));
    addFolderButton.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
    return;
  }

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;
  let lastDecoded: { width: number; height: number } | null = null;
  let openRequestId = 0;
  let folders: FolderRecord[] = [];
  let allFiles: FileRecord[] = [];
  let folderFilter: number | null = null;
  let gridEntries: GridEntry[] = [];

  // Caches the in-flight or resolved thumbnail request per file id, so
  // re-rendering the same visible cell across multiple virtualizer
  // range-changes (a normal scroll produces many) doesn't re-issue a fresh
  // getOrExtractThumbnail call each time -- callers just await the same
  // promise. This is a permanent per-session cache, including a
  // resolved-to-undefined ("not available") result -- retrying on every
  // scroll-driven miss would mean every visible cell re-running
  // loadThumbnail + queryPermission + requestPermission on every scroll
  // frame while permission is missing (the normal state right after a
  // reload, since File System Access grants don't persist), which is
  // exactly the per-frame cost a virtualized grid exists to avoid. The one
  // place permission actually changes is a real user gesture, so openFile
  // (below) is what busts this cache and asks for one fresh retry pass,
  // not scroll. The filmstrip shares this same cache (via getThumbnail).
  const thumbnailRequests = new Map<number, Promise<Blob | undefined>>();

  function getThumbnail(file: FileRecord): Promise<Blob | undefined> {
    let promise = thumbnailRequests.get(file.id);
    if (!promise) {
      promise = getOrExtractThumbnail(db, file).catch(() => undefined);
      thumbnailRequests.set(file.id, promise);
    }
    return promise;
  }

  function renderOps(ops: Op[]): void {
    pipeline.render(opsToAdjustState(ops));
  }

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => libraryScroll,
    estimateSize: (index) => (gridEntries[index]?.kind === 'heading' ? HEADING_HEIGHT : CELL_SIZE),
    overscan: 3,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => renderVisibleRows(),
  });
  // @tanstack/virtual-core's headless package (not a framework adapter --
  // confirmed against the installed v3.17.8 types) has no `.observe()`.
  // `_didMount()` wires up the resize/scroll observers and returns the
  // cleanup function; `_willUpdate()` must be called before reading
  // `getTotalSize()`/`getVirtualItems()` to refresh measurements -- done
  // once here for the initial render, and again at the top of
  // `renderVisibleRows()` since that's also what `onChange` re-invokes on
  // every scroll/resize.
  const cleanupGrid = virtualizer._didMount();
  virtualizer._willUpdate();

  // Renders only the grid rows the virtualizer currently reports as
  // in-range -- this is the function that keeps a 10,000-file catalog from
  // creating 10,000 DOM nodes or requesting 10,000 thumbnails up front.
  function renderVisibleRows(): void {
    virtualizer._willUpdate();
    libraryGrid.style.height = `${virtualizer.getTotalSize()}px`;
    libraryGrid.textContent = '';
    const selectedId = getState().selectedId;
    for (const virtualItem of virtualizer.getVirtualItems()) {
      const entry = gridEntries[virtualItem.index];
      if (!entry) continue;

      if (entry.kind === 'heading') {
        const heading = document.createElement('strong');
        heading.className = 'catalog-heading';
        heading.style.top = `${virtualItem.start}px`;
        heading.textContent = entry.folderName;
        libraryGrid.appendChild(heading);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'catalog-row';
      row.style.top = `${virtualItem.start}px`;
      for (const file of entry.files) {
        const cell = document.createElement('div');
        cell.className = 'catalog-cell' + (file.id === selectedId ? ' selected' : '');
        cell.title = file.path;
        cell.addEventListener('click', () => openFile(file));
        cell.addEventListener('dblclick', () => switchModule('develop'));
        row.appendChild(cell);

        getThumbnail(file).then((blob) => {
          if (!blob) return; // extraction failed or not yet permitted -- placeholder stays
          const img = document.createElement('img');
          img.src = URL.createObjectURL(blob);
          img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
          img.addEventListener('error', () => {
            URL.revokeObjectURL(img.src);
            img.remove();
          }, { once: true });
          cell.appendChild(img);
        });
      }
      libraryGrid.appendChild(row);
    }
  }

  // Rebuilds the flattened catalog (folders, allFiles, gridEntries) from
  // the database, honoring folderFilter, then refreshes grid, folder
  // list, and filmstrip. Called on import and on folder-filter clicks.
  async function renderCatalog(): Promise<void> {
    folders = await listFolders(db);
    allFiles = [];
    gridEntries = [];
    for (const folder of folders) {
      if (folderFilter !== null && folder.id !== folderFilter) continue;
      const files = await listFiles(db, folder.id);
      allFiles.push(...files);
      gridEntries.push({ kind: 'heading', folderName: folder.name });
      for (const row of chunkIntoRows(files)) {
        gridEntries.push({ kind: 'row', files: row });
      }
    }
    virtualizer.setOptions({ ...virtualizer.options, count: gridEntries.length });
    virtualizer.measure();
    renderVisibleRows();
    renderFolderList();
    filmstrip.setFiles(allFiles.length);
  }

  function renderFolderList(): void {
    folderListEl.textContent = '';
    appendFolderRow(null, 'All folders');
    for (const folder of folders) {
      appendFolderRow(folder.id, folder.name);
    }
  }

  function appendFolderRow(id: number | null, name: string): void {
    const row = document.createElement('button');
    row.className = 'folder-row' + (folderFilter === id ? ' active' : '');
    row.textContent = name;
    row.addEventListener('click', () => {
      folderFilter = id;
      renderCatalog(); // also re-renders the folder list active state
    });
    folderListEl.appendChild(row);
  }

  function renderMetadata(): void {
    metadataEl.textContent = '';
    const file = allFiles.find((f) => f.id === currentFileId);
    if (!file) return;
    appendMeta('Name', file.name);
    appendMeta('Dimensions', lastDecoded ? `${lastDecoded.width} × ${lastDecoded.height}` : '—');
    appendMeta('Size', `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    appendMeta('Modified', new Date(file.lastModified).toLocaleString());
  }

  function appendMeta(label: string, value: string): void {
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('span');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'meta-value';
    v.textContent = value;
    row.append(l, v);
    metadataEl.appendChild(row);
  }

  function renderHistory(): void {
    historyListEl.textContent = '';
    if (!currentEditState) return;
    const { history, cursor } = currentEditState;
    history.forEach((ops, index) => {
      const row = document.createElement('button');
      row.className = 'history-row' + (index === cursor ? ' active' : '');
      row.textContent = opsToLabel(ops);
      row.addEventListener('click', () => {
        if (!currentEditState) return;
        currentEditState = { ...currentEditState, cursor: index };
        const opsAtCursor = currentOps(currentEditState);
        applyOpsToSliders(opsAtCursor);
        renderOps(opsAtCursor);
        renderHistory();
        saveEditState(db, currentFileId!, currentEditState).catch((err) =>
          showError("Couldn't save your edit.", errorDetail(err)),
        );
      });
      historyListEl.appendChild(row);
    });
  }

  // Permission-checking lives inside this try block (not before it) so a
  // rejection from ensureReadPermission (e.g. requestPermission() called
  // without an active user gesture) is caught the same way a decode
  // failure is, instead of becoming an unhandled rejection.
  async function openFile(record: FileRecord): Promise<void> {
    clearError();
    selectFile(record.id);
    const requestId = ++openRequestId;
    try {
      // Checked separately from ensureReadPermission() below so we know
      // whether THIS call is what granted access, vs. access already having
      // been granted (the common case for every click after the first).
      // Clearing/re-rendering the thumbnail grid is not free (it re-fetches
      // every visible cell) -- doing that on every single file click, not
      // just the one that actually changed permission state, was visibly
      // janky (competing with this very decode() call for the shared WASM
      // module) and added nothing once permission was already settled.
      const alreadyGranted = (await record.handle.queryPermission({ mode: 'read' })) === 'granted';

      if (!(await ensureReadPermission(record.handle))) {
        showError(`Permission needed to read "${record.name}" -- click it again to retry.`);
        return;
      }

      // Only the transition from not-granted to granted needs a thumbnail
      // retry pass -- see the comment above. Once permission is already
      // settled, every later click skips straight to decoding.
      if (!alreadyGranted) {
        thumbnailRequests.clear();
        renderVisibleRows();
      }

      const start = performance.now();
      const file = await record.handle.getFile();
      const decoded = await decode(await file.arrayBuffer());
      if (requestId !== openRequestId) return; // superseded during decode -- skip the wasted edit-state load

      const editState = await loadEditState(db, record.id);
      if (requestId !== openRequestId) return; // superseded while loading edit state

      // Everything above only touched local variables (decoded, editState) --
      // no shared state has been written yet. From here everything is
      // synchronous with no `await` in between, so this whole block commits
      // atomically: canvas, GPU pipeline, and catalog state all move together,
      // and nothing else can interleave a stale write partway through.
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      pipeline.load(decoded);
      currentFileId = record.id;
      currentEditState = editState;
      lastDecoded = { width: decoded.width, height: decoded.height };
      const ops = currentOps(currentEditState);
      applyOpsToSliders(ops);
      renderOps(ops);
      renderMetadata();
      renderHistory();

      // waitForGPU() is awaited only for the perf log below -- it doesn't
      // gate anything, since nothing after it touches shared state.
      await pipeline.waitForGPU();
      const elapsed = performance.now() - start;
      console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }
  }

  async function onSliderInput(): Promise<void> {
    if (currentFileId === null) return;
    const start = performance.now();
    renderOps(currentOpsFromSliders());
    await pipeline.waitForGPU();
    const elapsed = performance.now() - start;
    console.log(`slider->frame: ${elapsed.toFixed(1)}ms`);
  }

  // Fires on slider release (the 'change' event), not on every 'input'
  // tick -- one drag from end to end is one undo step, not hundreds.
  async function commitCurrentEdit(): Promise<void> {
    if (currentFileId === null || !currentEditState) return;
    currentEditState = commitEdit(currentEditState, currentOpsFromSliders());
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save your edit.", errorDetail(err));
    }
    renderHistory();
  }

  async function applyUndoRedo(isRedo: boolean): Promise<void> {
    if (currentFileId === null || !currentEditState) return;
    currentEditState = isRedo ? redo(currentEditState) : undo(currentEditState);
    const ops = currentOps(currentEditState);
    applyOpsToSliders(ops);
    renderOps(ops);
    renderHistory();
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save your undo/redo.", errorDetail(err));
    }
  }

  exposureSlider.addEventListener('input', () => {
    updateSliderFill(exposureSlider);
    updateReadout(exposureValue, Number(exposureSlider.value), 2);
    onSliderInput();
  });
  exposureSlider.addEventListener('change', () => {
    commitCurrentEdit();
  });

  wbSlider.addEventListener('input', () => {
    updateSliderFill(wbSlider, WB_NEUTRAL_KELVIN);
    wbValue.textContent = `${Number(wbSlider.value)}K`;
    onSliderInput();
  });
  wbSlider.addEventListener('change', () => {
    commitCurrentEdit();
  });

  undoButton.addEventListener('click', () => applyUndoRedo(false));
  redoButton.addEventListener('click', () => applyUndoRedo(true));

  // ---- module wiring ----
  registerModule({
    id: 'library',
    root: document.querySelector('#module-library')!,
    onShow: () => {},
    onHide: () => {},
  });
  registerModule({
    id: 'develop',
    root: document.querySelector('#module-develop')!,
    onShow: () => {
      // The canvas sits inside a display:none section while Library is
      // active; the WebGPU drawing buffer's contents are undefined after
      // the surface is hidden/re-shown, so re-render from the existing
      // textures (cheap -- no decode; the pipeline already holds them).
      if (currentFileId !== null && currentEditState) {
        renderOps(currentOps(currentEditState));
      }
    },
    onHide: () => {},
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-module]')) {
    button.addEventListener('click', () => switchModule(button.dataset.module as ModuleId));
  }

  // Keeps the topbar tab highlight in sync with the active module,
  // whichever path changed it (click or G/E shortcut).
  subscribe(() => {
    const module = getState().module;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-module]')) {
      button.classList.toggle('active', button.dataset.module === module);
    }
  });

  // ---- shortcuts ----
  window.addEventListener('keydown', async (e) => {
    const action = keyToAction(e);
    if (!action) return;

    if (action === 'grid' || action === 'loupe') {
      e.preventDefault();
      // Shortcut actions are named for the target workspace; module ids
      // are 'library'/'develop'.
      switchModule(action === 'grid' ? 'library' : 'develop');
      return;
    }
    if (action === 'undo' || action === 'redo') {
      e.preventDefault();
      await applyUndoRedo(action === 'redo');
      return;
    }

    // prev/next walk the flat, folder-ordered file list; with no selection
    // yet, the first arrow selects the first file (Lightroom-ish).
    e.preventDefault();
    const index = allFiles.findIndex((f) => f.id === getState().selectedId);
    const nextIndex = index === -1 ? 0 : action === 'next' ? index + 1 : index - 1;
    const file = allFiles[nextIndex];
    if (file) await openFile(file);
  });

  // ---- filmstrip ----
  const filmstrip = createFilmstrip({
    scrollEl: filmstripScroll,
    trackEl: filmstripTrack,
    getFiles: () => allFiles,
    getThumbnail,
    onSelect: (file) => openFile(file),
  });

  // AbortError means the user opened the folder picker and dismissed it --
  // the single most common outcome of clicking this button. That's not an
  // error worth surfacing; anything else (a real I/O failure, a rejected
  // permission request during the walk) goes through showError like every
  // other failure path in this file.
  addFolderButton.addEventListener('click', async () => {
    addFolderButton.disabled = true;
    try {
      await importFolder(db);
      await renderCatalog();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showError("Couldn't import that folder.", errorDetail(err));
    } finally {
      addFolderButton.disabled = false;
    }
  });

  await renderCatalog();

  window.addEventListener(
    'beforeunload',
    () => {
      cleanupGrid();
      filmstrip.destroy();
    },
    { once: true },
  );
}

init();
```

- [ ] **Step 2: Type-check and run the unit tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no TS errors; all tests pass (state 6 + shortcuts 6 + modules 3 + existing 49).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `tsc && vite build` completes without errors.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire the LrC shell -- modules, shortcuts, filmstrip, panels"
```

---

## Task 7: Manual verification + memory check

**Files:**
- Docs: `docs/superpowers/verification/` (new file per the Task 8 verification pattern)

- [ ] **Step 1: Run the dev server and work through the checklist**

Run: `npm run dev`, open `http://localhost:5173`

| # | Check | Pass |
|---|---|---|
| 1 | Dark shell renders per the mockup: topbar (Library\|Develop), left/content/right panels, filmstrip at the bottom | ☐ |
| 2 | Click ＋ → import a folder with raw files → grid shows folder heading + cells; filmstrip fills with thumbs; folder list shows "All folders" + the folder | ☐ |
| 3 | Click a grid cell → it highlights (grid + filmstrip sync); metadata panel shows name/dims/size | ☐ |
| 4 | Press `E` → Develop module: loupe shows the image; sliders work (Exposure/WB move the image live); history panel lists "Import" + edits | ☐ |
| 5 | Drag a slider, release → history gains a step; press `Ctrl+Z` → slider returns, history cursor moves back; `Ctrl+Shift+Z` redoes | ☐ |
| 6 | `←`/`→` walk the file list (loupe updates); clicking a history step jumps the edit state | ☐ |
| 7 | Press `G` → back to Library; selection preserved (same cell/filmstrip cell highlighted); press `E` again → loupe shows the same file with its edits intact | ☐ |
| 8 | Double-click a grid cell → jumps to Develop loupe | ☐ |
| 9 | Click a folder in the left panel → grid filters to that folder's files; "All folders" restores everything | ☐ |
| 10 | Open the X-Trans RAF fixture (`sample.raf` or any Fuji file) → renders clean colors, no speckling (verifies the render-bug fix from the previous commit) | ☐ |
| 11 | Memory stability: open 10 files in a row (click through the grid), adjusting a slider on each — no crash, no slowdown | ☐ |

- [ ] **Step 2: Record results**

Create `docs/superpowers/verification/2026-08-25-lrc-app-shell.md` with the checklist and the observed results (mark the items that passed; note anything that failed for a follow-up).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/verification/2026-08-25-lrc-app-shell.md
git commit -m "docs: record LrC app shell manual verification results"
```
