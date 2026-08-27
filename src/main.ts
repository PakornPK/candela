import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError, type CameraMeta, type DecodedRaw } from './raw/decode';
import { extractThumbnail } from './raw/thumbnail';
import { gainsToKelvin, gainsToTint, WB_NEUTRAL_KELVIN } from './gpu/uniforms';
import { getCameraXyz } from './gpu/ops';
import { openCatalogDb } from './catalog/db';
import { listFolders, listFiles } from './catalog/query';
import { setCull } from './catalog/culling';
import { importFolder } from './catalog/import';
import { ensureReadPermission } from './catalog/permissions';
import { loadEditState, saveEditState } from './catalog/editsStore';
import { deletePreset, listPresets, savePreset, type PresetRow } from './catalog/presetsStore';
import { commitEdit, undo, redo, currentOps, createEditState } from './catalog/editHistory';
import { getOrExtractThumbnail } from './catalog/thumbnails';
import { isExposureOp, isBwOp, isPresenceOp, isProfileOp, isToneCurveOp, isToneOp, isVignetteOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord, type FolderRecord, type ProfileKind, type FilmStockId, type WbGains, type BwMix, type BwToneId } from './catalog/types';
import { FILM_STOCKS } from './gpu/film';
import { buildParametricToneLut, buildToneCurveLut, fitRegionParams, isNeutralTone, parametricControlPoints, TONE_LUT_SIZE, type ToneParams } from './gpu/tone';
import { isNeutralPresence, type PresenceParams } from './gpu/presence';
import { isNeutralVignette, type VignetteParams } from './gpu/vignette';
import { BW_FILTERS, BW_TONES, type BwFilterId } from './gpu/bw';
import { getState, selectFile, setSelection, subscribe, type ModuleId } from './app/state';
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
const tintSlider = document.querySelector<HTMLInputElement>('#tint')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const tintValue = document.querySelector<HTMLOutputElement>('#tint-value')!;
const profileSelect = document.querySelector<HTMLSelectElement>('#profile')!;
// The profile picker's options -- Camera, Neutral, then every film stock --
// built from the FILM_STOCKS registry so a new stock auto-appears (the HTML
// select is empty until this runs).
const profileOptions: Array<[string, string]> = [
  ['camera', 'Camera'],
  ['neutral', 'Neutral'],
  ...(Object.keys(FILM_STOCKS) as FilmStockId[]).map((id) => [id, FILM_STOCKS[id].name] as [string, string]),
];
profileSelect.replaceChildren(
  ...profileOptions.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }),
);
profileSelect.value = 'camera';
const contrastSlider = document.querySelector<HTMLInputElement>('#contrast')!;
const highlightsSlider = document.querySelector<HTMLInputElement>('#highlights')!;
const shadowsSlider = document.querySelector<HTMLInputElement>('#shadows')!;
const whitesSlider = document.querySelector<HTMLInputElement>('#whites')!;
const blacksSlider = document.querySelector<HTMLInputElement>('#blacks')!;
const contrastValue = document.querySelector<HTMLOutputElement>('#contrast-value')!;
const highlightsValue = document.querySelector<HTMLOutputElement>('#highlights-value')!;
const shadowsValue = document.querySelector<HTMLOutputElement>('#shadows-value')!;
const whitesValue = document.querySelector<HTMLOutputElement>('#whites-value')!;
const blacksValue = document.querySelector<HTMLOutputElement>('#blacks-value')!;
const textureSlider = document.querySelector<HTMLInputElement>('#texture')!;
const claritySlider = document.querySelector<HTMLInputElement>('#clarity')!;
const dehazeSlider = document.querySelector<HTMLInputElement>('#dehaze')!;
const vibranceSlider = document.querySelector<HTMLInputElement>('#vibrance')!;
const saturationSlider = document.querySelector<HTMLInputElement>('#saturation')!;
const textureValue = document.querySelector<HTMLOutputElement>('#texture-value')!;
const clarityValue = document.querySelector<HTMLOutputElement>('#clarity-value')!;
const dehazeValue = document.querySelector<HTMLOutputElement>('#dehaze-value')!;
const vibranceValue = document.querySelector<HTMLOutputElement>('#vibrance-value')!;
const saturationValue = document.querySelector<HTMLOutputElement>('#saturation-value')!;
const vignetteAmountSlider = document.querySelector<HTMLInputElement>('#vignette-amount')!;
const vignetteMidpointSlider = document.querySelector<HTMLInputElement>('#vignette-midpoint')!;
const vignetteRoundnessSlider = document.querySelector<HTMLInputElement>('#vignette-roundness')!;
const vignetteFeatherSlider = document.querySelector<HTMLInputElement>('#vignette-feather')!;
const vignetteHighlightsSlider = document.querySelector<HTMLInputElement>('#vignette-highlights')!;
const vignetteAmountValue = document.querySelector<HTMLOutputElement>('#vignette-amount-value')!;
const vignetteMidpointValue = document.querySelector<HTMLOutputElement>('#vignette-midpoint-value')!;
const vignetteRoundnessValue = document.querySelector<HTMLOutputElement>('#vignette-roundness-value')!;
const vignetteFeatherValue = document.querySelector<HTMLOutputElement>('#vignette-feather-value')!;
const vignetteHighlightsValue = document.querySelector<HTMLOutputElement>('#vignette-highlights-value')!;
const bwTreatmentSelect = document.querySelector<HTMLSelectElement>('#bw-treatment')!;
const bwControls = document.querySelector<HTMLDivElement>('#bw-controls')!;
const bwFilterSelect = document.querySelector<HTMLSelectElement>('#bw-filter')!;
const bwToneSelect = document.querySelector<HTMLSelectElement>('#bw-tone')!;
const bwMixSliders = {
  red: document.querySelector<HTMLInputElement>('#bw-red')!,
  orange: document.querySelector<HTMLInputElement>('#bw-orange')!,
  yellow: document.querySelector<HTMLInputElement>('#bw-yellow')!,
  green: document.querySelector<HTMLInputElement>('#bw-green')!,
  aqua: document.querySelector<HTMLInputElement>('#bw-aqua')!,
  blue: document.querySelector<HTMLInputElement>('#bw-blue')!,
  purple: document.querySelector<HTMLInputElement>('#bw-purple')!,
  magenta: document.querySelector<HTMLInputElement>('#bw-magenta')!,
};
const bwMixValues = {
  red: document.querySelector<HTMLOutputElement>('#bw-red-value')!,
  orange: document.querySelector<HTMLOutputElement>('#bw-orange-value')!,
  yellow: document.querySelector<HTMLOutputElement>('#bw-yellow-value')!,
  green: document.querySelector<HTMLOutputElement>('#bw-green-value')!,
  aqua: document.querySelector<HTMLOutputElement>('#bw-aqua-value')!,
  blue: document.querySelector<HTMLOutputElement>('#bw-blue-value')!,
  purple: document.querySelector<HTMLOutputElement>('#bw-purple-value')!,
  magenta: document.querySelector<HTMLOutputElement>('#bw-magenta-value')!,
};
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const contactPrev = document.querySelector<HTMLButtonElement>('#contact-prev')!;
const contactNext = document.querySelector<HTMLButtonElement>('#contact-next')!;
const contactSheetLabel = document.querySelector<HTMLSpanElement>('#contact-sheet-label')!;
const contactRollLabel = document.querySelector<HTMLDivElement>('#contact-roll-label')!;
const contactGrid = document.querySelector<HTMLDivElement>('#contact-grid')!;
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
const curveCanvas = document.querySelector<HTMLCanvasElement>('#curve')!;
const curveResetButton = document.querySelector<HTMLButtonElement>('#curve-reset')!;
const curveCtx = curveCanvas.getContext('2d')!;
const curveAdjust = document.querySelector<HTMLSelectElement>('#curve-adjust')!;
const curveRegion = document.querySelector<HTMLDivElement>('#curve-region')!;
const curvePoint = document.querySelector<HTMLDivElement>('#curve-point')!;
const regionHighlightsSlider = document.querySelector<HTMLInputElement>('#region-highlights')!;
const regionLightsSlider = document.querySelector<HTMLInputElement>('#region-lights')!;
const regionDarksSlider = document.querySelector<HTMLInputElement>('#region-darks')!;
const regionShadowsSlider = document.querySelector<HTMLInputElement>('#region-shadows')!;
const regionHighlightsValue = document.querySelector<HTMLOutputElement>('#region-highlights-value')!;
const regionLightsValue = document.querySelector<HTMLOutputElement>('#region-lights-value')!;
const regionDarksValue = document.querySelector<HTMLOutputElement>('#region-darks-value')!;
const regionShadowsValue = document.querySelector<HTMLOutputElement>('#region-shadows-value')!;
const histogramCanvas = document.querySelector<HTMLCanvasElement>('#histogram')!;
const histogramCtx = histogramCanvas.getContext('2d')!;
const cameraInfoEl = document.querySelector<HTMLDivElement>('#camera-info')!;
const filterHideRejected = document.querySelector<HTMLInputElement>('#filter-hide-rejected')!;
const filterPicked = document.querySelector<HTMLInputElement>('#filter-picked')!;
const filterMinRating = document.querySelector<HTMLSelectElement>('#filter-min-rating')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export-btn')!;
const exportFormat = document.querySelector<HTMLSelectElement>('#export-format')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset-btn')!;
const beforeAfterBtn = document.querySelector<HTMLButtonElement>('#beforeafter-btn')!;
const presetSaveButton = document.querySelector<HTMLButtonElement>('#preset-save')!;
const presetListEl = document.querySelector<HTMLDivElement>('#preset-list')!;
const syncBtn = document.querySelector<HTMLButtonElement>('#sync-btn')!;
const footerCounts = document.querySelector<HTMLSpanElement>('#footer-counts')!;
const selectionInfo = document.querySelector<HTMLSpanElement>('#selection-info')!;
const footerFilterButtons = document.querySelectorAll<HTMLButtonElement>('#footer-filters [data-minrating]');
const bwSection = document.querySelector<HTMLDetailsElement>('#bw-section')!;

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

