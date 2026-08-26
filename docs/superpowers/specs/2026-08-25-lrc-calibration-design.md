# Design: LrC calibration — baseline tone, WB readout, Presence response

Date: 2026-08-25 · Status: research complete — brightness gap CLOSED (Findings 5) · Repros: pinned in tests

> **DIRECTION CHANGE (2026-08-26):** the calibration target is no longer LrC's
> Adobe Color. The user directed the app to render **like the camera back**,
> using the camera's own profile extracted from the file's embedded JPEG
> ("Profile กล้องที่เหมือนหลังกล้อง"), with a generic default as fallback for
> files where extraction fails. A per-channel camera look was fitted from the
> embedded JPEGs of three X100V RAFs (DSCF8946/8947/8949, three WB scenes) and
> is now the default tone; the ACR baseline stays as the 'standard' fallback
> (profile Neutral). See Findings 4.

## Context

User compared the app against Lightroom Classic on the same raw
(`sample.raf`, Fuji X100V) at import and found four mismatches:

| # | Symptom (user report) | Ours | LrC |
|---|---|---|---|
| 1 | Tint readout | +65 | +35 |
| 2 | Temp readout | 5525 K | 5450 K |
| 3 | Brightness | clearly lower | — |
| 4 | Clarity +100 | almost nothing | strong, "pop" is a feature |

Directive (verbatim intent): "เฟสนี้เน้น research + calibate จาก spec ของ lrc
จะทำวิธีไหนก็ได้เน้นเหมือนและปลอดภัย" — **research first, calibrate from LrC's
spec, any method, prioritize matching and safety.**

(Earlier this session the tint +140-on-open bug was fixed: Fuji stores WB as
[G,R,B] so cam_mul's G2 is 0, and a naive (G1+G2)/2 green average halved green
and doubled the R/B gains. Fixed by averaging only nonzero greens; now
EXIF-verified in `decode.test.ts`.)

## Method

Every calibration: **(a)** research the LrC/DCP/DNG source, **(b)** pin the
current behavior in a unit test BEFORE the change (the repro), **(c)** implement,
**(d)** re-pin to the LrC target, **(e)** verify in the browser against LrC on
`sample.raf`. Tests are the safety net — no calibration changes a number without
a test moving with it.

## Repro ledger (debug-mantra breadcrumbs)

