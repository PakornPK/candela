# Candela Improvement Plan — UX+QA product review 2026-09-18

Sources: `dogfood-output/review-2026-09-18/qa/report.md` (8 defects, 5 gaps),
`dogfood-output/review-2026-09-18/ux/report.md` (12 findings). Build reviewed:
working tree at `a43d519` + `npm run dev` on :5199 (tests 345/345 green).
Findings deduped by mechanism — two reports, one cause = one item.

Ranked by impact on the core loop (cull fast on a big catalog) per unit effort.
P0 = breaks trust in the grid/cull flow, P1 = wrong promises / silent state loss,
P2 = polish sweep, P3 = re-rank into existing roadmap.

---

## P0 — the grid's repaint contract (biggest single win)

### 1. Grid renders blank after module switch / filter churn; keyboard selection invisible
- Evidence: Library→Develop→Library → `.catalog-cell` count 6→0 while footer says "5 photos"; any `scroll` event restores cells (UX-1). Same staleness after search/filter churn: 6→0 cells, stale `grid.style.height=184px`, reload-only recovery (QA-D7). Arrow-key selection: "1 selected" with zero `.selected` cells — the digit key hits a phantom selection (UX-2).
- Root cause: `renderVisibleRows()` is only invoked on scroll/import (`main.ts:1605` onChange, `3684` subscribe comment); `onShow` of the library module does not force a virtualizer re-measure, and the selection subscriber paints only cells that currently exist.
- Fix: one invalidation point — `onShow(library)` and every list/filter mutation call a single `refreshGrid()` that re-measures the virtualizer, rebuilds visible rows, then re-paints selection outline. Fix at the source (reload assigns list at end), not in the view (browser-app-verification lesson).
- Effort: M. Roadmap: new (underpins 1.1 and 2.2; the grid is the product's narrow waist).

### 2. Develop opens blank after reload — silent render race
- Evidence: dblclick cell → Develop; canvas stays `300x150`, pixel checksum 0, zero console errors, recovers only via slider nudge or filmstrip click (QA-D2, screenshot `qa/develop-blank-on-entry-recovered.png`).
- Root cause: race in `ensureDevelopImage` / develop `onShow` path (`main.ts:3586+`, re-entry guard at `2101` treats same-file decode "already in flight" as done when it failed/was aborted pre-catalog-restore).
- Fix: trace the onShow→decode→upload→render chain; on entry, assert canvas non-blank or show the app's own error state. No silent blank.
- Effort: M. Roadmap: new defect.

### 3. X (reject) orphans selection and resets position
- Evidence: select idx 0 → `x` → photo hides (default filter), "1 selected" persists with 0 selected cells, ArrowRight jumps to idx 0 not the next photo (UX-3).
- Fix: reject handler — drop the hidden id from `selectedIds`, move selection to the next visible row *before* filtering, reuse the auto-advance machinery (`#auto-advance` path already computes "next file").
- Effort: S. Roadmap: new (cull-flow defect; this is the highest-frequency gesture).

## P1 — state machines and advertised lies

### 4. Crop-mode state wedges zoom until reload
- Evidence: Crop on→off, change `#crop-aspect` while off → `cropModeActive` stuck true; wheel/Z `prevented=false`, indicator frozen 100%, overlay `display:block` with no active class; only reload recovers (QA-D1).
- Root cause: `#crop-aspect` change handler (`main.ts:2403+`) unconditionally `setCropMode(true)` ("re-open the workbench") — but crop controls stay visible in Done mode, so a stray select change silently re-enters the workbench whose wheel guard (`2951`) then swallows zoom.
- Fix: pick one owner for the mode — hide/disable crop controls in Done mode (Lightroom behavior) OR make aspect change commit without re-entering. First option keeps the state machine impossible to desync.
- Effort: S–M. Roadmap: new defect.

### 5. Zoom shortcuts advertised in button titles do nothing; 1/2 silently re-rate
- Evidence: titles say "Fit (F)" "100% (1)" "200% (2)" (`index.html:1434-1437`); keys change nothing and 1/2 re-rate selected photos 4★→2★ in Develop (QA-D4).
- Fix: ship ROADMAP 1.4 (zoom presets F/Shift+F/1/2 + double-click) — which makes ROADMAP 1.1 zoom/pan mostly a superset — or strip the advertised titles. Do not leave advertised-but-dead controls.
- Effort: M (1.4 as scoped). Roadmap: **implements 1.4, re-ranks above 1.2/1.3.**

### 6. Before/After toggle-off shows the original until an unrelated input
- Evidence: exit Before mode → canvas sum stays 1294256 (original) until a slider `input` → 1839840 (QA-D3).
- Root cause: `setBeforeAfter(false, ...)` calls `renderOps(currentOps(currentEditState ?? createEditState()))` (`main.ts:3130-3136`) — `currentEditState` stale vs slider state, or the render is skipped by the equal-state guard while the canvas still shows [].
- Fix: trace what `currentOps` reads after slider drags; render edited ops unconditionally on exit.
- Effort: S. Roadmap: new defect (1.3 hold-to-peek shares this code — fix together).

### 7. Footer count ignores collection/search/rating scope
- Evidence: collection view 2 cells, footer "6 photos"; 0-match smart collection, footer "6 photos" (QA-D5); rejected hidden with no "(N hidden)" note (UX-12).
- Fix: `updateFooter()` (`main.ts:1500-1509`) takes the *visible list* (the same array `renderVisibleRows` uses) + hidden-count suffix. One writer.
- Effort: S. Roadmap: new; do alongside item 1 (same refresh funnel).

### 8. Mirror gaps: filmstrip shows no ratings; selection lost on reload
- Evidence: grid `on=2` stars vs `#filmstrip-track` starNodes=0, same files (UX-5). Ratings persist across reload but `selIdx=-1`, `selection-info=''` (UX-6).
- Fix: filmstrip cell render reuses `.cell-star` badge builder; persist last `selectedId` per folder in the existing catalog state.
- Effort: S each. Roadmap: new (the "glanceable state" promise).

## P2 — polish sweep (one PR each, mechanical)

### 9. Sub-24px hit targets + slider grab area
- Evidence: `.cell-star` 13.1x13, filter checkboxes 13x13, `#export-btn` 55x21, selects 16–19 tall, `input[type=range]` 224x**4** (QA-D6 + UX-8).
- Fix: CSS pass — min 24px targets (`::part()`/`::-webkit-slider-runnable-track` height for ranges, padded hit areas via `label` wrappers). No behavior change; verify with the same rect script.
- Effort: S. Roadmap: new.

### 10. Empty states + first-run guidance
- Evidence: 0-photo grid = no CTA/copy (UX-4); 0-match smart/search = truly blank (QA gap).
- Fix: one reusable `.empty-state` component: "Add a folder to start — photos never leave this machine" (+ keyboard hint line, teaching the layer that only the "?" dialog documents).
- Effort: S. Roadmap: new; supports the positioning claims verbatim.

### 11. Error/feedback handling
- Evidence: `#error` alert "Nothing to export — a preview can't be exported" stays forever, no dismiss, names internals (UX-7); uncaught `TypeError: not granted` rejection from `queryPermission` (`main.ts:1958`) (QA-D8); metadata "—" / "0.0 MB" for JPEGs (UX-10).
- Fix: dismissable alert with user-verb copy ("Open a photo first — click one in Library"); wrap `queryPermission` in try→'not-granted'; populate dimensions/size for non-raw files from decode + `File.size`.
- Effort: S. Roadmap: new (4.1 device-loss will reuse the alert plumbing).

### 12. Contrast tokens + icon labels
- Evidence: muted text 4.39:1 / 4.25:1 under AA at 11–13px (UX-11); ◀/▶ pagination and filter checkboxes unlabeled (UX-12).
- Fix: bump `--muted` tokens to ≥4.5:1 on `#26262a`; add `title`/`aria-label`.
- Effort: S. Roadmap: new.

## P3 — deferred / re-ranked

- **Compare surface affordances** (UX-9: no swap/sync/rating feedback): real finding but ROADMAP 3.2 already owns it — re-rank 3.2 above 3.4 (Tethered) since culling is the stated wedge. Rating keys should mirror onto compare panes as part of item 8's badge builder.
- **Print preview zoom-to-fit** (UX: A4 at 794x1123 in 633px viewport, >half below fold): small `transform: scale(fit)` on the sheet wrapper; schedule with 3.5 follow-ups.
- **RAW-decode path untested** (both reports used JPEG fixtures): QA pass with one real CR3/ARW before touching Phase 1 GPU work; track as verification debt, not a defect.
- **`main.ts` is the site of 8 of 12 fixes** → the existing refactoring item (extract developModule/libraryModule) now has evidence for *which* seams to cut first: the grid refresh funnel (item 1) and crop/before-after state (items 4/6). Sequence item 1's `refreshGrid()` so the extraction can lift it whole.

## Execution order — STATUS (implemented + browser-verified 2026-09-18)

Batch 1 (DONE, live-verified on dev build):
- #1 grid repaint contract: `refreshGrid()` resyncs virtualizer rect/offset on library
  onShow + single `repaintGrid()` tail; verify: tab round-trip cells 6->6 (was ->0),
  `g` from develop 6->6; selection rings always present.
- #3 reject flow: `pruneSelectionToVisible()` + reference-leave advance over the visible
  list; verify: X -> cells 12->11, selectedIdx stays at the next photo (was jumps to 0
  with phantom "1 selected"). Arrow keys walk `visibleFiles` in Library (was `allFiles`,
  which let a key rate a photo the view hides).
- #7 footer: counts over `visibleFiles` + "· N hidden"; verify: collection scope 1 cell /
  "1 photo" (was 1/6), filter scope "11 photos · 1 hidden".
- #8 mirrors: filmstrip rating badges (`syncRatings()` in-place, 12 nodes live),
  selection restores after reload via localStorage.lastFile (was selIdx -1), auto-advance
  persists (was per-load), metadata sizes show KB not 0.0 MB, dims resolve from the file
  itself (not the scaled thumbnail).
- #4 crop state machine: `#crop-workbench` container hidden outside crop mode by
  `setCropMode` — aspect/rotate/straighten can no longer silently re-enter the workbench;
  verify: repro sequence leaves zoom alive after Done (110%->121%), overlay hidden,
  controls hidden, zero console errors.
- #2 develop blank canvas: `ensureDevelopImage` now AWAITS openFile's in-flight decode
  instead of racing the dedup promise; verify: dblclick entry renders 2000x1333
  (was 300x150 blank).
- #6 before/after exit: renders `currentOpsFromSliders()` not the lagging committed state;
  verify: canvas sum edited 3497996 -> before 2740288 -> exit 3497996 (was stuck at
  2740288).
- #5 advertised shortcuts: titles no longer promise F/1/2; double-click canvas = 2x-at-
  cursor / back-to-fit (ROADMAP 1.4 partial); verify real CDP dblclick: 100% -> 200% ->
  100%.
- #11 error paths: `queryReadPermission()` swallows the NotAllowedError rejection (QA-D8;
  zero boot errors observed), export alert copy names the user's next move, Esc dismisses
  the alert, error alerts tested.