function formatSigned(value: number, decimals = 0): string {
  return (value >= 0 ? '+' : '') + value.toFixed(decimals);
}

// The WB slider carries a MIRED-offset value, not Kelvin: v = 500 - 1e6/K, so
// the track is linear in mired (perceptually uniform temperature) -- 2000K -> 0
// (cool), 50000K -> 480 (warm), 5500K -> ~318 (neutral). A linear-Kelvin track
// crams the whole cool side into ~7% of its width. kelvinToWbSlider is left
// unrounded so the neutral (318.1818...) formats back to exactly 5500K.
const wbSliderToKelvin = (v: number): number => Math.round(1e6 / (500 - v));
const kelvinToWbSlider = (k: number): number => 500 - 1e6 / k;

// As-Shot white balance for the currently loaded file, set by loadIntoPipeline
// after each decode. A fresh file (no WB op) renders at these exact camera
// gains ("As Shot", like LrC) until the user touches WB/tint -- kelvin+tint
// cannot represent an arbitrary cam_mul (wbShiftToGains forces rGain*bGain=1),
// so the exact gains must survive as an op field, not be re-derived.
interface AsShotWB { kelvin: number; tint: number; gains: WbGains }
let asShotWB: AsShotWB | null = null;
// True once the user drags the WB/tint sliders (set in the input handler),
// cleared by applyOpsToSliders whenever the applied WB is the As-Shot default.
// Gates whether currentOpsFromSliders emits the exact camera gains or the
// slider kelvin/tint.
let wbTouched = false;

// All seven Basic sliders, with their fill-neutral points and readout
// formatters. One array drives the initial paint, applyOpsToSliders, and the
// shared input/change wiring (see wireSliders) -- adding a slider is one
// entry here plus one <input>/<output> pair in index.html.
interface SliderConfig {
  slider: HTMLInputElement;
  output: HTMLOutputElement;
  neutral: number;
  format: (v: number) => string;
}
const ALL_SLIDERS: SliderConfig[] = [
  { slider: exposureSlider, output: exposureValue, neutral: 0, format: (v) => formatSigned(v, 2) },
  { slider: wbSlider, output: wbValue, neutral: kelvinToWbSlider(WB_NEUTRAL_KELVIN), format: (v) => `${wbSliderToKelvin(v)}K` },
  { slider: tintSlider, output: tintValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: contrastSlider, output: contrastValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: highlightsSlider, output: highlightsValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: shadowsSlider, output: shadowsValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: whitesSlider, output: whitesValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: blacksSlider, output: blacksValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: textureSlider, output: textureValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: claritySlider, output: clarityValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: dehazeSlider, output: dehazeValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: vibranceSlider, output: vibranceValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: saturationSlider, output: saturationValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: vignetteAmountSlider, output: vignetteAmountValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: vignetteMidpointSlider, output: vignetteMidpointValue, neutral: 50, format: (v) => formatSigned(v) },
  { slider: vignetteRoundnessSlider, output: vignetteRoundnessValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: vignetteFeatherSlider, output: vignetteFeatherValue, neutral: 50, format: (v) => formatSigned(v) },
  { slider: vignetteHighlightsSlider, output: vignetteHighlightsValue, neutral: 0, format: (v) => formatSigned(v) },
  // B&W mix sliders -- only live while Treatment is Black & White (the bw op
  // is emitted only then), but they share the paint/commit loop like the rest.
  { slider: bwMixSliders.red, output: bwMixValues.red, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.orange, output: bwMixValues.orange, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.yellow, output: bwMixValues.yellow, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.green, output: bwMixValues.green, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.aqua, output: bwMixValues.aqua, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.blue, output: bwMixValues.blue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.purple, output: bwMixValues.purple, neutral: 0, format: (v) => formatSigned(v) },
  { slider: bwMixSliders.magenta, output: bwMixValues.magenta, neutral: 0, format: (v) => formatSigned(v) },
  { slider: regionHighlightsSlider, output: regionHighlightsValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: regionLightsSlider, output: regionLightsValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: regionDarksSlider, output: regionDarksValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: regionShadowsSlider, output: regionShadowsValue, neutral: 0, format: (v) => formatSigned(v) },
];

function paintSliders(): void {
  for (const cfg of ALL_SLIDERS) {
    updateSliderFill(cfg.slider, cfg.neutral);
    cfg.output.textContent = cfg.format(Number(cfg.slider.value));
  }
}

// --- Tone curve editor state. Two modes behind the "Adjust:" dropdown:
// Region (LrC's default -- four parametric sliders) and Point (the direct
// curve). The point curve is a flat [x0,y0,x1,y1,...] list in [0,1]; the
// default linear curve is omitted from ops (identity LUT, no pass).
let curvePoints: number[] = [0, 0, 1, 1];

interface RegionParams { highlights: number; lights: number; darks: number; shadows: number; }

function isRegionMode(): boolean {
  return curveAdjust.value === 'region';
}

function readRegionParams(): RegionParams {
  return {
    highlights: Number(regionHighlightsSlider.value),
    lights: Number(regionLightsSlider.value),
    darks: Number(regionDarksSlider.value),
    shadows: Number(regionShadowsSlider.value),
  };
}

function isNeutralRegion(r: RegionParams): boolean {
  return r.highlights === 0 && r.lights === 0 && r.darks === 0 && r.shadows === 0;
}

// The curve is "no edit" when every point sits on the diagonal -- including
// the region mode's neutral 6-point set (once region sliders sync into
// curvePoints), so a neutral region doesn't emit a phantom point op after a
// mode switch.
function isLinearCurve(): boolean {
  for (let i = 0; i < curvePoints.length; i += 2) {
    if (Math.abs(curvePoints[i + 1] - curvePoints[i]) > 1e-6) return false;
  }
  return true;
}

// Region <-> Point are ONE shared curve (like LrC's Tone Curve): the four
// region sliders and the draggable points are two handles on the same value.
// Region edits regenerate the point curve; point drags re-fit the sliders.
function syncRegionToPoints(): void {
  const r = readRegionParams();
  curvePoints = parametricControlPoints(r.highlights, r.lights, r.darks, r.shadows);
}

function syncPointsToRegion(): void {
  const r = fitRegionParams(curvePoints);
  regionHighlightsSlider.value = String(r.highlights);
  regionLightsSlider.value = String(r.lights);
  regionDarksSlider.value = String(r.darks);
  regionShadowsSlider.value = String(r.shadows);
  paintSliders();
}

// Which LUT + control points the active mode currently produces -- shared by
// drawCurve (what the user sees) and the op chain (what the GPU applies).
function activeCurve(): { lut: Float32Array; controls: number[] } {
  if (isRegionMode()) {
    const r = readRegionParams();
    return { lut: buildParametricToneLut(r.highlights, r.lights, r.darks, r.shadows), controls: parametricControlPoints(r.highlights, r.lights, r.darks, r.shadows) };
  }
  return { lut: buildToneCurveLut(curvePoints), controls: curvePoints };
}

// Renders the curve the GPU will actually apply: the grid, the identity
// diagonal, the sampled PCHIP LUT polyline, and the control points.
function drawCurve(): void {
  const w = curveCanvas.width;
  const h = curveCanvas.height;
  const ctx = curveCtx;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#3a3a40';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) {
    ctx.moveTo((i / 10) * w, 0); ctx.lineTo((i / 10) * w, h);
    ctx.moveTo(0, (i / 10) * h); ctx.lineTo(w, (i / 10) * h);
  }
  ctx.stroke();

  ctx.strokeStyle = '#4a4a52';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
  ctx.setLineDash([]);

  const { lut, controls } = activeCurve();
  ctx.strokeStyle = '#6ab0f3';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    const x = (i / (TONE_LUT_SIZE - 1)) * w;
    const y = h - lut[i] * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#fff';
  for (let i = 0; i < controls.length; i += 2) {
    ctx.beginPath();
    ctx.arc(controls[i] * w, h - controls[i + 1] * h, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6ab0f3';
    ctx.stroke();
  }
}