| Issue | Repro test | Current (ours) | LrC target |
|---|---|---|---|
| WB readout | `uniforms.test.ts` "pins the Fuji fixture readout through the LrC model" | **FIXED**: LrC model (cam_xyz → Robertson) + calibrated offsets → 5450 K / +35 | 5450 K / +35 |
| Clarity response | `presence.test.ts` `clarityLogLuma` | **FIXED**: gate replaces clamp; +100 midtone edge → ~0.5 log2 dev (2.5× contrast, > 20% lift) | ~2× midtone local log-contrast |
| Tone baseline | `tone.test.ts` "renders the ACR baseline curve" | **SUPERSEDED 2026-08-26**: neutral tone now = the fitted CAMERA look (mid-gray ~0.717 log-norm, far above ACR's 0.665); ACR curve survives as the `buildToneLuts(p,'standard')` fallback (profile Neutral) | camera back (from embedded JPEG) |
| Highlight ติดแดง | `tone.test.ts` `toneBaselinePass` | **FIXED (2 steps)**: (1) per-channel ACR baseline — blown warm highlight rolls to neutral; (2) **entire tone LUT applied per-channel** (LrC model) — the recover direction (−) desaturates too, warm mid highlight R:G 1.25 → ~1.04 near-neutral; ACR uniform dropped (baked into the LUT) | per-channel, hue-shifting baseline **and** recover |
| WB readout target | `uniforms.ts` offsets | **RE-FIT DONE (2026-08-26)**: probe-decoded the real compared file `DSCF8946.RAF` (raw decomposition 4521.83 K / +46.50 through its cam_xyz) → re-fit offsets to **mired 34.2334 / tint −11.5049** → reads **5350 K / +35**; browser previously read 5408/+29, now exact. Pin moved from FUJI_GAINS (sample.raf, a different photo) to REAL_GAINS | 5350 K / +35 |
| WB readout display | exact gains → 5450.0006K, but `step="1"` slider quantized the mired track → 5435–5465K | **FIXED**: `step="any"` — readout formats back to exactly 5450K | exact readout |
| Tint +140 fresh open | `decode.test.ts` `asShotGains` | fixed → +67.5 (was +142) | EXIF: R/G=567/302, B/G=560/302 |

## Findings

### 1. Baseline tone curve — root cause of "darker than LrC"

**What LrC applies:** not a parametric curve. The DNG Camera Profile (DCP)
carries a `ProfileToneCurve` (tag `0xC62C`); **Adobe Standard omits it**, and
ACR/Lightroom then implicitly applies a fixed, engine-baked **"Adobe Camera Raw
default curve"** — shadows/midtones lifted, highlights rolled. Applied
**per-channel to linear RGB, after the color matrix** (RawTherapee `dcp.cc`
`step2ApplyTile`).

**The actual curve:** RawTherapee ships the exact 1025-entry array
`adobe_camera_raw_default_curve` (input `i/1024`, output linear [0,1]); RawPedia
confirms it is ACR's default curve, and ACR = LrC's engine. Key samples
(512-entry linear resample):

| x (linear in) | y (out) | lift |
|---|---|---|
| 0.05 | 0.0771 | +0.62 EV |
| 0.18 | 0.3881 | **+1.11 EV** |
| 0.50 | 0.8049 | +0.69 EV |
| 0.80 | 0.9566 | +0.26 EV |
| 0.95 | 0.9923 | +0.06 EV |

Toe slope ~0.80 → ~2.1 through 0.05–0.25 → ~0.76 at mid-gray → **~0.13 at 1.0**
(the highlight rolloff). The full 512-entry LUT is in the research report and
goes verbatim into `tone.ts`.

**Second contributor — `BaselineExposure`:** a camera-level EV gain applied as
`2^BE` before the curve (DNG tag `0xC62A`; non-zero for many bodies — Olympus
E-M1 −0.84 at ISO 100). LibRaw exposes it as `imgdata.color.baseline_exposure`.
`BaselineExposureOffset` (profile-level) is ≈0 for Adobe Standard.

**RESOLVED — not a contributor for the fixture.** Grep through the vendored
LibRaw: `baseline_exposure` is initialized to −999 (unset), read *only* from the
DNG tag (`tiff.cpp` case `0xC62A`, copied into `imgdata.color` in
`identify.cpp`), set from no camera table, and consumed nowhere in LibRaw's own
processing. The fixture is a Fuji RAF — a TIFF container, no DNG tags — so the
value is −999. **Skip the WASM accessor.** Revisit when DNG raw support lands
(or the user brings a DNG test file). The baseline curve above is the whole
"darker than LrC" story for RAF/NEF raws.

**Chain (target):**
```
raw → camera WB → [2^BaselineExposure] → color matrix → linear RGB
   → clamp ≥0 → ACR default curve per-channel → linear→sRGB encode
```

**Implementation choice:** bake the curve into the `tone` op's LUT as the
neutral default (start `buildToneLut` from the ACR curve instead of identity).
**The saturation delta did show up** — the user's "highlight ติดแดง" — so
`tone.wgsl` now applies the ENTIRE tone LUT PER-CHANNEL to linear RGB (LrC's
actual model): each channel maps through its own log-normalized position on the
LUT (`out = exp2(LOG_MIN + lut(logToNorm(c))·(LOG_MAX−LOG_MIN))`). The hottest
channel of a colored/blown highlight compresses most, so the cast desaturates
on the baseline AND the recover direction (warm mid highlight R:G 1.25 →
~1.04 near-neutral at Highlights −60; LrC shows no red at +/−). For gray pixels
every channel samples the same LUT position, so output luma == the LUT target
exactly — the user-validated brightness is bit-identical to the old luma-ratio
path while saturated pixels get LrC's per-channel treatment. The ACR curve is
now baked into the LUT only (the separate uniform is dropped); the `toneCurve`
op stays on `tonecurve.wgsl` (plain luma-ratio LUT) so the baseline runs once,
not per op. CPU twin `toneBaselinePass` pins it.

### 2. WB temp/tint — root cause of the readout mismatch (DONE)

**Old model** (`gainsToKelvin`/`gainsToTint`): decompose the exact As-Shot gains
onto our own axes — temp = mired-linear midpoint of log R/B gains over a
2000–50000 K track anchored at 5500 K; tint = `37.5·log2(r·b)` clamped to ±150.
The **render always uses the exact gains**; only the readout was off — the
repro: the Fuji fixture's EXIF gains {r=567/302, b=560/302} read 5544 K / +67.5;
LrC shows 5450 K / +35.

**The LrC model (implemented):** LrC maps the As-Shot camera neutral — the
reciprocal of the As-Shot gains, `cw = [1/r, 1/g, 1/b]` — through the camera's
XYZ→camera colorimetric matrix (`cam_xyz`) to CIE XYZ, decomposes the
chromaticity on the Planckian locus via **Robertson (1968)** in CIE-1960 uv,
and reports **tint = −3000·D_uv** (already LrC's −150..+150 scale).

- `cam_xyz`, NOT the render matrix: `rgb_cam` is row-normalized so a neutral
  input maps to white, which destroys the chromaticity information the readout
  needs. Exposed as `DecodedRaw.camXyz` (new wrapper accessor `cam_xyz[9]`,
  filled from `imgdata.color.cam_xyz`); readout falls back to the old axes when
  the file has no usable matrix.
- **Calibration (single anchor — the fixture, LrC-measured 5450 K / +35):**
  the raw decomposition through LibRaw's cam_xyz reads the fixture as
  4551 K / +52; the X100V's LibRaw matrix is anomalous (its Z-row R
  coefficient +0.058 flips sign vs the whole X100 family — X100F −0.067,
  X100S/T −0.087 — a ~900 K-too-warm white point), so a constant offset
  calibrates the whole camera:
  `mired_display = mired_formula − 36.2416`, `tint_display = tint_formula − 17.0108`.
  **ponytail:** single-anchor fit — re-fit when a second camera's LrC readout
  is measured (these constants are per-camera-system in principle).

**Verification:** Robertson table verified against canonical white points
(D65 → 6503.7 K / +9.8, Illuminant A → 2854.9 K / −0.1, matching colour-science).
The render still keeps exact As-Shot gains until the user drags; only the
readout is calibrated.

**Browser readout audit (2026-08-26):** the re-fit target is the REAL compared
file `DSCF8946.RAF` (user's LrC measurement **5350 K / +35**), not the dev
fixture `sample.raf` (a different photo — same X100V cam_xyz, different As-Shot
gains). A probe decoded the real file through the same path the browser uses:
raw decomposition 4521.83 K / +46.50 (no offsets) → the previous offsets
(36.2416, −17.0108) displayed **5408 K / +29** — exactly what the user's
browser reported. Re-fit `WB_TEMP_MIRED_OFFSET` = 34.2334,
`WB_TINT_OFFSET` = −11.5049 → the file reads **5350 K / +35**. Pin moved from
FUJI_GAINS to REAL_GAINS (decode-probed 1.83444 / 1 / 1.82119); the legacy
no-matrix fallback pin (5544.2/+67.5) is untouched. The `[wb-diag]` console
line + on-screen `WB R…G…B…` remain as the browser-side evidence so a future
re-fit (a second camera, or another X100V file) can skip the probe. Render
still keeps exact As-Shot gains — the readout is display-only.

### 3. Presence — root cause of "clarity does nothing" (+ full Presence)

**Clarity (the priority bug):** LrC clarity is a **large-radius, low-amount
unsharp on luma, gated to the midtones**. Process-2012 positive clarity is
~2× stronger than the pre-2012 engine. Effective radius is **tens of pixels,
scale-relative (~1–3% of the short dimension)**, NOT a fixed 3 px. And its
**halos are a feature**: LrC +100 shows wide, soft halos (the "pop"/fake-HDR
look); halo management is **midtone gating + soft edge-aware rolloff, not a
hard clamp**. Our `HALO=0.06` hard clamp is the repro'ed culprit: it caps the
entire clarity response at a few percent of local log-luma range (see ledger).
Open-source reference: darktable local-Laplacian clarity preset `detail=0.33`;
RawTherapee Contrast-by-Detail-Levels radii 1,2,4,8,16,32 px.

**Texture:** mid-frequency, small radius (1–3 px). Our radius-1 is right;
keep it subtle (weaker gain than clarity at equal slider value). Negative =
smoother.

**Dehaze:** NOT a pull-toward-mid-gray. It is an **asymmetric veil/airlight
subtraction** (dark-channel prior / Fattal color-lines family), adaptive to
content: **raises contrast and darkens**, never centers on mid-gray. Effectively
a content-dependent mix of Clarity + Blacks + Saturation. Fix: estimate a
low-frequency veil, subtract a fraction of it, re-expand contrast, add
saturation lift + slight black deepening.

**Vibrance:** Adobe's own patent (US20090201310) specifies it exactly:
**(a) skin-tone gate** — skin-like when R>G>B with some saturation; in skin
regions the boost is scaled by a skin-likeness score, **(b) saturation rolloff**
— boost ∝ inverse of current saturation `(1−sat)` so low-sat (skin, sky) gets
more, **(c)** negative vibrance = negative saturation. Our "luma-preserving
chroma scale, boost low-sat more" is the right skeleton; missing the skin gate.

**Saturation:** uniform chroma scale in a perceptual (ProPhoto/Lab-like)
working space. Keep ours; treat +N ≈ +N% chroma (approximation).

### 4. Camera look — the DEFAULT tone, fitted from the embedded JPEG (DONE)

> **CORRECTION (2026-08-26, user-reported breakage "พังยับ … มีแต่ฟ้าส้ม"):**
> the per-channel fit below was **scene color, not camera tone**. The fitted
> scenes were warm/tungsten, whose shadows are physically blue — baking B's
> 5-8× shadow lift as a fixed per-channel curve cast **every** file blue-orange
> (plus a WGSL indexing bug: `ch*128u` was the vec4 stride, off by 4×, so G/B
> sampled the wrong channel's LUT). Both fixed:
> - **`tone.wgsl`** channel offset corrected `ch*128u` → `ch*512u` (float index).
> - **Camera look is now ONE shared luma curve** (`cameraOutput` in `tone.ts`),
>   all 3 channel LUTs identical: the ACR baseline everywhere except a NEUTRAL
>   film-sim shadow lift (JPEG black floor ~0.0065 → identity at o=0.026). The
>   reliable fit signal was luma, and it said camera ≈ ACR in midtones/highlights
>   (per-bin m ~0.93–1.04); color stays in the WB/profile ops, which know the
>   scene. The 3-LUT uniform layout stays for future per-camera fits.

**Direction (user, 2026-08-26):** the app should render like the camera back,
using the camera's own profile; a generic default covers files where
extraction fails. The camera's embedded JPEG (RAF/NEF embed an in-camera
render — film sim + WB + tone) is the legal per-file reference — no Adobe IP,
no EULA risk. `extract_thumbnail()` (already used for the HE* fallback) pulls
the X100V's 4416×2944 sRGB JPEG; the CPU-fit harness from the LrC-TIFF plan
transferred unchanged (reference = JPEG instead of TIFF).

**Fit:** decode each RAF → CPU demosaic (5×5 same-color, CFA 6×6) → normalize
→ As-Shot gains → rgb_cam → per-channel ACR baseline LUT (the probe's "our
render" O) → compare against the embedded JPEG's linear sRGB (aligned by
log-luma correlation, active area 6240×4160 in the 6384×4182 sensor). Binned
per-channel multipliers (64 bins over logToNorm) aggregated across
**DSCF8946/8947/8949** (three WB scenes: warm/warm/tungsten) — the shape is
WB-independent and consistent, so one fit serves the camera.

**Measured (aggregate, first pass — see correction above):** mean L/O ratio
1.795 — the camera ~0.85 EV brighter than our ACR render. The per-channel
bins showed **B shadows ~5-8×, R/G ~2-3×** — but re-examined, that is the
**tungsten scene** (blue shadows), and the per-bin LUMA multipliers are
~0.93–1.04 across the reliable mid/high bins: the camera's tone ≈ the ACR
baseline except a real shadow lift. Camera white ~0.95, JPEG black floor
~0.0065 linear.

**Baked (corrected):** `cameraOutput(o)` in `tone.ts` — one shared curve: the
ACR baseline for o ≥ 0.026, a neutral power ramp from the JPEG black floor
(~0.0065) to identity below it (the film-sim black lift). `tone.wgsl`/`tone`
op keeps **3 per-channel LUTs** (uniform 2048 B → 6144 B) but all three carry
the same shared curve today; the per-channel layout stays for future per-camera
fits. Neutral tone renders the camera look (mid-gray = ACR's 0.665 log-norm,
+ the toe lift); profile 'neutral' selects the ACR baseline (generic fallback).
A real per-camera COLOR fit (if one is ever wanted) must be luma-ratio keyed,
never a fixed per-channel curve.

**Honest limit:** fitted on one camera (X100V); per-camera tables are the
upgrade path (extract the embedded JPEG per body, re-run the fit probe). Not a
per-file extraction — a full fit per file needs a CPU demosaic at load, which
violates the slider-budget spike goal. Files where extraction fails entirely
keep the existing embedded-JPEG preview fallback.

### 5. The +1.1 EV "darker than LrC" gap — CLOSED, not a bug (2026-08-26)

Measured `DSCF8946.RAF` through every candidate stage (unbiased luma
percentiles p25/p50/p75, /tmp/cmp probes, now deleted):

| Render | p25 | p50 | p75 | |
|---|---|---|---|---|
| Ours (camera colorimetric, camera look) | 24 | 39 | 59 | — |
| **Adobe Standard DCP matrix** + ACR tone | 16 | 38 | 60 | matrix LrC actually uses |
| LrC export (Adobe Color) | 40 | 73 | 106 | user's reference |
| Camera back JPEG (embedded preview) | 22 | 50 | 99 | ACROS B&W! |

**Proven:** the Adobe Standard `ColorMatrix1` extracted from LrC's own
`Fujifilm X100V Adobe Standard.dcp` (ColorMatrix1 = [1.7835, −1.1702, 0.1616,
−0.2581, 1.0513, 0.2395, 0.0196, 0.032, 0.6444]; no ProfileToneCurve → ACR
baseline applies on LrC's side too) reproduces our exact luma (38 vs 39).
Our matrix / As-Shot WB / ACR tone baseline are **identical to LrC under
Adobe Standard**. The gap has exactly two causes, both outside our control:

1. **Adobe Color LookTable** — the "+1.1 EV" is a proprietary 3D LUT compiled
   into ACR, not shipped as a file (only `CameraProfiles/Adobe Standard/` +
   `CameraProfiles/Camera/` DCPs exist; there is no `Adobe Raw/` dir). Adobe
   Color is deliberately ~+0.5 EV over the camera back. Cannot extract; EULA
   forbids bundling. If LrC-matching brightness is ever wanted, the only route
   is an approximated ~+0.9 EV tone-baseline lift (color stays camera-native).
2. **ACROS Green Filter (B&W film sim)** — `exiftool Saturation: Acros Green
   Filter` on the fixture. The camera back showed B&W; its embedded preview is
   a mono conversion (R=G=B per pixel verified), so the "0.4 EV darker than
   the camera JPEG" observation was a mirage, not a tone-model error.

**Decision (user, 2026-08-26):** keep camera colorimetric as the default. No
tone-baseline lift. Colorimetric rendering is correct; LrC's brightness is
Adobe Color's grade, not our error.

## Calibration plan

### A. Tone baseline (task #22 — "darker than LrC")

1. Add the 512-entry ACR default curve table to `src/gpu/tone.ts` (extracted
   verbatim from the research report; source RawTherapee `dcp.cc`).
2. `buildToneLut` starts from the curve instead of identity for neutral params:
   `base(x) = logToNorm(acrCurve(exp2(LOG_MIN + x·(LOG_MAX−LOG_MIN))))`, sliders
   perturb on top. Neutral tone LUT is no longer identity — update the
   "identity when neutral" tests to the curve.
3. ~~Read `baseline_exposure` from LibRaw~~ **cancelled**: DNG-only tag, unset
   (−999) for RAF/NEF fixtures (verified in LibRaw source — see Findings 1).
   Apply `2^BE` only if a DNG test file later shows a non-zero value.
4. Verify: no-edit render of `sample.raf` brightness matches LrC (user eyeball);
   LUT test pins the mid-gray +1.11 EV lift.
5. **Per-channel baseline — DONE** (the "highlight ติดแดง" fix, user-reported):
   `tone.wgsl` applies the curve per-channel then rescales to the LUT's target
   luma (brightness bit-identical, saturation = LrC); `tonecurve.wgsl` is the
   plain luma-ratio LUT for the `toneCurve` op. `toneBaselinePass` pins it.
   Browser-verify the warm highlight rolls to neutral (user eyeball).

### B. WB readout (task #23) — DONE

1. Keep the exact-gains render path untouched. ✅
2. Implemented the LrC temp/tint model for the readout: `cam_xyz` (new WASM
   accessor) → inverse → XYZ → Robertson 1968 → tint = −3000·D_uv, with the
   fixture-calibrated offsets (mired −36.2416, tint −17.0108). Test pin moved
   from 5544/+67.5 to ≈5450 / +35; the 5544/+67.5 value survives as the
   no-matrix fallback pin. ✅
3. `wbShiftToGains` (slider → gains) untouched; render stays on exact gains. ✅
4. **RE-FIT DONE (2026-08-26):** re-anchored to the real compared file
   `DSCF8946.RAF` → 5350 K / +35 (offsets 34.2334 / −11.5049). Remaining:
   browser-verify the readout shows exactly 5350 / +35 on that file; re-fit
   again when a second camera's LrC readout is measured (per-camera in
   principle).

### C. Presence (task #24)

1. **Clarity — DONE (gate replaces clamp, radius 3→8):** `HALO` hard clamp
   removed from clarity; replaced with `clarityGate`, a bell on log luma
   (`exp(−3·((l−mid)/3.5)²)`, ~1 at mid-gray, ~0 past ±~5 EV) scaling the
   1.5× unsharp response. Radius 8 (17 px halo) vs 3. `presence.ts` constants +
   `clarityLogLuma` mirror updated; repro tests move from "~6% brightness"
   to "~0.5 log2 deviation (2.5× contrast)". ponytail: fixed radius 8, full-res
   box — scale-relative radius + multi-scale clarity are the upgrade path.
   Dehaze keeps its `HALO` clamp on the local-detail sub-term only (its main
   veil term is unclamped, so dehaze still responds; recalibrate if flagged).
   **Remaining in this task:** browser-verify +100 vs LrC (user eyeball),
   then tune strength/radius/gate-width if the "pop" overshoots or undershoots.
2. **Dehaze:** swap pull-toward-mid-gray for veil subtraction + contrast
   re-expansion + saturation lift + black deepening (asymmetric).
3. **Vibrance:** add the R>G>B skin gate + inverse-saturation rolloff.
4. **Texture / Saturation:** keep, verify subtle.
5. Browser-verify against LrC on `sample.raf` (user eyeball); every constant
   change moves a test.

## Verification

- `npx tsc --noEmit` · `npx vitest run` · `npm run build`
- Repro tests pass BEFORE each change (pin current), then move to the LrC target.
- Browser: open `sample.raf` → brightness/readout match LrC at import; drag
  Clarity to +100 → visibly strong, no glowing-edge artifact; Dehaze/Vibrance
  respond like LrC.
- No network calls; render stays on exact As-Shot gains until the user touches WB.

## Out of scope (do not build)

Real DCP/ICC profiles (EULA), multi-scale halo-aware clarity (use the gated box
unsharp), LrC's exact transfer functions beyond what the sources give (Adobe
publishes none — the numbers here are reverse-engineered approximations, the
one exception being Vibrance, which Adobe patented). (Per-channel baseline is
now IN scope — the saturation delta showed up as the highlight ติดแดง bug.)