- #10 empty states: `#library-empty` CTA — add-folder prompt on first run, "no photos
  match" on filter/search/smart zero (renders from `renderVisibleRows`, the one place
  that knows the count).
- #12 contrast: --text-dim #8a8a90 -> #9a9aa2 (4.39 -> 4.87:1 on #2e2e33, measured);
  #9 targets: star badges 13.1x13 -> 25x25 (elementFromPoint hits the star), sliders
  4px -> 24px hit band (look unchanged), selects/buttons min 24px, zoom buttons 23->24;
  checkbox row targets 24px via label.
- Gates: tsc clean, 345/345 vitest, vite build green.

Follow-ups (user reports after the batch, fixed same day):
- Double-click any Develop slider resets it to default (WB/Tint land on
  As-Shot). Verified: exp 0 -> +3 (sum 720414->947768) -> dblclick -> 720414.
- Footer rating chips now carry visible per-level counts (counts lived only
  in tooltips; the bar looked dead while rating). Verified: star-4 click ->
  chips 'All 4 · ★ 1 · … · ★★★★ 1 · ★★★★★ 0'; ★★ chip click filters
  cells 4 -> 2.
- Filmstrip stars are now real controls (same 1..5 click semantics as the
  grid). The first mirror pass was a display-only badge with
  pointer-events:none -- it looked clickable, did nothing ('ไม่ขยับ').
  Verified with CDP pointer events: strip 4-star -> grid+chips+strip all
  update (stripOn [0,4,0,0,0]); re-click clears.

Remaining (not in this batch):
- #5 full ROADMAP 1.4 zoom presets (F/Shift+F/1/2 keys) — titles fixed, keys still
  unwired; 1/2 remain rating keys (LrC behavior).
- UX-9 compare affordances -> folded into ROADMAP 3.2 re-rank.
- Print zoom-to-fit, RAW-decode QA pass, `main.ts` module extraction (plan P3).


1. Items 1+7 together (same funnel) — kills UX-1/2, QA-D7, D5.
2. Items 3, 6, 11 — S-sized cull-flow + error-path fixes.
3. Item 4 (crop state machine) + 2 (develop race) — the two High functional defects.
4. Item 5 as ROADMAP 1.4 (now P1, above 1.2/1.3).
5. Sweep PRs: 9, 10, 12.
6. Re-run this skill (QA+UX two-lens) to re-verify against this list before re-ranking ROADMAP v2.
