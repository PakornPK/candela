# LrC App Shell — Manual Verification Results

Date: 2026-08-25
Plan: `docs/superpowers/plans/2026-08-25-lrc-app-shell.md`
Status: automated gates passed; browser checks pending human pass (user reviews before push)

## Automated gates (already run, all passed)

- `npx tsc --noEmit` — no errors
- `npx vitest run` — 63/63 pass (49 pre-existing + 14 new: state 5, shortcuts 6, modules 3)
- `npm run build` — succeeds (the `node:module` externalization notice for `src/wasm/libraw.js` is pre-existing emscripten glue, not new)

## Browser checklist (pending — user)

Run `npm run dev`, open `http://localhost:5173`.

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