// Shows the active "Adjust:" mode -- region sliders vs the point-curve canvas.
function syncCurveMode(): void {
  const region = isRegionMode();
  curveRegion.hidden = !region;
  curvePoint.hidden = region;
}

function curvePointFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = curveCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)),
  };
}

// Flat x-index of the control point nearest (x,y), or -1 when none is within
// reach. Threshold is in curve units (~6% of the canvas).
function nearestCurvePoint(x: number, y: number): number {
  let best = -1;
  let bestDist = 0.06;
  for (let i = 0; i < curvePoints.length; i += 2) {
    const d = Math.hypot(curvePoints[i] - x, curvePoints[i + 1] - y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Clamps x to [0,1], nudging it clear of any other point's x so a drag can't
// stack duplicates (buildToneCurveLut would silently drop one).
function clampCurveX(x: number, exclude: number): number {
  let best = Math.min(1, Math.max(0, x));
  for (let i = 0; i < curvePoints.length; i += 2) {
    if (i === exclude) continue;
    const other = curvePoints[i];
    if (Math.abs(best - other) < 0.02) {
      best = Math.min(1, Math.max(0, other + (best >= other ? 0.02 : -0.02)));
    }
  }
  return best;
}

function readToneParams(): ToneParams {
  return {
    contrast: Number(contrastSlider.value),
    highlights: Number(highlightsSlider.value),
    shadows: Number(shadowsSlider.value),
    whites: Number(whitesSlider.value),
    blacks: Number(blacksSlider.value),
  };
}

function readPresenceParams(): PresenceParams {
  return {
    texture: Number(textureSlider.value),
    clarity: Number(claritySlider.value),
    dehaze: Number(dehazeSlider.value),
    vibrance: Number(vibranceSlider.value),
    saturation: Number(saturationSlider.value),
  };
}

function readVignetteParams(): VignetteParams {
  return {
    amount: Number(vignetteAmountSlider.value),
    midpoint: Number(vignetteMidpointSlider.value),
    roundness: Number(vignetteRoundnessSlider.value),
    feather: Number(vignetteFeatherSlider.value),
    highlights: Number(vignetteHighlightsSlider.value),
  };
}

// B&W treatment. The mix tuple is in RGB order (Red..Magenta), matching both
// the bw op's BwMix and the shader's band array.
function readBwMix(): BwMix {
  const keys = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
  return keys.map((k) => Number(bwMixSliders[k].value)) as unknown as BwMix;
}

function isBwEnabled(): boolean {
  return bwTreatmentSelect.value === 'bw';
}

// Hides/grays the B&W mix + filter + tone controls unless Treatment is B&W.
function syncBwEnabled(): void {
  const on = isBwEnabled();
  // The whole B&W section (mix/filter/tone) disappears in Color mode; the
  // treatment choice itself now lives up in the Profile panel.
  bwSection.hidden = !on;
  bwControls.hidden = !on;
  bwFilterSelect.disabled = !on;
  bwToneSelect.disabled = !on;
  for (const k in bwMixSliders) bwMixSliders[k as keyof typeof bwMixSliders].disabled = !on;
}

function currentOpsFromSliders(): Op[] {
  // As-Shot: while the WB/tint sliders are untouched, the exact camera gains
  // are preserved (kelvin+tint can't represent an arbitrary cam_mul). Once the
  // user drags (wbTouched), the slider kelvin/tint is authoritative.
  const wb: Op = wbTouched || !asShotWB
    ? { kind: 'whiteBalance', kelvin: wbSliderToKelvin(Number(wbSlider.value)), tint: Number(tintSlider.value) }
    : { kind: 'whiteBalance', ...asShotWB };
  const ops: Op[] = [
    { kind: 'profile', profile: profileSelect.value as ProfileKind },
    { kind: 'exposure', ev: Number(exposureSlider.value) },
    wb,
  ];
  // The parametric tone op is emitted only when non-neutral, so an all-
  // neutral state renders as exposure+WB (no extra LUT pass) and history
  // rows don't carry a do-nothing op.
  const tone = readToneParams();
  if (!isNeutralTone(tone)) ops.push({ kind: 'tone', ...tone });
  if (isRegionMode()) {
    const region = readRegionParams();
    if (!isNeutralRegion(region)) ops.push({ kind: 'toneCurve', mode: 'region', ...region });
  } else if (!isLinearCurve()) {
    ops.push({ kind: 'toneCurve', mode: 'point', points: [...curvePoints] });
  }
  const presence = readPresenceParams();
  if (!isNeutralPresence(presence)) ops.push({ kind: 'presence', ...presence });
  // Vignette is emitted only when the amount is non-zero (the midpoint/
  // roundness/feather/highlights sliders do nothing on their own) -- a
  // neutral state renders without an extra full-res pass, like presence.
  const vignette = readVignetteParams();
  if (!isNeutralVignette(vignette)) ops.push({ kind: 'vignette', ...vignette });
  // B&W treatment is a mode switch, not a slider: emit the op only while
  // Treatment = Black & White. Even a fully-neutral mix+tone is still a real
  // edit (Color -> B&W conversion), so it always emits when enabled.
  if (isBwEnabled()) {
    ops.push({ kind: 'bw', mix: readBwMix(), tone: bwToneSelect.value as BwToneId });
  }
  return ops;
}

function applyOpsToSliders(ops: Op[]): void {
  const profileOp = ops.find(isProfileOp);
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  const toneOp = ops.find(isToneOp);
  const curveOp = ops.find(isToneCurveOp);
  const presenceOp = ops.find(isPresenceOp);
  const vignetteOp = ops.find(isVignetteOp);
  const bwOp = ops.find(isBwOp);
  profileSelect.value = profileOp?.profile ?? 'camera';
  exposureSlider.value = String(exposureOp?.ev ?? 0);
  // WB slider is a kelvin track, but the applied white point may be an exact
  // As-Shot gains pair (a cam_mul can't round-trip through kelvin+tint). An
  // As-Shot op shows its readout and keeps wbTouched false so
  // currentOpsFromSliders preserves the exact gains; a manual op (no gains) is
  // the slider values themselves; no op at all falls back to the file's
  // As-Shot (neutral daylight when the camera reports none).
  if (wbOp?.gains) {
    wbSlider.value = String(kelvinToWbSlider(gainsToKelvin(wbOp.gains, getCameraXyz())));
    tintSlider.value = String(wbOp.tint ?? gainsToTint(wbOp.gains, getCameraXyz()));
    wbTouched = false;
  } else if (wbOp) {
    wbSlider.value = String(kelvinToWbSlider(wbOp.kelvin));
    tintSlider.value = String(wbOp.tint ?? 0);
    wbTouched = true;
  } else {
    wbSlider.value = String(kelvinToWbSlider(asShotWB?.kelvin ?? WB_NEUTRAL_KELVIN));
    tintSlider.value = String(asShotWB?.tint ?? 0);
    wbTouched = false;
  }
  contrastSlider.value = String(toneOp?.contrast ?? 0);
  highlightsSlider.value = String(toneOp?.highlights ?? 0);
  shadowsSlider.value = String(toneOp?.shadows ?? 0);
  whitesSlider.value = String(toneOp?.whites ?? 0);
  blacksSlider.value = String(toneOp?.blacks ?? 0);
  textureSlider.value = String(presenceOp?.texture ?? 0);
  claritySlider.value = String(presenceOp?.clarity ?? 0);
  dehazeSlider.value = String(presenceOp?.dehaze ?? 0);
  vibranceSlider.value = String(presenceOp?.vibrance ?? 0);
  saturationSlider.value = String(presenceOp?.saturation ?? 0);
  // Vignette: LrC's neutral defaults are midpoint 50 / feather 50 (amount 0
  // off), so an absent op restores those, not zero, so the fill-from-zero
  // track reads right on a fresh open.
  vignetteAmountSlider.value = String(vignetteOp?.amount ?? 0);
  vignetteMidpointSlider.value = String(vignetteOp?.midpoint ?? 50);
  vignetteRoundnessSlider.value = String(vignetteOp?.roundness ?? 0);
  vignetteFeatherSlider.value = String(vignetteOp?.feather ?? 50);
  vignetteHighlightsSlider.value = String(vignetteOp?.highlights ?? 0);
  // B&W: the op's presence IS the treatment (no bw op = Color). Mix sliders
  // restore to the op's 8 weights (0 = that hue contributes normal luminance);
  // a neutral op is a plain desaturation and restores the filter to None.
  bwTreatmentSelect.value = bwOp ? 'bw' : 'color';
  const keys = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
  for (let i = 0; i < keys.length; i++) bwMixSliders[keys[i]].value = String(bwOp?.mix[i] ?? 0);
  bwToneSelect.value = bwOp?.tone ?? 'none';
  syncBwEnabled();
  // Tone curve: restore the stored mode. Region and Point are one shared
  // curve, so either op shape restores BOTH handles: a region op regenerates
  // the point curve from its sliders; a point op (including pre-region legacy
  // rows, which have no `mode`) sets the points and re-fits the sliders. No
  // stored curve -> LrC's default (region, neutral).
  const curveMode = curveOp ? (curveOp.mode ?? 'point') : 'region';
  curveAdjust.value = curveMode;
  if (curveOp && curveOp.mode === 'region') {
    regionHighlightsSlider.value = String(curveOp.highlights);
    regionLightsSlider.value = String(curveOp.lights);
    regionDarksSlider.value = String(curveOp.darks);
    regionShadowsSlider.value = String(curveOp.shadows);
    curvePoints = parametricControlPoints(curveOp.highlights, curveOp.lights, curveOp.darks, curveOp.shadows);
  } else if (curveOp) {
    curvePoints = [...curveOp.points];
    syncPointsToRegion();
  } else {
    regionHighlightsSlider.value = '0';
    regionLightsSlider.value = '0';
    regionDarksSlider.value = '0';
    regionShadowsSlider.value = '0';
    curvePoints = [0, 0, 1, 1];
  }
  syncCurveMode();
  paintSliders();
  drawCurve();
}

syncCurveMode();
paintSliders();
drawCurve();

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
      if (isProfileOp(op)) return op.profile === 'neutral' ? 'Neutral profile' : op.profile === 'camera' ? 'Camera profile' : FILM_STOCKS[op.profile].name;
      if (isExposureOp(op)) return `Exposure ${op.ev >= 0 ? '+' : ''}${op.ev.toFixed(2)}`;
      if (isWhiteBalanceOp(op)) {
        return op.gains
          ? `WB As Shot${op.tint ? ` · Tint ${formatSigned(op.tint)}` : ''}`
          : `WB ${op.kelvin}K${op.tint ? ` · Tint ${formatSigned(op.tint)}` : ''}`;
      }
      if (isToneOp(op)) {
        const parts: string[] = [];
        if (op.contrast !== 0) parts.push(`Contrast ${formatSigned(op.contrast)}`);
        if (op.highlights !== 0) parts.push(`Highlights ${formatSigned(op.highlights)}`);
        if (op.shadows !== 0) parts.push(`Shadows ${formatSigned(op.shadows)}`);
        if (op.whites !== 0) parts.push(`Whites ${formatSigned(op.whites)}`);
        if (op.blacks !== 0) parts.push(`Blacks ${formatSigned(op.blacks)}`);
        return parts.join(' · ');
      }
      if (isToneCurveOp(op)) {
        if (op.mode === 'region') {
          const parts: string[] = [];
          if (op.highlights !== 0) parts.push(`H ${formatSigned(op.highlights)}`);
          if (op.lights !== 0) parts.push(`L ${formatSigned(op.lights)}`);
          if (op.darks !== 0) parts.push(`D ${formatSigned(op.darks)}`);
          if (op.shadows !== 0) parts.push(`S ${formatSigned(op.shadows)}`);
          return `Curve ${parts.join(' · ')}`;
        }
        return `Curve (${op.points.length / 2} pts)`;
      }
      if (isPresenceOp(op)) {
        const parts: string[] = [];
        if (op.texture !== 0) parts.push(`Texture ${formatSigned(op.texture)}`);
        if (op.clarity !== 0) parts.push(`Clarity ${formatSigned(op.clarity)}`);
        if (op.dehaze !== 0) parts.push(`Dehaze ${formatSigned(op.dehaze)}`);
        if (op.vibrance !== 0) parts.push(`Vibrance ${formatSigned(op.vibrance)}`);
        if (op.saturation !== 0) parts.push(`Saturation ${formatSigned(op.saturation)}`);
        return parts.join(' · ');
      }
      if (isVignetteOp(op)) {
        return `Vignette ${formatSigned(op.amount)}`;
      }
      if (isBwOp(op)) {
        const tone = op.tone !== 'none' ? ` · ${BW_TONES[op.tone].name}` : '';
        return `B&W${tone}`;
      }
      return 'Unknown';
    })
    .join(' · ');
}

// Applying a preset merges, never replaces: ops whose kind the preset doesn't
// cover stay as they are, and the preset's ops win for the kinds it does
// cover. So a "contrast+curve" preset leaves your exposure untouched.
function mergePresetOps(current: Op[], preset: Op[]): Op[] {
  const presetKinds = new Set(preset.map((o) => o.kind));
  return [...current.filter((o) => !presetKinds.has(o.kind)), ...preset];
}

// LrC-style histogram: R/G/B as translucent filled curves (overlaps show as
// yellow/cyan/magenta), luminance as a white outline on top. `data` is the
// 512x256 rgba8unorm readback -- already sRGB-encoded, i.e. display-referred
// like Lightroom's. One bin per pixel column of the 256-wide canvas.
const LUMA_COEF = [0.2126729, 0.7151522, 0.0721750];

function drawHistogram(data: Uint8Array): void {
  const W = histogramCanvas.width; // 256
  const H = histogramCanvas.height; // 110
  const counts = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const luma = Math.round(LUMA_COEF[0] * r + LUMA_COEF[1] * g + LUMA_COEF[2] * b);
    counts[0][Math.min(255, r)]++;
    counts[1][Math.min(255, g)]++;
    counts[2][Math.min(255, b)]++;
    counts[3][Math.min(255, luma)]++;
  }
  const ctx = histogramCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1;
  const colors = ['rgba(235,70,55,0.5)', 'rgba(70,205,100,0.5)', 'rgba(80,115,235,0.5)'];
  for (let ch = 0; ch < 4; ch++) {
    let max = 0;
    for (let i = 0; i < 256; i++) if (counts[ch][i] > max) max = counts[ch][i];
    if (max === 0) continue;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = i + 0.5;
      const y = H - (counts[ch][i] / max) * (H - 3) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (ch < 3) {
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fillStyle = colors[ch];
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
    }
  }
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

  // Histogram follows the edited image: each render()'s blit also captures a
  // 512x256 nearest-sampled copy of displayTexture (see pipeline.ts), and the
  // readback lands here as soon as it maps -- throttled by the one-in-flight
  // gate, so the slider hot path never waits on it.
  pipeline.setHistogramListener(drawHistogram);

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;
  let lastDecoded: { width: number; height: number; cameraMeta: CameraMeta | null } | null = null;
  // Embedded-JPEG preview fallback (Develop loupe): WebGPU and 2D can't
  // share one canvas, so when a raw can't be decoded the camera's embedded
  // JPEG renders through an absolutely-positioned <img> layered over #canvas
  // (the develop .content region is position:relative). Pipeline paths hide
  // it; the fallback shows it.
  const previewImg = document.createElement('img');
  previewImg.className = 'preview-overlay';
  previewImg.hidden = true;
  const previewNote = document.createElement('div');
  previewNote.className = 'preview-note';
  previewNote.textContent =
    'Preview only — this file’s raw format isn’t supported yet. Exposure/WB can’t be adjusted on a preview.';
  previewNote.hidden = true;
  document.querySelector<HTMLElement>('#module-develop .content')!.append(previewImg, previewNote);
  // Which file's Bayer data currently lives in the GPU pipeline. Selecting a
  // file in Library no longer decodes it (decode is deferred to Develop
  // entry), so this is how Develop knows whether it needs to decode first or
  // can just re-render from the existing textures.
  let loadedFileId: number | null = null;
  let openRequestId = 0;
  // Coalesces concurrent loadIntoPipeline() calls for the same selection into
  // one LibRaw decode. The develop onShow path (ensureDevelopImage) and the
  // click path (openFile) can both fire for a single selection; without this,
  // both see loadedFileId !== record.id and both run the ~3s decode.
  let inflightDecode: { id: number; requestId: number; promise: Promise<boolean> } | null = null;
  let folders: FolderRecord[] = [];
  let allFiles: FileRecord[] = [];
  let folderFilter: number | null = null;
  let gridEntries: GridEntry[] = [];

  // Culling filter state. Filtering is grid-only: allFiles (filmstrip + arrow
  // navigation) is always unfiltered, Lightroom-style.
  let cullFilter = { hideRejected: true, pickedOnly: false, minRating: 0 };

  function matchesCullFilter(f: FileRecord): boolean {
    if (cullFilter.hideRejected && f.flag === false) return false;
    if (cullFilter.pickedOnly && f.flag !== true) return false;
    if (cullFilter.minRating > 0 && (f.rating ?? 0) < cullFilter.minRating) return false;
    return true;
  }

  // Re-chunks allFiles into grid entries honoring folderFilter + cullFilter,
  // then repaints. Called after a filter change or a cull keypress (which
  // mutates allFiles in place); keeps the DB out of the hot path.
  function rebuildGrid(): void {
    gridEntries = [];
    for (const folder of folders) {
      if (folderFilter !== null && folder.id !== folderFilter) continue;
      const visible = allFiles.filter((f) => f.folderId === folder.id && matchesCullFilter(f));
      gridEntries.push({ kind: 'heading', folderName: folder.name });
      for (const row of chunkIntoRows(visible)) {
        gridEntries.push({ kind: 'row', files: row });
      }
    }
    virtualizer.setOptions({ ...virtualizer.options, count: gridEntries.length });
    virtualizer.measure();
    renderVisibleRows();
    updateFooter();
  }

  // Multi-selection: the anchor for shift+click range selection. Plain clicks
  // and keyboard navigation (selectFile) collapse selection to one file, so the
  // anchor is only ever read after a ctrl/cmd or shift click set it.
  let selectionAnchor: number | null = null;

  // Folder-ordered ids for shift+click range selection (the grid's reading
  // order; cull filters don't apply -- LrC ranges over the source).
  function orderedVisibleIds(): number[] {
    return allFiles.filter((f) => folderFilter === null || f.folderId === folderFilter).map((f) => f.id);
  }

  // Applies a rating to the whole selection (star-strip click / number key).
  // Clicking the current rating again clears it. No selection = the clicked
  // file only.
  async function rateFile(reference: FileRecord, rating: number): Promise<void> {
    const { selectedIds } = getState();
    const targets = selectedIds.length ? selectedIds : [reference.id];
    try {
      for (const id of targets) {
        const record = allFiles.find((f) => f.id === id);
        if (!record) continue;
        const patch = record.rating === rating ? { rating: 0 } : { rating };
        Object.assign(record, await setCull(db, id, patch));
      }
      rebuildGrid();
    } catch (err) {
      showError("Couldn't save the rating.", errorDetail(err));
    }
  }

  // Star-chip tooltips carry the per-rating counts; the footer shows the total
  // in the current folder. Re-run on folder/filter/cull changes (rebuildGrid).
  function updateFooter(): void {
    const scope = allFiles.filter((f) => folderFilter === null || f.folderId === folderFilter);
    const counts = [0, 0, 0, 0, 0, 0];
    for (const f of scope) counts[f.rating ?? 0]++;
    footerFilterButtons.forEach((btn) => {
      const min = Number(btn.dataset.minrating);
      const n = min === 0 ? scope.length : counts.slice(min).reduce((a, b) => a + b, 0);
      btn.title = `${min === 0 ? 'Show all' : `Show ${min}★ and up`} -- ${n} photo${n === 1 ? '' : 's'}`;
    });
    footerCounts.textContent = `${scope.length} photo${scope.length === 1 ? '' : 's'}`;
  }

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
    pipeline.render(ops);
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
        cell.className = 'catalog-cell' + (getState().selectedIds.includes(file.id) ? ' selected' : '');
        cell.dataset.fileId = String(file.id); // lets selection paint in place (see the selection subscribe)
        cell.title = file.path;
        // Selection: plain click opens (single-selects), ctrl/cmd+click toggles
        // into the multi-selection, shift+click ranges from the anchor -- the
        // LrC grid gestures. The last-clicked cell is the sync reference.
        cell.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const { selectedIds } = getState();
            const adding = !selectedIds.includes(file.id);
            const next = adding ? [...selectedIds, file.id] : selectedIds.filter((id) => id !== file.id);
            selectionAnchor = file.id;
            // Reference = the last-clicked cell when it's in the set, otherwise
            // the last remaining id (deselecting the reference moves sync on).
            setSelection(next, adding ? file.id : next[next.length - 1] ?? null);
            return;
          }
          if (e.shiftKey) {
            e.preventDefault();
            const base = selectionAnchor ?? getState().selectedId ?? file.id;
            const ids = orderedVisibleIds();
            const a = ids.indexOf(base);
            const b = ids.indexOf(file.id);
            if (a >= 0 && b >= 0) {
              selectionAnchor = file.id;
              setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1), file.id);
            }
            return;
          }
          selectionAnchor = file.id;
          openFile(file);
        });
        cell.addEventListener('dblclick', () => switchModule('develop'));
        // Cull badges: reject/pick in the corner, clickable rating stars at the
        // foot (star N sets the rating, clicking the current rating clears it;
        // with a multi-selection the rating applies to every selected photo),
        // color as a left edge bar.
        if (file.flag === false) {
          const b = document.createElement('span');
          b.className = 'cell-badge cell-badge-reject';
          b.textContent = '✕';
          cell.appendChild(b);
        } else if (file.flag === true) {
          const b = document.createElement('span');
          b.className = 'cell-badge cell-badge-pick';
          b.textContent = '✓';
          cell.appendChild(b);
        }
        const stars = document.createElement('div');
        stars.className = 'cell-stars';
        for (let n = 1; n <= 5; n++) {
          const s = document.createElement('span');
          s.className = 'cell-star' + (n <= (file.rating ?? 0) ? ' on' : '');
          s.textContent = '★';
          s.title = `${n}★ (applies to the whole selection)`;
          s.addEventListener('click', (e) => {
            e.stopPropagation(); // rating a photo is not opening it
            void rateFile(file, n);
          });
          stars.appendChild(s);
        }
        cell.appendChild(stars);
        if (file.color) {
          const c = document.createElement('span');
          c.className = `cell-color cell-color-${file.color}`;
          cell.appendChild(c);
        }
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

  // Rebuilds the flattened catalog (folders, allFiles) from the database,
  // honoring folderFilter, then refreshes grid, folder list, and filmstrip.
  // Called on import and on folder-filter clicks; filter changes and cull
  // keypresses go through rebuildGrid() instead (no DB re-query).
  async function renderCatalog(): Promise<void> {
    folders = await listFolders(db);
    allFiles = [];
    for (const folder of folders) {
      if (folderFilter !== null && folder.id !== folderFilter) continue;
      allFiles.push(...(await listFiles(db, folder.id)));
    }
    rebuildGrid();
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

  // LrC-style shooting-info line at the top of the Develop panel:
  // "SO 320 · 23 mm · f/2.8 · 1/140 sec". Only reported values appear (0 =
  // not reported by the file). Shutter < 1s renders as the reciprocal
  // fraction LrC uses; >= 1s as seconds.
  function renderCameraInfo(): void {
    cameraInfoEl.textContent = '';
    const meta = lastDecoded?.cameraMeta;
    if (!meta || (meta.iso === 0 && meta.shutter === 0 && meta.aperture === 0 && meta.focal === 0)) return;
    const parts: string[] = [];
    if (meta.iso > 0) parts.push(`SO ${Math.round(meta.iso)}`);
    if (meta.focal > 0) parts.push(`${Number.isInteger(meta.focal) ? meta.focal : meta.focal.toFixed(1)} mm`);
    if (meta.aperture > 0) parts.push(`f/${meta.aperture.toFixed(1)}`);
    if (meta.shutter > 0) {
      parts.push(meta.shutter < 1 ? `1/${Math.round(1 / meta.shutter)} sec` : `${meta.shutter.toFixed(1)} sec`);
    }
    // wb-diag (temporary): surface the As-Shot WB gains the readout decomposes,
    // so a readout-vs-LrC mismatch can be re-fit without opening DevTools.
    if (asShotWB) {
      parts.push(`WB R${asShotWB.gains.r.toFixed(2)} G${asShotWB.gains.g.toFixed(2)} B${asShotWB.gains.b.toFixed(2)}`);
    }
    cameraInfoEl.textContent = parts.join(' · ');
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
    // Temporary perf probe (click-jank investigation): every selection
    // synchronously notifies subscribers -- the filmstrip scrolls the
    // selected cell into view and re-renders its visible cells. Log how long
    // that sync block takes so the jank can be attributed or ruled out.
    const selStart = performance.now();
    selectFile(record.id);
    console.log(`[app] selectFile sync block: ${(performance.now() - selStart).toFixed(1)}ms`);
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

      const editState = await loadEditState(db, record.id);
      if (requestId !== openRequestId) return; // superseded while loading edit state

      currentFileId = record.id;
      currentEditState = editState;
      const ops = currentOps(editState);
      applyOpsToSliders(ops);

      // The full raw decode is the slow synchronous LibRaw step (~1.6s), so
      // it runs only when the image is about to be shown -- i.e. the loupe is
      // already on screen. A Library grid click just selects: culling stays
      // responsive, and Develop entry (onShow) decodes on demand. When we
      // skip the decode, lastDecoded is cleared so metadata can't show a
      // previous file's dimensions.
      if (getState().module === 'develop') {
        const ok = await loadIntoPipeline(record, requestId);
        if (ok) {
          // loadIntoPipeline just set asShotWB from the decoded camera WB --
          // re-apply so the WB slider shows the As-Shot readout (kelvin/tint)
          // before the first render, for a fresh file.
          applyOpsToSliders(currentOps(currentEditState));
          renderOps(currentOps(currentEditState));
        }
      } else {
        lastDecoded = null;
      }
      renderMetadata();
      renderCameraInfo();
      renderHistory();
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }
  }

  // Re-enables the adjust sliders when real (decoded) Bayer data takes over.
  // While a preview is showing they're disabled, so the UI doesn't offer an
  // adjustment that can't do anything.
  function setAdjustEnabled(enabled: boolean): void {
    for (const cfg of ALL_SLIDERS) cfg.slider.disabled = !enabled;
    profileSelect.disabled = !enabled;
    bwTreatmentSelect.disabled = !enabled;
    syncBwEnabled();
    curveAdjust.disabled = !enabled;
    curveCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
    curveResetButton.disabled = !enabled;
  }

  function hidePreview(): void {
    previewImg.hidden = true;
    previewNote.hidden = true;
    previewImg.removeAttribute('src');
    setAdjustEnabled(true);
  }

  // Shows a file's embedded JPEG in the preview overlay. Resolves with the
  // preview's pixel dimensions on success, or false if the file has no
  // usable embedded JPEG (caller falls through to the error toast). The
  // requestId check in the load handler keeps a stale (superseded) preview
  // from clobbering a newer selection's image on a slow JPEG decode.
  function showPreview(record: FileRecord, fileBytes: ArrayBuffer, requestId: number): Promise<false | { width: number; height: number }> {
    return extractThumbnail(fileBytes)
      .then(
        (blob) =>
          new Promise<false | { width: number; height: number }>((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            previewImg.addEventListener(
              'load',
              () => {
                if (requestId !== openRequestId) {
                  URL.revokeObjectURL(url);
                  previewImg.removeAttribute('src');
                  resolve(false); // superseded mid-load
                  return;
                }
                previewImg.hidden = false;
                previewNote.hidden = false;
                setAdjustEnabled(false); // sliders can't touch a preview -- don't offer what won't work
                const dims = { width: previewImg.naturalWidth, height: previewImg.naturalHeight };
                URL.revokeObjectURL(url);
                resolve(dims);
              },
              { once: true },
            );
            previewImg.addEventListener(
              'error',
              () => {
                URL.revokeObjectURL(url);
                reject(new Error(`embedded preview decode failed for ${record.name}`));
              },
              { once: true },
            );
            previewImg.src = url;
          }),
      )
      .catch(() => false); // extraction failed (no embedded JPEG) or preview decode failed
  }

  // Decodes `record` (LibRaw -- the slow synchronous step), sizes the canvas,
  // and uploads the Bayer data to the GPU. Callers own the render. Returns
  // false if a newer selection superseded this one mid-decode.
  async function loadIntoPipeline(record: FileRecord, requestId: number): Promise<boolean> {
    // Already showing this file (re-clicking the current photo, or clicking
    // back to one that's loaded) -- nothing to decode; the pipeline holds the
    // Bayer data. This is what keeps filmstrip clicking in Develop fast
    // instead of re-running the ~3s LibRaw decode on every click.
    if (loadedFileId === record.id) return true;
    // Same selection already decoding (e.g. onShow's ensureDevelopImage raced
    // with the click's openFile, both with this requestId) -- share it.
    if (inflightDecode && inflightDecode.id === record.id && inflightDecode.requestId === requestId) {
      return inflightDecode.promise;
    }
    const start = performance.now();
    const promise = (async () => {
      const file = await record.handle.getFile();
      const fileBytes = await file.arrayBuffer();
      if (requestId !== openRequestId) return false; // superseded during file read
      let decoded: DecodedRaw;
      try {
        decoded = await decode(fileBytes);
      } catch (err) {
        // Raw decode failed OR returned garbage (wrapper reports -1004 when
        // LibRaw's error_count() exceeds ~1% of the frame -- see wrapper.cpp;
        // Nikon HE* is the case that surfaced this). Show the camera's
        // embedded JPEG instead of an error toast or streaks; the exposure/WB
        // sliders correctly do nothing for a preview (the pipeline has no
        // textures loaded).
        if (err instanceof DecodeError) {
          const dims = await showPreview(record, fileBytes, requestId);
          if (requestId !== openRequestId) return false; // superseded during preview extract
          if (dims) {
            loadedFileId = record.id;
            lastDecoded = { width: dims.width, height: dims.height, cameraMeta: null };
            asShotWB = null; // no raw camera data behind a preview
            canvas.width = dims.width;
            canvas.height = dims.height;
            console.log(`decode failed (LibRaw ${err.code}), showing embedded preview (${dims.width}x${dims.height})`);
            return true;
          }
        }
        throw err; // not a DecodeError, or no embedded JPEG -- let caller show the error
      }
      if (requestId !== openRequestId) return false; // superseded during decode
      hidePreview();
      canvas.width = decoded.effectiveWidth ?? decoded.width;
      canvas.height = decoded.effectiveHeight ?? decoded.height;
      // Re-create the WebGPU surface at the just-set size. Chrome 151 ties the
      // drawing buffer to the canvas size at configure() time -- a configure
      // left over from a different-size file would leave the blit target
      // mismatched with the loaded image.
      pipeline.show();
      pipeline.load(decoded);
      // The fresh (no-WB-op) default renders at the camera's As-Shot gains;
      // the WB slider readout is derived from them (kelvin/tint).
      if (decoded.asShotGains) {
        asShotWB = {
          gains: decoded.asShotGains,
          kelvin: gainsToKelvin(decoded.asShotGains, decoded.camXyz),
          tint: gainsToTint(decoded.asShotGains, decoded.camXyz),
        };
        // wb-diag: the browser's actual readout inputs at fresh open -- paste
        // this line when the displayed temp/tint disagrees with LrC, so the
        // calibration offsets can be re-fit against the real file (gains +
        // camXyz -> the un-offset Robertson decomposition; readout = the
        // displayed value through the current offsets).
        console.log(
          `[wb-diag] gains=${decoded.asShotGains.r.toFixed(6)}/${decoded.asShotGains.g.toFixed(6)}/${decoded.asShotGains.b.toFixed(6)}` +
            ` camXyz=[${decoded.camXyz ? Array.from(decoded.camXyz).map((v) => v.toFixed(5)).join(',') : 'none'}]` +
            ` readout=${asShotWB.kelvin.toFixed(1)}K/${asShotWB.tint.toFixed(1)}`,
        );
      } else {
        asShotWB = null;
      }
      loadedFileId = record.id;
      lastDecoded = { width: decoded.effectiveWidth ?? decoded.width, height: decoded.effectiveHeight ?? decoded.height, cameraMeta: decoded.cameraMeta };
      // waitForGPU() is awaited only for the perf log below -- it doesn't gate
      // anything, since nothing after it touches shared state.
      await pipeline.waitForGPU();
      console.log(`decode+demosaic: ${(performance.now() - start).toFixed(1)}ms (${decoded.width}x${decoded.height})`);
      return true;
    })();
    inflightDecode = { id: record.id, requestId, promise };
    try {
      return await promise;
    } finally {
      if (inflightDecode?.id === record.id && inflightDecode.requestId === requestId) inflightDecode = null;
    }
  }

  // Decodes + loads the current selection if its Bayer data isn't already in
  // the pipeline. Called on Develop entry for a file that was selected from
  // Library (which no longer decodes eagerly).
  async function ensureDevelopImage(): Promise<void> {
    if (loadedFileId === currentFileId) return;
    const record = allFiles.find((f) => f.id === currentFileId);
    if (!record) return;
    try {
      await loadIntoPipeline(record, openRequestId);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }
  }

  // Live preview during a drag must never queue renders behind each other --
  // a fast drag over a slow op (the presence box kernels) would stack full
  // frames on the GPU and the thumb visibly lags the mouse. Latest-wins: one
  // render in flight; any input during it marks pending and re-renders once
  // it lands, so the preview always shows the newest slider position.
  let liveRenderInFlight = false;
  let liveRenderPending = false;
  async function onSliderInput(): Promise<void> {
    if (currentFileId === null) return;
    if (liveRenderInFlight) {
      liveRenderPending = true;
      return;
    }
    liveRenderInFlight = true;
    do {
      liveRenderPending = false;
      const start = performance.now();
      renderOps(currentOpsFromSliders());
      await pipeline.waitForGPU();
      console.log(`slider->frame: ${(performance.now() - start).toFixed(1)}ms`);
    } while (liveRenderPending);
    liveRenderInFlight = false;
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

  // All seven sliders share the same live-update (input) and
  // commit-on-release (change) path; paintSliders() repaints fill + readout
  // for whichever one moved.
  for (const cfg of ALL_SLIDERS) {
    cfg.slider.addEventListener('input', () => {
      // Dragging WB/tint exits the As-Shot default: from here on the slider
      // kelvin/tint is authoritative (exact camera gains stop being emitted).
      if (cfg.slider === wbSlider || cfg.slider === tintSlider) wbTouched = true;
      paintSliders();
      onSliderInput();
    });
    cfg.slider.addEventListener('change', () => {
      commitCurrentEdit();
    });
  }

  // Region sliders share the curve with the point editor: every region input
  // regenerates the point curve, so switching to Point shows exactly the
  // region shape (LrC's Tone Curve is one value, two handles).
  for (const cfg of [regionHighlightsSlider, regionLightsSlider, regionDarksSlider, regionShadowsSlider]) {
    cfg.addEventListener('input', syncRegionToPoints);
  }

  // Profile is a discrete pick, not a drag -- one render + one history
  // commit per change.
  profileSelect.addEventListener('change', () => {
    onSliderInput();
    commitCurrentEdit();
  });

  // B&W treatment is a discrete mode switch like profile: toggle the mix
  // controls, render, one history commit. The Filter dropdown is a macro that
  // seeds the 8 mix sliders (editable after), so it paints + commits too.
  bwTreatmentSelect.addEventListener('change', () => {
    syncBwEnabled();
    onSliderInput();
    commitCurrentEdit();
  });
  bwFilterSelect.addEventListener('change', () => {
    const preset = BW_FILTERS[bwFilterSelect.value as BwFilterId];
    const keys = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
    for (let i = 0; i < keys.length; i++) bwMixSliders[keys[i]].value = String(preset[i]);
    paintSliders();
    onSliderInput();
    commitCurrentEdit();
  });
  bwToneSelect.addEventListener('change', () => {
    onSliderInput();
    commitCurrentEdit();
  });

  // Tone curve editor: click on empty space adds a point and starts dragging
  // it, drag moves the nearest point, double-click deletes it, Reset restores
  // linear. Edits render live during the drag and commit on release -- one
  // drag is one undo step, matching the sliders.
  let draggingCurveIdx = -1;
  const curveLive = (): void => {
    drawCurve();
    onSliderInput();
  };
  const endCurveDrag = (): void => {
    if (draggingCurveIdx === -1) return;
    draggingCurveIdx = -1;
    // A drag is an edit of the shared curve -- re-fit the region sliders so
    // switching back to Region shows the same shape.
    syncPointsToRegion();
    commitCurrentEdit();
  };
  curveCanvas.addEventListener('pointerdown', (e) => {
    if (currentFileId === null) return;
    e.preventDefault();
    const p = curvePointFromEvent(e);
    const idx = nearestCurvePoint(p.x, p.y);
    if (idx === -1) {
      curvePoints.push(p.x, p.y);
      draggingCurveIdx = curvePoints.length - 2;
    } else {
      draggingCurveIdx = idx;
    }
    curveCanvas.setPointerCapture(e.pointerId);
    curveLive();
  });
  curveCanvas.addEventListener('pointermove', (e) => {
    if (draggingCurveIdx === -1) return;
    const p = curvePointFromEvent(e);
    curvePoints[draggingCurveIdx] = clampCurveX(p.x, draggingCurveIdx);
    curvePoints[draggingCurveIdx + 1] = p.y;
    curveLive();
  });
  curveCanvas.addEventListener('pointerup', endCurveDrag);
  curveCanvas.addEventListener('pointercancel', endCurveDrag);
  curveCanvas.addEventListener('dblclick', (e) => {
    if (currentFileId === null) return;
    const p = curvePointFromEvent(e);
    const idx = nearestCurvePoint(p.x, p.y);
    if (idx === -1 || curvePoints.length <= 4) return; // keep at least 2 points
    curvePoints.splice(idx, 2);
    syncPointsToRegion();
    drawCurve();
    onSliderInput();
    commitCurrentEdit();
  });
  curveResetButton.addEventListener('click', () => {
    if (currentFileId === null) return;
    if (isRegionMode()) {
      regionHighlightsSlider.value = '0';
      regionLightsSlider.value = '0';
      regionDarksSlider.value = '0';
      regionShadowsSlider.value = '0';
      syncRegionToPoints();
    } else {
      curvePoints = [0, 0, 1, 1];
      syncPointsToRegion();
    }
    paintSliders();
    drawCurve();
    onSliderInput();
    commitCurrentEdit();
  });

  // Switching Adjust: Region <-> Point is a view switch, not an edit -- both
  // handles already describe the same shared curve, so switching just shows
  // the other representation. Commit re-emits it in the new mode's shape.
  curveAdjust.addEventListener('change', () => {
    if (currentFileId === null) return;
    syncCurveMode();
    drawCurve();
    onSliderInput();
    commitCurrentEdit();
  });

  undoButton.addEventListener('click', () => applyUndoRedo(false));
  redoButton.addEventListener('click', () => applyUndoRedo(true));

  // Export current Develop state -> JPEG/PNG download. The one allowed
  // GPU->CPU readback. A preview (HE*/undecodable file) can't be exported --
  // there's no full-res image behind it, only the embedded JPEG.
  exportButton.addEventListener('click', async () => {
    if (currentFileId === null) return;
    if (loadedFileId !== currentFileId) {
      showError("Nothing to export — a preview can't be exported.");
      return;
    }
    const format = exportFormat.value === 'png' ? 'png' : 'jpeg';
    exportButton.disabled = true;
    try {
      const blob = await pipeline.exportImage(currentOpsFromSliders(), format);
      const record = allFiles.find((f) => f.id === currentFileId);
      const base = record?.name.replace(/\.[^.]+$/, '') ?? 'export';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError('Export failed.', errorDetail(err));
    } finally {
      exportButton.disabled = false;
    }
  });

  // Reset to the fresh-import default, LrC-style: an empty ops state (still
  // renders via the mandatory As-Shot WB + camera profile + ACR baseline
  // passes). Unlike a plain "set sliders to 0", Reset also clears the edit
  // history -- the photo goes back to a fresh-import state with no undo trail.
  resetButton.addEventListener('click', async () => {
    if (currentFileId === null || !currentEditState) return;
    applyOpsToSliders([]);
    renderOps([]);
    currentEditState = createEditState();
    renderHistory();
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save the reset.", errorDetail(err));
    }
  });

  // ---- before / after (Develop) ----
  // LrC's \ key holds the original as-imported look; the footer button makes it
  // sticky. "Before" = empty ops (the same fresh-import render Reset shows).
  // ponytail: dragging a slider mid-before falls back to After (live edit wins)
  // but leaves the button lit until clicked again -- acceptable, the momentary
  // \ is the primary gesture.
  let beforeAfter = false;
  let beforeAfterSticky = false;
  function setBeforeAfter(v: boolean, sticky: boolean): void {
    if (beforeAfter === v && beforeAfterSticky === sticky) return;
    beforeAfter = v;
    beforeAfterSticky = sticky;
    beforeAfterBtn.classList.toggle('active', v);
    renderOps(v ? [] : currentOps(currentEditState ?? createEditState()));
  }
  beforeAfterBtn.addEventListener('click', () => setBeforeAfter(!beforeAfter, true));
  window.addEventListener('keydown', (e) => {
    if (e.key === '\\' && !e.repeat && getState().module === 'develop') {
      e.preventDefault();
      setBeforeAfter(true, false);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === '\\' && beforeAfter && !beforeAfterSticky) setBeforeAfter(false, false);
  });
  window.addEventListener('blur', () => {
    if (beforeAfter && !beforeAfterSticky) setBeforeAfter(false, false);
  });

  // ---- presets ----
  let presets: PresetRow[] = [];

  function renderPresets(): void {
    presetListEl.textContent = '';
    for (const preset of presets) {
      const row = document.createElement('div');
      row.className = 'preset-row';
      row.dataset.presetId = String(preset.id);
      const name = document.createElement('span');
      name.textContent = preset.name;
      name.title = opsToLabel(preset.ops);
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete preset';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePreset(db, preset.id!)
          .then(() => {
            presets = presets.filter((p) => p.id !== preset.id);
            renderPresets();
          })
          .catch((err) => showError("Couldn't delete the preset.", errorDetail(err)));
      });
      row.append(name, del);
      presetListEl.appendChild(row);
    }
  }

  presetSaveButton.addEventListener('click', async () => {
    if (currentFileId === null || !currentEditState) return;
    const name = window.prompt('Preset name:', '');
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await savePreset(db, trimmed, currentOpsFromSliders());
      presets = await listPresets(db);
      renderPresets();
    } catch (err) {
      showError("Couldn't save the preset.", errorDetail(err));
    }
  });

  // Click a preset to apply it (merge by kind); the ✕ button on each row
  // deletes instead (it stops propagation above).
  presetListEl.addEventListener('click', async (e) => {
    const row = (e.target as HTMLElement).closest('.preset-row') as HTMLElement | null;
    const preset = row && presets.find((p) => String(p.id) === row.dataset.presetId);
    if (!preset || currentFileId === null || !currentEditState) return;
    const merged = mergePresetOps(currentOps(currentEditState), preset.ops);
    currentEditState = commitEdit(currentEditState, merged);
    applyOpsToSliders(merged);
    renderOps(merged);
    renderHistory();
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError("Couldn't save the applied preset.", errorDetail(err));
    }
  });

  // Temporary diagnostic (Develop-mode black-image investigation): reports
  // whether the GPU compute chain produced a non-black image (displayTexture
  // readback) and what the canvas actually displays (1x1 pixel readback at the
  // image center). Output goes to the browser console.
  function runDevelopDiagnostics(): void {
    pipeline
      .diagnostic()
      .then((s) => console.log('[app]', s))
      .catch((e) => console.error('[app] diagnostic readback failed:', e));
    try {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const p2d = probe.getContext('2d', { willReadFrequently: true })!;
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);
      p2d.drawImage(canvas, cx, cy, 1, 1, 0, 0, 1, 1);
      const px = p2d.getImageData(0, 0, 1, 1).data;
      console.log(`[app] canvas pixel at (${cx},${cy}) = rgba(${px[0]},${px[1]},${px[2]},${px[3]})`);
    } catch (e) {
      console.error('[app] canvas pixel probe failed:', e);
    }
  }

  // ---- Contact sheet ----
  // One folder = one film roll: frames lay out as 35mm-style contact sheets,
  // 36 per sheet (fewer on the last), overflow starts a new sheet. No culling
  // filters -- a contact sheet shows the whole roll, rejects included.
  const CONTACT_SHEET_SIZE = 36;
  let contactFiles: FileRecord[] = [];
  let contactSheetIdx = 0;

  function renderContactSheet(): void {
    const sheets: FileRecord[][] = [];
    for (let i = 0; i < contactFiles.length; i += CONTACT_SHEET_SIZE) {
      sheets.push(contactFiles.slice(i, i + CONTACT_SHEET_SIZE));
    }
    contactSheetIdx = Math.min(Math.max(contactSheetIdx, 0), Math.max(sheets.length - 1, 0));
    contactSheetLabel.textContent = sheets.length ? `Sheet ${contactSheetIdx + 1} / ${sheets.length}` : 'No frames';
    contactPrev.disabled = contactSheetIdx === 0;
    contactNext.disabled = contactSheetIdx >= sheets.length - 1;
    contactGrid.textContent = '';
    if (sheets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'contact-empty';
      empty.textContent = 'Add a folder in Library to build a contact sheet.';
      contactGrid.appendChild(empty);
      return;
    }
    const frames = sheets[contactSheetIdx];
    frames.forEach((file, i) => {
      const cell = document.createElement('div');
      cell.className = 'contact-frame';
      cell.title = file.path;
      cell.addEventListener('click', () => {
        openFile(file);
        switchModule('develop'); // proofing: click a frame, see it full
      });
      const num = document.createElement('span');
      num.className = 'contact-frame-num';
      num.textContent = String(contactSheetIdx * CONTACT_SHEET_SIZE + i + 1).padStart(2, '0');
      cell.appendChild(num);
      contactGrid.appendChild(cell);
      getThumbnail(file).then((blob) => {
        if (!blob) return;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        img.addEventListener('error', () => {
          URL.revokeObjectURL(img.src);
          img.remove();
        }, { once: true });
        cell.appendChild(img);
      });
    });
  }

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
      if (currentFileId === null || !currentEditState) return;
      // The render is deferred to the next animation frame so layout has run
      // on the now-visible canvas first (switchModule calls onShow()
      // synchronously right after unhiding).
      requestAnimationFrame(() => {
        // Files selected from Library are decoded lazily (see openFile), so
        // on first Develop entry the Bayer data may not be in the pipeline
        // yet -- decode + load it, then render from the existing textures
        // (cheap: no re-decode when the data is already loaded).
        ensureDevelopImage().then(() => {
          // show() re-creates the surface at the canvas's current size. The
          // surface was configured while the canvas was display:none or for
          // a previous file, and Chrome 151 ties the drawing buffer to the
          // canvas size at configure() time, so this must happen after the
          // canvas has been resized to the loaded image (loadIntoPipeline
          // already did, if it ran).
          pipeline.show();
          // Re-apply sliders: ensureDevelopImage may have just decoded and set
          // asShotWB (As-Shot WB readout for a file first opened in Develop).
          applyOpsToSliders(currentOps(currentEditState!));
          renderOps(currentOps(currentEditState!));
          // A preview file renders through the overlay img, not the canvas --
          // the diagnostic would read a black canvas under it, so skip.
          if (previewImg.hidden) runDevelopDiagnostics();
        });
      });
    },
    onHide: () => {},
  });
  registerModule({
    id: 'contact',
    root: document.querySelector('#module-contact')!,
    onShow: () => {
      // The current folder is the roll; with no folder selected, all files
      // chunk across sheets. Rebuilt on entry so a folder change shows up
      // next time the sheet is opened.
      contactFiles = folderFilter !== null ? allFiles.filter((f) => f.folderId === folderFilter) : [...allFiles];
      contactRollLabel.textContent = folderFilter !== null
        ? (folders.find((f) => f.id === folderFilter)?.name ?? 'Roll')
        : 'All folders';
      contactSheetIdx = 0;
      renderContactSheet();
    },
    onHide: () => {},
  });
  contactPrev.addEventListener('click', () => {
    if (contactSheetIdx > 0) {
      contactSheetIdx--;
      renderContactSheet();
    }
  });
  contactNext.addEventListener('click', () => {
    contactSheetIdx++;
    renderContactSheet();
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

  // Paints the grid selection outline in place on every selection change --
  // renderVisibleRows() only rebuilds on scroll/import, so without this the
  // outline would lag one click behind (a sibling of the filmstrip jank fix).
  // Multi-selection: every id in selectedIds is outlined. The footer's sync
  // button + selection readout are driven here too (the single place every
  // selection mutation -- grid, filmstrip, arrow keys -- funnels through).
  subscribe(() => {
    const { selectedId, selectedIds } = getState();
    const selected = new Set(selectedIds);
    for (const cell of libraryGrid.querySelectorAll<HTMLElement>('.catalog-cell')) {
      cell.classList.toggle('selected', selected.has(Number(cell.dataset.fileId)));
    }
    selectionInfo.textContent =
      selectedIds.length > 1 ? `${selectedIds.length} selected · sync from the last clicked` :
      selectedIds.length === 1 ? '1 selected' : '';
    syncBtn.disabled = !(selectedId !== null && selectedIds.length >= 2);
  });

  // ---- shortcuts ----
  window.addEventListener('keydown', async (e) => {
    const action = keyToAction(e);
    if (!action) return;

    if (action.type === 'grid' || action.type === 'loupe') {
      e.preventDefault();
      // Shortcut actions are named for the target workspace; module ids
      // are 'library'/'develop'.
      switchModule(action.type === 'grid' ? 'library' : 'develop');
      return;
    }
    if (action.type === 'undo' || action.type === 'redo') {
      e.preventDefault();
      await applyUndoRedo(action.type === 'redo');
      return;
    }

    // Culling marks on the selected file(s), applied to the in-memory records
    // so the grid repaints instantly (no DB re-query). Like LrC, the mark hits
    // every photo in the multi-selection; with no multi-selection it hits just
    // the selected file.
    if (
      action.type === 'pick' || action.type === 'reject' || action.type === 'clearCull' ||
      action.type === 'rate' || action.type === 'color'
    ) {
      e.preventDefault();
      const { selectedIds } = getState();
      const ids = selectedIds.length ? selectedIds : [getState().selectedId].filter((x) => x !== null);
      if (!ids.length) return;
      const patch =
        action.type === 'pick' ? { flag: true } :
        action.type === 'reject' ? { flag: false } :
        action.type === 'clearCull' ? { flag: undefined, rating: 0, color: 0 } :
        action.type === 'rate' ? { rating: action.rating } :
        { color: action.color };
      try {
        for (const id of ids) {
          const record = allFiles.find((f) => f.id === id);
          if (!record) continue;
          Object.assign(record, await setCull(db, id, patch));
        }
        rebuildGrid();
      } catch (err) {
        showError("Couldn't save the cull mark.", errorDetail(err));
      }
      return;
    }

    // prev/next walk the flat, folder-ordered file list; with no selection
    // yet, the first arrow selects the first file (Lightroom-ish).
    e.preventDefault();
    const index = allFiles.findIndex((f) => f.id === getState().selectedId);
    const nextIndex = index === -1 ? 0 : action.type === 'next' ? index + 1 : index - 1;
    const file = allFiles[nextIndex];
    if (file) await openFile(file);
  });

  // ---- cull filter bar (grid-only; the filmstrip always shows everything) ----
  function applyCullFilterControls(): void {
    cullFilter = {
      hideRejected: filterHideRejected.checked,
      pickedOnly: filterPicked.checked,
      minRating: Number(filterMinRating.value),
    };
    // The footer star chips mirror the left panel's Min rating select.
    footerFilterButtons.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.minrating) === cullFilter.minRating);
    });
    rebuildGrid();
  }
  filterHideRejected.addEventListener('change', applyCullFilterControls);
  filterPicked.addEventListener('change', applyCullFilterControls);
  filterMinRating.addEventListener('change', applyCullFilterControls);
  footerFilterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterMinRating.value = String(btn.dataset.minrating);
      applyCullFilterControls();
    });
  });

  // ---- sync settings (Library footer) ----
  // Copies the reference photo's current ops (last clicked) as a NEW snapshot
  // in every other selected photo's edit history -- non-destructive, so each
  // target can undo the sync individually, exactly like LrC's Sync.
  syncBtn.addEventListener('click', async () => {
    const { selectedId, selectedIds } = getState();
    if (selectedId === null || selectedIds.length < 2) return;
    const targets = selectedIds.filter((id) => id !== selectedId);
    try {
      const refOps = currentOps(await loadEditState(db, selectedId));
      for (const id of targets) {
        const state = await loadEditState(db, id);
        await saveEditState(db, id, commitEdit(state, refOps));
      }
      selectionInfo.textContent = `✓ synced to ${targets.length} photo${targets.length > 1 ? 's' : ''}`;
    } catch (err) {
      showError("Couldn't sync settings.", errorDetail(err));
    }
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
  try {
    presets = await listPresets(db);
  } catch (err) {
    presets = []; // a broken presets store shouldn't block the catalog
  }
  renderPresets();

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
