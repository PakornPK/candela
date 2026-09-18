import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';
import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError, type CameraMeta, type DecodedRaw } from './raw/decode';
import { decodeImage, ImageDecodeError, type DecodedImage } from './raw/imageDecode';
import { extractThumbnail } from './raw/thumbnail';
import { cameraCalibrationKey, gainsToKelvin, gainsToTint, WB_NEUTRAL_KELVIN } from './gpu/uniforms';
import { getCameraXyz } from './gpu/ops';
import { openCatalogDb } from './catalog/db';
import { listFolders, listFiles } from './catalog/query';
import { applyCullResult, setCull } from './catalog/culling';
import { importFolder, importFolderFromHandle, isRawFileName } from './catalog/import';
import { ensureReadPermission, queryReadPermission } from './catalog/permissions';
import { loadEditState, saveEditState } from './catalog/editsStore';
import { deletePreset, listPresets, savePreset, type PresetRow } from './catalog/presetsStore';
import { parsePreset, serializePreset, PRESET_FILE_EXT } from './catalog/presetFiles';
import { commitEdit, undo, redo, currentOps, createEditState } from './catalog/editHistory';
import { getOrExtractThumbnail } from './catalog/thumbnails';
import { buildContactSheets, CONTACT_SHEET_SIZE } from './app/contactSheet';
import { isExposureOp, isBwOp, isCropOp, isDodgeBurnOp, isFrameOp, isGeometryOp, isGrainOp, isLightleakOp, isPresenceOp, isProfileOp, isToneCurveOp, isToneOp, isVignetteOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord, type FolderRecord, type ProfileKind, type FilmStockId, type FrameStyle, type AspectPreset, type WbGains, type BwMix, type BwToneId } from './catalog/types';
import { FILM_STOCKS } from './gpu/film';
import { buildParametricToneLut, buildToneCurveLut, fitRegionParams, isNeutralTone, parametricControlPoints, TONE_LUT_SIZE, type ToneParams } from './gpu/tone';
import { isNeutralPresence, type PresenceParams } from './gpu/presence';
import { isNeutralVignette, type VignetteParams } from './gpu/vignette';
import { isNeutralGrain, seedFromPath, setGrainSeed, type GrainParams } from './gpu/grain';
import { isNeutralLightleak, type LightleakParams } from './gpu/lightleak';
import { cropHandleAt, cropOverlayRect, dragCropRect, isFreeformCrop, cropRegion, isNeutralCrop, type CropHandleMode, type CropParams } from './gpu/crop';
import { isNeutralGeometry, type GeometryParams } from './gpu/geometry';
import { effectiveMask, maskDims, maskHasPaint, maskToBytes, maskToOp, maskToOverlay, opToMask, paintStroke, type DodgeBurnParams } from './gpu/dodge';
import { BW_FILTERS, BW_TONES, type BwFilterId } from './gpu/bw';
import { getState, selectFile, setSelection, subscribe, type ModuleId } from './app/state';
import { registerModule, switchModule } from './app/modules';
import { createFilmstrip } from './app/filmstrip';
import { keyToAction } from './app/shortcuts';
import { defaultViewState, viewStateToCropFrac, zoomToward, panBy, type ViewState } from './app/viewState';
import { listCollections, createCollection, deleteCollection, addFilesToCollection, removeFilesFromCollection, type Collection } from './catalog/collections';
import { listSmartCollections, createSmartCollection, updateSmartCollection, deleteSmartCollection, querySmartCollection, buildCriteria, criteriaToForm, describeCriteria, hasCriteria, type CriteriaForm, type SmartCollection, type SmartCollectionCriteria } from './catalog/smartCollections';
import { TetheredCapture } from './app/tetheredCapture';
import { openControlsWindow, type ControlsWindow, type MirrorControl } from './app/secondMonitor';

const COLUMNS_PER_ROW = 6; // fixed for this pass -- see plan header
const CELL_SIZE = 160; // px, matches index.html's .catalog-cell
const HEADING_HEIGHT = 24; // px, matches index.html's .catalog-heading

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const libraryScroll = document.querySelector<HTMLDivElement>('#library-scroll')!;
const libraryGrid = document.querySelector<HTMLDivElement>('#library-grid')!;
const libraryEmpty = document.querySelector<HTMLButtonElement>('#library-empty')!;
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
const grainAmountSlider = document.querySelector<HTMLInputElement>('#grain-amount')!;
const grainSizeSlider = document.querySelector<HTMLInputElement>('#grain-size')!;
const grainRoughnessSlider = document.querySelector<HTMLInputElement>('#grain-roughness')!;
const grainAmountValue = document.querySelector<HTMLOutputElement>('#grain-amount-value')!;
const grainSizeValue = document.querySelector<HTMLOutputElement>('#grain-size-value')!;
const grainRoughnessValue = document.querySelector<HTMLOutputElement>('#grain-roughness-value')!;
const lightleakAmountSlider = document.querySelector<HTMLInputElement>('#lightleak-amount')!;
const lightleakHueSlider = document.querySelector<HTMLInputElement>('#lightleak-hue')!;
const lightleakFadeSlider = document.querySelector<HTMLInputElement>('#lightleak-fade')!;
const lightleakPatternSelect = document.querySelector<HTMLSelectElement>('#lightleak-pattern')!;
const lightleakAmountValue = document.querySelector<HTMLOutputElement>('#lightleak-amount-value')!;
const lightleakHueValue = document.querySelector<HTMLOutputElement>('#lightleak-hue-value')!;
const lightleakFadeValue = document.querySelector<HTMLOutputElement>('#lightleak-fade-value')!;
const frameStyleSelect = document.querySelector<HTMLSelectElement>('#frame-style')!;
const cropAspectSelect = document.querySelector<HTMLSelectElement>('#crop-aspect')!;
const cropToggleBtn = document.querySelector<HTMLButtonElement>('#crop-toggle')!;
const cropWorkbenchControls = document.querySelector<HTMLElement>('#crop-workbench')!;
const rotateCcwBtn = document.querySelector<HTMLButtonElement>('#rotate-ccw')!;
const rotateCwBtn = document.querySelector<HTMLButtonElement>('#rotate-cw')!;
const straightenSlider = document.querySelector<HTMLInputElement>('#straighten')!;
const straightenValue = document.querySelector<HTMLOutputElement>('#straighten-value')!;
// Transform (geometry) sliders -- LrC's Transform panel.
const geometryVerticalSlider = document.querySelector<HTMLInputElement>('#geometry-vertical')!;
const geometryVerticalValue = document.querySelector<HTMLOutputElement>('#geometry-vertical-value')!;
const geometryHorizontalSlider = document.querySelector<HTMLInputElement>('#geometry-horizontal')!;
const geometryHorizontalValue = document.querySelector<HTMLOutputElement>('#geometry-horizontal-value')!;
const geometryRotateSlider = document.querySelector<HTMLInputElement>('#geometry-rotate')!;
const geometryRotateValue = document.querySelector<HTMLOutputElement>('#geometry-rotate-value')!;
const geometryAspectSlider = document.querySelector<HTMLInputElement>('#geometry-aspect')!;
const geometryAspectValue = document.querySelector<HTMLOutputElement>('#geometry-aspect-value')!;
const geometryScaleSlider = document.querySelector<HTMLInputElement>('#geometry-scale')!;
const geometryScaleValue = document.querySelector<HTMLOutputElement>('#geometry-scale-value')!;
const geometryOffsetXSlider = document.querySelector<HTMLInputElement>('#geometry-offsetx')!;
const geometryOffsetXValue = document.querySelector<HTMLOutputElement>('#geometry-offsetx-value')!;
const geometryOffsetYSlider = document.querySelector<HTMLInputElement>('#geometry-offsety')!;
const geometryOffsetYValue = document.querySelector<HTMLOutputElement>('#geometry-offsety-value')!;
// Cumulative clockwise quarter-turns (0..3) of the crop tool. Not a slider --
// step state advanced by the rotate buttons, restored by applyOpsToSliders.
let cropRotate90 = 0;
// The freeform crop rect the workbench overlay drags (normalized 0..1: x/y =
// rect center, w/h = size). null = the centered preset (aspect select). Lives
// in the crop op as x/y/w/h; restored from history by applyOpsToSliders.
let cropFreeform: { x: number; y: number; w: number; h: number } | null = null;
let cropDrag: { mode: CropHandleMode; startX: number; startY: number; orig: { x: number; y: number; w: number; h: number } } | null = null;
// LrC-style crop mode: true = the crop workbench (full image + frame overlay);
// false = "Done" -- the loupe refits to the crop (canvas buffer = the mask
// bbox, blit samples cropRegion) and later tone/WB edits continue on the
// cropped view. The Crop/Done button toggles it; the crop controls (aspect,
// rotate, straighten) re-enter the workbench automatically.
let cropModeActive = false;
function setCropMode(active: boolean): void {
  cropModeActive = active;
  cropToggleBtn.textContent = active ? 'Done' : 'Crop';
  // The Crop/Done button is the mode's one owner. The workbench controls
  // (aspect / rotate / straighten) hide outside crop mode, so no stray
  // change can silently re-enter it -- the aspect select used to fire
  // setCropMode(true) from Done mode and leave the wheel/pan zoom guards
  // (which bail on cropModeActive) dead until reload.
  cropWorkbenchControls.hidden = !active;
}
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
const contactExport = document.querySelector<HTMLButtonElement>('#contact-export')!;
const printPaper = document.querySelector<HTMLSelectElement>('#print-paper')!;
const printOrientation = document.querySelector<HTMLSelectElement>('#print-orientation')!;
const printMargin = document.querySelector<HTMLSelectElement>('#print-margin')!;
const printButton = document.querySelector<HTMLButtonElement>('#print-btn')!;
const printPageEl = document.querySelector<HTMLDivElement>('#print-page')!;
const printImageEl = document.querySelector<HTMLImageElement>('#print-image')!;
const printEmptyEl = document.querySelector<HTMLDivElement>('#print-empty')!;
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
const exportBitDepth = document.querySelector<HTMLSelectElement>('#export-bitdepth')!;
const exportSize = document.querySelector<HTMLSelectElement>('#export-size')!;
const exportPreset = document.querySelector<HTMLSelectElement>('#export-preset')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset-btn')!;
const beforeAfterBtn = document.querySelector<HTMLButtonElement>('#beforeafter-btn')!;
const presetSaveButton = document.querySelector<HTMLButtonElement>('#preset-save')!;
const presetImportButton = document.querySelector<HTMLButtonElement>('#preset-import')!;
const presetListEl = document.querySelector<HTMLDivElement>('#preset-list')!;
const syncBtn = document.querySelector<HTMLButtonElement>('#sync-btn')!;
const autoAdvanceCheckbox = document.querySelector<HTMLInputElement>('#auto-advance')!;
const footerCounts = document.querySelector<HTMLSpanElement>('#footer-counts')!;
const selectionInfo = document.querySelector<HTMLSpanElement>('#selection-info')!;
const footerFilterButtons = document.querySelectorAll<HTMLButtonElement>('#footer-filters [data-minrating]');
const bwSection = document.querySelector<HTMLDetailsElement>('#bw-section')!;
const dodgeBrushBtn = document.querySelector<HTMLButtonElement>('#dodge-brush')!;
const dodgeClearBtn = document.querySelector<HTMLButtonElement>('#dodge-clear')!;
const dodgeModeSelect = document.querySelector<HTMLSelectElement>('#dodge-mode')!;
const dodgeAmountSlider = document.querySelector<HTMLInputElement>('#dodge-amount')!;
const dodgeSizeSlider = document.querySelector<HTMLInputElement>('#dodge-size')!;
const dodgeOpacitySlider = document.querySelector<HTMLInputElement>('#dodge-opacity')!;
const dodgeFeatherSlider = document.querySelector<HTMLInputElement>('#dodge-feather')!;
const dodgeAmountValue = document.querySelector<HTMLOutputElement>('#dodge-amount-value')!;
const dodgeSizeValue = document.querySelector<HTMLOutputElement>('#dodge-size-value')!;
const dodgeOpacityValue = document.querySelector<HTMLOutputElement>('#dodge-opacity-value')!;
const dodgeFeatherValue = document.querySelector<HTMLOutputElement>('#dodge-feather-value')!;
const dodgeOverlayColor = document.querySelector<HTMLInputElement>('#dodge-overlay-color')!;
const maskOverlay = document.querySelector<HTMLCanvasElement>('#mask-overlay')!;
const maskOverlayCtx = maskOverlay.getContext('2d')!;
const cropOverlay = document.querySelector<HTMLCanvasElement>('#crop-overlay')!;
const cropOverlayCtx = cropOverlay.getContext('2d')!;
const zoomFitBtn = document.querySelector<HTMLButtonElement>('#zoom-fit')!;
const zoomFillBtn = document.querySelector<HTMLButtonElement>('#zoom-fill')!;
const zoom100Btn = document.querySelector<HTMLButtonElement>('#zoom-100')!;
const zoom200Btn = document.querySelector<HTMLButtonElement>('#zoom-200')!;
const zoomIndicator = document.querySelector<HTMLSpanElement>('#zoom-indicator')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const collectionListEl = document.querySelector<HTMLDivElement>('#collection-list')!;
const addCollectionBtn = document.querySelector<HTMLButtonElement>('#add-collection')!;
const collectionRemoveSelectedBtn = document.querySelector<HTMLButtonElement>('#collection-remove-selected')!;
const smartCollectionListEl = document.querySelector<HTMLDivElement>('#smart-collection-list')!;
const addSmartCollectionBtn = document.querySelector<HTMLButtonElement>('#add-smart-collection')!;
const smartDialog = document.querySelector<HTMLDialogElement>('#smart-dialog')!;
const smartForm = document.querySelector<HTMLFormElement>('#smart-form')!;
const smartDialogTitle = document.querySelector<HTMLHeadingElement>('#smart-dialog-title')!;
const smartNameInput = document.querySelector<HTMLInputElement>('#smart-name')!;
const smartScopeSelect = document.querySelector<HTMLSelectElement>('#smart-scope')!;
const smartRatingOpSelect = document.querySelector<HTMLSelectElement>('#smart-rating-op')!;
const smartRatingSelect = document.querySelector<HTMLSelectElement>('#smart-rating')!;
const smartFlagSelect = document.querySelector<HTMLSelectElement>('#smart-flag')!;
const smartFromInput = document.querySelector<HTMLInputElement>('#smart-from')!;
const smartToInput = document.querySelector<HTMLInputElement>('#smart-to')!;
const smartPreviewEl = document.querySelector<HTMLParagraphElement>('#smart-preview')!;
const tetheredStartBtn = document.querySelector<HTMLButtonElement>('#tethered-start-btn')!;
const tetheredStopBtn = document.querySelector<HTMLButtonElement>('#tethered-stop-btn')!;
const tetheredStatusEl = document.querySelector<HTMLDivElement>('#tethered-status')!;

function showError(message: string, detail?: string): void {
  errorMessageEl.textContent = message;
  errorDetailEl.textContent = detail ?? '';
  errorEl.hidden = false;
}

// Fullscreen gate for browsers without WebGPU -- the whole app is unusable, so
// a corner toast is not enough. Called before/at Pipeline.create; the detail
// is the specific reason (no navigator.gpu, no adapter, init failure).
const gpuGate = document.querySelector<HTMLDivElement>('#gpu-gate')!;
const gpuGateDetail = document.querySelector<HTMLParagraphElement>('#gpu-gate-detail')!;

function showGpuGate(reason: string): void {
  gpuGateDetail.textContent = reason;
  gpuGate.hidden = false;
}

function clearError(): void {
  errorEl.hidden = true;
  errorMessageEl.textContent = '';
  errorDetailEl.textContent = '';
}

// The alert used to stay forever (cleared only as a side effect of the next
// action); Esc dismisses it explicitly.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !errorEl.hidden) clearError();
});

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
  // A crop-tool control (straighten): dragging re-opens the crop workbench.
  entersCrop?: boolean;
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
  // Grain -- LrC defaults amount 0 (off) / size 25 / roughness 50.
  { slider: grainAmountSlider, output: grainAmountValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: grainSizeSlider, output: grainSizeValue, neutral: 25, format: (v) => formatSigned(v) },
  { slider: grainRoughnessSlider, output: grainRoughnessValue, neutral: 50, format: (v) => formatSigned(v) },
  // Light leak -- 0..100 sliders, amount 0 off, color 0 = warm (classic).
  { slider: lightleakAmountSlider, output: lightleakAmountValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: lightleakHueSlider, output: lightleakHueValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: lightleakFadeSlider, output: lightleakFadeValue, neutral: 0, format: (v) => formatSigned(v) },
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
  // Crop straighten -- the aspect select + rotate buttons are separate (mode
  // switches, not sliders); only the angle is a slider. entersCrop: dragging
  // it re-opens the crop workbench (straighten is a crop-tool control).
  { slider: straightenSlider, output: straightenValue, neutral: 0, format: (v) => `${formatSigned(v, 1)}°`, entersCrop: true },
  // Transform (geometry) -- scale's neutral is 100 (1:1), the rest are 0.
  { slider: geometryVerticalSlider, output: geometryVerticalValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: geometryHorizontalSlider, output: geometryHorizontalValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: geometryRotateSlider, output: geometryRotateValue, neutral: 0, format: (v) => `${formatSigned(v, 1)}°` },
  { slider: geometryAspectSlider, output: geometryAspectValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: geometryScaleSlider, output: geometryScaleValue, neutral: 100, format: (v) => `${v}%` },
  { slider: geometryOffsetXSlider, output: geometryOffsetXValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: geometryOffsetYSlider, output: geometryOffsetYValue, neutral: 0, format: (v) => formatSigned(v) },
  // Dodge & Burn brush -- amount 0 (off) / size 20 / opacity 50 / feather 0.
  // The dodgeBurn op is emitted only when the painted mask has content, not by
  // these sliders.
  { slider: dodgeAmountSlider, output: dodgeAmountValue, neutral: 0, format: (v) => formatSigned(v) },
  { slider: dodgeSizeSlider, output: dodgeSizeValue, neutral: 20, format: (v) => `${v}%` },
  { slider: dodgeOpacitySlider, output: dodgeOpacityValue, neutral: 50, format: (v) => `${v}%` },
  { slider: dodgeFeatherSlider, output: dodgeFeatherValue, neutral: 0, format: (v) => `${v}%` },
];

// The Second Monitor controls window mirrors this panel, and paintSliders() is
// the one place that repaints a slider's fill + readout -- so it is also where
// the mirror is kept current (non-null only while that window is open).
let syncControlsWindow: (() => void) | null = null;

function paintSliders(): void {
  for (const cfg of ALL_SLIDERS) {
    updateSliderFill(cfg.slider, cfg.neutral);
    cfg.output.textContent = cfg.format(Number(cfg.slider.value));
  }
  syncControlsWindow?.();
}

// The panel's own label text for a slider: the <label for=...>'s text nodes.
// The readout <output> is nested inside that label, and its value is not part
// of the control's name.
function sliderLabelText(slider: HTMLInputElement): string {
  const label = document.querySelector(`label[for="${slider.id}"]`);
  if (!label) return slider.id;
  const text = Array.from(label.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || slider.id;
}

// Which panel section a control sits in, so the mirror groups its rows the
// same way the panel does.
function sliderGroupName(slider: HTMLInputElement): string {
  const section = slider.closest('details.panel-section');
  return section?.querySelector('summary')?.textContent?.trim() || 'Controls';
}

// The mirror's rows come from ALL_SLIDERS, so a control added to the panel (one
// array entry + one <input>/<output> pair in index.html) shows up in the
// controls window with the panel's own range, label and readout, untouched.
const MIRROR_CONTROLS: MirrorControl[] = ALL_SLIDERS.map((cfg) => ({
  slider: cfg.slider,
  label: sliderLabelText(cfg.slider),
  group: sliderGroupName(cfg.slider),
  readout: () => cfg.format(Number(cfg.slider.value)),
}));

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

function readGrainParams(): GrainParams {
  return {
    amount: Number(grainAmountSlider.value),
    size: Number(grainSizeSlider.value),
    roughness: Number(grainRoughnessSlider.value),
  };
}

function readLightleakParams(): LightleakParams {
  return {
    amount: Number(lightleakAmountSlider.value),
    hue: Number(lightleakHueSlider.value),
    fade: Number(lightleakFadeSlider.value),
    pattern: Number(lightleakPatternSelect.value), // -1 auto, 0..3 Set A..D
  };
}

// A 90° turn re-frames the crop: re-center a freeform rect so the rotated mask
// stays centered in the view (the "crop แล้วหมุน รูปไม่อยู่ตรงกลาง" report).
// Preset crops are already centered; only a dragged (freeform) rect can be off.
function recenterCropRect(): void {
  if (cropFreeform) cropFreeform = { ...cropFreeform, x: 0.5, y: 0.5 };
}

function readCropParams(): CropParams {
  const p: CropParams = {
    aspect: cropAspectSelect.value as AspectPreset,
    rotate90: cropRotate90,
    angle: Number(straightenSlider.value),
  };
  if (cropFreeform) Object.assign(p, cropFreeform);
  return p;
}

function readGeometryParams(): GeometryParams {
  return {
    vertical: Number(geometryVerticalSlider.value),
    horizontal: Number(geometryHorizontalSlider.value),
    rotate: Number(geometryRotateSlider.value),
    aspect: Number(geometryAspectSlider.value),
    scale: Number(geometryScaleSlider.value),
    offsetX: Number(geometryOffsetXSlider.value),
    offsetY: Number(geometryOffsetYSlider.value),
  };
}

// ---- Dodge & Burn brush state ----
// paintMask is the CPU-authoritative signed density field (Float32, -1..1):
// positive = dodge, negative = burn. History stores an Int8 quantization in
// the dodgeBurn op; the GPU renders from a copy uploaded via setDodgeMask.
let paintMask: Float32Array | null = null;
let paintMaskW = 0;
let paintMaskH = 0;
let dodgeMaskDirty = false; // set whenever paintMask changes; drained by renderOps
let brushActive = false;
let brushPainting = false;
let lastBrushPt: [number, number] | null = null;

// The WebGPU pipeline. Module scope (not init-local) so the dodge brush helpers
// (syncDodgeMaskToGPU) can reach it; init runs once.
let pipeline: Pipeline;

function resizePaintMask(w: number, h: number): void {
  const [mw, mh] = maskDims(w, h);
  if (!paintMask || paintMask.length !== mw * mh) {
    paintMask = new Float32Array(mw * mh);
  } else {
    paintMask.fill(0);
  }
  paintMaskW = mw;
  paintMaskH = mh;
  dodgeMaskDirty = true;
  // The overlay canvas buffer tracks the mask (same aspect -> the CSS
  // object-fit:contain letterbox aligns it with #canvas).
  if (maskOverlay.width !== mw || maskOverlay.height !== mh) {
    maskOverlay.width = mw;
    maskOverlay.height = mh;
  }
  drawDodgeOverlay();
}

// Draws the brush mask overlay from the CPU-authoritative paintMask (the GPU
// texture is its mirror; drawing from the mask keeps overlay and render in
// sync with no readback). LrC-style AUTO-SHOW: the colored mask is visible
// only while a stroke is being painted (brushPainting), then hides the moment
// the pointer lifts -- so sliding Amount right after shows the real darken/
// lighten live, not the red mask. Color is the user's swatch.
function drawDodgeOverlay(): void {
  if (!brushPainting || !paintMask) {
    maskOverlay.hidden = true;
    return;
  }
  const hex = dodgeOverlayColor.value;
  const color: [number, number, number] = [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  ];
  maskOverlayCtx.putImageData(new ImageData(maskToOverlay(paintMask, color), paintMaskW, paintMaskH), 0, 0);
  maskOverlay.hidden = false;
}

// #2 workbench crop overlay: the crop is a rect + dim SELECTION over the full
// image (which the identity-crop op keeps on screen), not baked bars. Drawn in
// canvas-buffer space -- the overlay shares #canvas's object-fit:contain
// letterbox, so buffer-space rects land on the displayed image. Always drawn
// once an image is loaded: the default 'original' state is a full-image frame
// you can grab and drag freely (a crop starts by dragging, no preset needed).
function drawCropOverlay(curCrop: CropParams): void {
  if (canvas.width === 0) {
    cropOverlay.hidden = true;
    return;
  }
  cropOverlay.width = canvas.width;
  cropOverlay.height = canvas.height;
  const ctx = cropOverlayCtx;
  ctx.clearRect(0, 0, cropOverlay.width, cropOverlay.height);
  const r = cropOverlayRect(curCrop, canvas.width, canvas.height);
  // Dim everything outside the crop rect, then punch a clear hole through the
  // rotated rect so the photo shows through it. (A full-image frame punches the
  // whole canvas -> no visible dim.)
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, cropOverlay.width, cropOverlay.height);
  ctx.save();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.rotate(r.angle);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  // Crop rect outline + rule-of-thirds grid. The overlay is BUFFER-res, so
  // stroke/handle sizes scale by 1/dispScale (dispScale = CSS px per buffer
  // px) to stay a fixed CSS px at any resolution -- a 6k photo shown ~0.07x
  // otherwise collapses them to sub-pixel (invisible frame, ungrabbable
  // handles = the "ซูม/ย่อขยายไม่ได้" reports). Inside the rotated rect's
  // local space.
  const rect = canvas.getBoundingClientRect();
  const dispScale = rect.width > 0 ? rect.width / canvas.width : 1;
  ctx.save();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.rotate(r.angle);
  const lw = Math.max(1, 1.5 / dispScale);
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  for (let k = 1; k <= 2; k++) {
    ctx.moveTo(-r.w / 2 + (r.w * k) / 3, -r.h / 2);
    ctx.lineTo(-r.w / 2 + (r.w * k) / 3, r.h / 2);
    ctx.moveTo(-r.w / 2, -r.h / 2 + (r.h * k) / 3);
    ctx.lineTo(r.w / 2, -r.h / 2 + (r.h * k) / 3);
  }
  ctx.stroke();
  // 8 drag handles (LrC-style white squares at the corners + edge midpoints).
  const hs = Math.max(8, 12 / dispScale);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  const corners: [number, number][] = [
    [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
  ];
  for (const [cx, cy] of corners) {
    const hx = (cx * r.w) / 2 - hs / 2;
    const hy = (cy * r.h) / 2 - hs / 2;
    ctx.fillRect(hx, hy, hs, hs);
    ctx.strokeRect(hx, hy, hs, hs);
  }
  ctx.restore();
  cropOverlay.hidden = false;
}

// Pointer -> canvas-buffer coords (the overlay's drawing space), accounting for
// the CSS object-fit:contain letterbox. null outside the visible image, except
// `margin` buffer px beyond it -- the crop frame's edge handles sit ON the
// image edge (half the handle is clipped by the buffer), so the pointer must
// be allowed a handle-radius outside or a flush frame is impossible to grab
// (the "ติดขอบลากยาก" report).
function eventToBufferPt(e: PointerEvent, margin = 0): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return null;
  const scale = Math.min(rect.width / cw, rect.height / ch);
  const dispW = cw * scale;
  const dispH = ch * scale;
  const offX = (rect.width - dispW) / 2;
  const offY = (rect.height - dispH) / 2;
  const x = (e.clientX - rect.left - offX) / scale;
  const y = (e.clientY - rect.top - offY) / scale;
  if (x < -margin || x > cw + margin || y < -margin || y > ch + margin) return null;
  return [x, y];
}

function readDodgeParams(): DodgeBurnParams {
  return {
    amount: Number(dodgeAmountSlider.value),
    size: Number(dodgeSizeSlider.value),
    opacity: Number(dodgeOpacitySlider.value),
    feather: Number(dodgeFeatherSlider.value),
  };
}

// Uploads the current paint mask to the GPU when it changed since the last
// render/export. Called from renderOps (the single render gate) and the export
// handler (which dispatches ops directly without a render first). Opacity and
// feather are LIVE: the upload applies effectiveMask (opacity gain + edge blur)
// so dragging either slider after painting re-shapes the mark. The painted
// mask itself is never mutated, so history stores the raw paint.
function syncDodgeMaskToGPU(): void {
  if (!dodgeMaskDirty || !paintMask) return;
  const p = readDodgeParams();
  pipeline.setDodgeMask(maskToBytes(effectiveMask(paintMask, paintMaskW, paintMaskH, p.opacity, p.feather)));
  dodgeMaskDirty = false;
}

// Maps a pointer event on #canvas to mask pixel coordinates, accounting for
// the CSS `object-fit: contain` letterbox (the canvas buffer is aspect-fitted
// inside its box). Returns null outside the visible image.
function eventToMaskPt(e: PointerEvent): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return null;
  const scale = Math.min(rect.width / cw, rect.height / ch);
  const dispW = cw * scale;
  const dispH = ch * scale;
  const offX = (rect.width - dispW) / 2;
  const offY = (rect.height - dispH) / 2;
  const x = (e.clientX - rect.left - offX) / scale;
  const y = (e.clientY - rect.top - offY) / scale;
  if (x < 0 || x > cw || y < 0 || y > ch) return null;
  return [(x / cw) * paintMaskW, (y / ch) * paintMaskH];
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

// Global lock set by setAdjustEnabled(false) while a preview (embedded-JPEG
// fallback) is showing -- no decoded texture, so no adjustment can render.
let adjustEnabled = false;

// Hides/grays the B&W mix + filter + tone controls unless Treatment is B&W.
// Must ALSO respect the global adjust lock: setAdjustEnabled(false) runs while
// a preview (embedded-JPEG fallback) is showing, and re-enabling the B&W
// controls there would let the user drag mix sliders that render() no-ops on
// (no decoded texture) -- "bw mix doesn't change anything".
function syncBwEnabled(): void {
  const on = isBwEnabled() && adjustEnabled;
  // The whole B&W section (mix/filter/tone) disappears in Color mode; the
  // treatment choice itself now lives up in the Profile panel.
  bwSection.hidden = !isBwEnabled();
  bwControls.hidden = !isBwEnabled();
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
  // Grain is emitted only when the amount is non-zero (size/roughness do
  // nothing on their own) -- a neutral state renders without an extra pass,
  // like vignette.
  const grain = readGrainParams();
  if (!isNeutralGrain(grain)) ops.push({ kind: 'grain', ...grain });
  // Light leak is emitted only when the amount is non-zero (hue does nothing
  // on its own) -- same rule as vignette/grain.
  const lightleak = readLightleakParams();
  if (!isNeutralLightleak(lightleak)) ops.push({ kind: 'lightleak', ...lightleak });
  // Crop is emitted only when non-neutral (original aspect / no rotation /
  // 0° straighten = no pass) -- same rule as vignette/grain.
  const crop = readCropParams();
  if (!isNeutralCrop(crop)) ops.push({ kind: 'crop', ...crop });
  // Transform (geometry) is emitted only when non-neutral (all-zero keystone/
  // rotate/aspect/offset, scale 100 = no pass) -- same rule as crop.
  const geometry = readGeometryParams();
  if (!isNeutralGeometry(geometry)) ops.push({ kind: 'geometry', ...geometry });
  // Dodge & Burn is emitted only when the painted mask has content (the
  // amount/size/opacity sliders alone don't create a pass) -- a painted mask
  // with amount 0 still carries the brush state for history. The mask is
  // embedded compactly as Int8 (see dodge.ts).
  if (paintMask && maskHasPaint(paintMask)) {
    const p = readDodgeParams();
    ops.push({
      kind: 'dodgeBurn',
      ...p,
      mask: maskToOp(paintMask),
      maskW: paintMaskW,
      maskH: paintMaskH,
    });
  }
  // Film frame is a mode switch (style select): 'none' emits nothing.
  const frameStyle = frameStyleSelect.value as FrameStyle;
  if (frameStyle !== 'none') ops.push({ kind: 'frame', style: frameStyle });
  // B&W treatment is a mode switch, not a slider: emit the op only while
  // Treatment = Black & White. Even a fully-neutral mix+tone is still a real
  // edit (Color -> B&W conversion), so it always emits when enabled.
  if (isBwEnabled()) {
    ops.push({ kind: 'bw', mix: readBwMix(), tone: bwToneSelect.value as BwToneId });
  }
  return ops;
}

function applyOpsToSliders(ops: Op[], cameraKey?: string): void {
  const profileOp = ops.find(isProfileOp);
  const exposureOp = ops.find(isExposureOp);
  const wbOp = ops.find(isWhiteBalanceOp);
  const toneOp = ops.find(isToneOp);
  const curveOp = ops.find(isToneCurveOp);
  const presenceOp = ops.find(isPresenceOp);
  const vignetteOp = ops.find(isVignetteOp);
  const grainOp = ops.find(isGrainOp);
  const lightleakOp = ops.find(isLightleakOp);
  const cropOp = ops.find(isCropOp);
  const geometryOp = ops.find(isGeometryOp);
  const frameOp = ops.find(isFrameOp);
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
    wbSlider.value = String(kelvinToWbSlider(gainsToKelvin(wbOp.gains, getCameraXyz(), cameraKey)));
    tintSlider.value = String(wbOp.tint ?? gainsToTint(wbOp.gains, getCameraXyz(), cameraKey));
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
  // Grain: LrC's neutral defaults are size 25 / roughness 50 (amount 0 off),
  // so an absent op restores those, not zero, so the fill track reads right.
  grainAmountSlider.value = String(grainOp?.amount ?? 0);
  grainSizeSlider.value = String(grainOp?.size ?? 25);
  grainRoughnessSlider.value = String(grainOp?.roughness ?? 50);
  lightleakAmountSlider.value = String(lightleakOp?.amount ?? 0);
  lightleakHueSlider.value = String(lightleakOp?.hue ?? 0);
  lightleakFadeSlider.value = String(lightleakOp?.fade ?? 0);
  lightleakPatternSelect.value = String(lightleakOp?.pattern ?? -1);
  cropAspectSelect.value = cropOp?.aspect ?? 'original';
  cropRotate90 = cropOp?.rotate90 ?? 0;
  straightenSlider.value = String(cropOp?.angle ?? 0);
  cropFreeform = null;
  if (cropOp && cropOp.kind === 'crop') {
    const cp: CropParams = { aspect: cropOp.aspect, rotate90: cropOp.rotate90, angle: cropOp.angle, x: cropOp.x, y: cropOp.y, w: cropOp.w, h: cropOp.h };
    if (isFreeformCrop(cp)) cropFreeform = { x: cp.x!, y: cp.y!, w: cp.w!, h: cp.h! };
  }
  // Transform: an absent op restores the neutral sliders (scale 100).
  geometryVerticalSlider.value = String(geometryOp?.vertical ?? 0);
  geometryHorizontalSlider.value = String(geometryOp?.horizontal ?? 0);
  geometryRotateSlider.value = String(geometryOp?.rotate ?? 0);
  geometryAspectSlider.value = String(geometryOp?.aspect ?? 0);
  geometryScaleSlider.value = String(geometryOp?.scale ?? 100);
  geometryOffsetXSlider.value = String(geometryOp?.offsetX ?? 0);
  geometryOffsetYSlider.value = String(geometryOp?.offsetY ?? 0);
  // Dodge & Burn: the op's mask IS the brush state. Restore it into the CPU
  // paint buffer (flagged dirty so the next render uploads it); no op clears.
  const dodgeOp = ops.find(isDodgeBurnOp);
  if (dodgeOp) {
    const target = dodgeOp.maskW * dodgeOp.maskH;
    if (!paintMask || paintMask.length !== target) paintMask = new Float32Array(target);
    paintMask.set(opToMask(dodgeOp));
    paintMaskW = dodgeOp.maskW;
    paintMaskH = dodgeOp.maskH;
    dodgeMaskDirty = true;
  } else if (paintMask) {
    paintMask.fill(0);
    dodgeMaskDirty = true;
  }
  dodgeAmountSlider.value = String(dodgeOp?.amount ?? 0);
  dodgeSizeSlider.value = String(dodgeOp?.size ?? 20);
  dodgeOpacitySlider.value = String(dodgeOp?.opacity ?? 50);
  dodgeFeatherSlider.value = String(dodgeOp?.feather ?? 0);
  frameStyleSelect.value = frameOp?.style ?? 'none';
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
      if (isGrainOp(op)) {
        return `Grain ${formatSigned(op.amount)}`;
      }
      if (isLightleakOp(op)) {
        const pat = op.pattern === 0 ? ' · Set A' : op.pattern === 1 ? ' · Set B' : '';
        return `Light leak ${formatSigned(op.amount)}${op.hue !== 0 ? ` · Color ${op.hue}` : ''}${pat}`;
      }
      if (isFrameOp(op)) {
        return `Frame ${op.style === '135' ? '135' : op.style === '120' ? '120' : 'Print'}`;
      }
      if (isCropOp(op)) {
        const parts: string[] = [];
        if (op.aspect !== 'original') parts.push(op.aspect);
        if (op.rotate90 !== 0) parts.push(`${op.rotate90 * 90}°`);
        if (op.angle !== 0) parts.push(`Straighten ${formatSigned(op.angle, 1)}°`);
        return `Crop ${parts.join(' · ')}`;
      }
      if (isGeometryOp(op)) {
        const parts: string[] = [];
        if (op.vertical !== 0) parts.push(`V ${formatSigned(op.vertical)}`);
        if (op.horizontal !== 0) parts.push(`H ${formatSigned(op.horizontal)}`);
        if (op.rotate !== 0) parts.push(`Rotate ${formatSigned(op.rotate, 1)}°`);
        if (op.aspect !== 0) parts.push(`Aspect ${formatSigned(op.aspect)}`);
        if (op.scale !== 100) parts.push(`Scale ${op.scale}%`);
        if (op.offsetX !== 0 || op.offsetY !== 0) parts.push(`Offset ${formatSigned(op.offsetX)},${formatSigned(op.offsetY)}`);
        return `Transform ${parts.join(' · ')}`;
      }
      if (isDodgeBurnOp(op)) {
        return `Dodge & Burn ${formatSigned(op.amount)}`;
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
  // Gate before touching the catalog: no WebGPU means the app cannot run, no
  // point opening IndexedDB or wiring UI. Pipeline.create throws its own clear
  // errors ("WebGPU is not supported...", "No WebGPU adapter available.") when
  // navigator.gpu exists but the adapter fails -- those land in showGpuGate too.
  if (!('gpu' in navigator)) {
    showGpuGate('navigator.gpu is undefined — WebGPU is not enabled in this browser.');
    return;
  }

  let db: IDBDatabase;
  try {
    db = await openCatalogDb();
  } catch (err) {
    showError("Couldn't open your photo catalog.", errorDetail(err));
    addFolderButton.disabled = true;
    return;
  }

  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showGpuGate(errorDetail(err));
    return;
  }

  // Histogram follows the edited image: each render()'s blit also captures a
  // 512x256 nearest-sampled copy of displayTexture (see pipeline.ts), and the
  // readback lands here as soon as it maps -- throttled by the one-in-flight
  // gate, so the slider hot path never waits on it.
  pipeline.setHistogramListener(drawHistogram);

  // Device loss recovery handler (Phase 4.1)
  pipeline.setDeviceLostHandler(async () => {
    showError('GPU device lost. Attempting to recover...');
    try {
      // Recreate pipeline
      const newPipeline = await Pipeline.create(canvas);
      pipeline = newPipeline;
      pipeline.setHistogramListener(drawHistogram);
      // Re-set device loss handler
      pipeline.setDeviceLostHandler(async () => {
        showError('GPU device lost again. Please reload the page.');
      });
      // Reload current image if any
      if (currentFileId) {
        const file = allFiles.find((f) => f.id === currentFileId);
        if (file) {
          await loadIntoPipeline(file, Date.now());
          renderOps(currentOps(currentEditState!));
        }
      }
      showError('Recovered from GPU device loss.');
      setTimeout(() => {
        const errorEl = document.querySelector('#error');
        if (errorEl) errorEl.remove();
      }, 3000);
    } catch (err) {
      showError('Failed to recover from GPU device loss. Please reload the page.', String(err));
    }
  });

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;
  // View state for the Develop module's loupe: zoom level and pan position.
  // zoom = 1 = fit, >1 = zoomed in. Pan is normalized (0..1) image center.
  let viewState: ViewState = defaultViewState();
  function updateZoomIndicator(): void {
    zoomIndicator.textContent = `${Math.round(viewState.zoom * 100)}%`;
  }
  let lastDecoded: { width: number; height: number; cameraMeta: CameraMeta | null; make: string; model: string } | null = null;
  // Camera identity of the loaded file, for the per-camera WB-readout
  // calibration (uniforms.ts wbCalibrationFor). null until a raw decodes.
  function currentCameraKey(): string | undefined {
    return lastDecoded ? cameraCalibrationKey(lastDecoded.make, lastDecoded.model) : undefined;
  }
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
  let collections: Collection[] = [];
  let smartCollections: SmartCollection[] = [];
  let activeCollectionId: number | null = null;
  let activeSmartCollectionId: number | null = null;
  let searchQuery = '';

  // Culling filter state. The grid and the contact sheet follow it; allFiles
  // (filmstrip + arrow navigation) is always unfiltered, Lightroom-style.
  // Two independent rating dimensions, ANDed: the left 'Min rating' dropdown
  // (at least N) and the footer star chips (exactly N, click again to clear).
  // The chips used to be 'at least N' too -- a chip labelled from the
  // cumulative count read as '4 stars: 4', and clicking it pulled every
  // rated photo (user report 2026-09-18: 'กด 4 แต่มาหมดเลย').
  let cullFilter = { hideRejected: true, pickedOnly: false, minRating: 0, exactRating: 0 };
  // The chip filter's own state (0 = off). Lives beside cullFilter so
  // applyCullFilterControls (defined later) can read it without a TDZ hit.
  let exactRatingFilter = 0;

  // The chip badges: the REAL rating distribution of the view (folder /
  // collection / search scope, before any cull filter). All = the photo
  // total. They used to be live filtered tallies, so activating one chip
  // rewrote the others' numbers into confusing small ones ('กด 1 ดาว... All
  // กลายเป็น 4' -- user report 2026-09-18). A number that changes under the
  // filter it describes is not a count of anything; the raw distribution is.
  let scopeRating: number[] = [0, 0, 0, 0, 0, 0];
  let scopeTotal = 0;

  function tallyScope(files: FileRecord[]): void {
    for (const f of files) scopeRating[f.rating ?? 0]++;
    scopeTotal += files.length;
  }

  // Everything except the chip's exact-rating term -- the All chip's badge
  // counts what a click would actually leave on screen (other filters stay).
  function passesOtherCulls(f: FileRecord): boolean {
    if (cullFilter.hideRejected && f.flag === false) return false;
    if (cullFilter.pickedOnly && f.flag !== true) return false;
    if (cullFilter.minRating > 0 && (f.rating ?? 0) < cullFilter.minRating) return false;
    return true;
  }

  function matchesCullFilter(f: FileRecord): boolean {
    if (!passesOtherCulls(f)) return false;
    if (cullFilter.exactRating > 0 && (f.rating ?? 0) !== cullFilter.exactRating) return false;
    return true;
  }

  // Re-chunks allFiles into grid entries honoring folderFilter, cullFilter,
  // activeCollection, activeSmartCollection, and searchQuery, then repaints.
  // Called after a filter change or a cull keypress (which mutates allFiles
  // in place); keeps the DB out of the hot path.
  function rebuildGrid(): void {
    gridEntries = [];
    scopeRating = [0, 0, 0, 0, 0, 0];
    scopeTotal = 0;
    
    // Determine which files to show based on active filter
    let filesToShow = allFiles;
    
    // Collection filter
    if (activeCollectionId !== null) {
      const collection = collections.find(c => c.id === activeCollectionId);
      if (collection) {
        const idSet = new Set(collection.fileIds);
        filesToShow = allFiles.filter(f => idSet.has(f.id));
      }
    } else if (activeSmartCollectionId !== null) {
      const smart = smartCollections.find(s => s.id === activeSmartCollectionId);
      if (smart) {
        filesToShow = querySmartCollection(allFiles, smart.criteria);
      }
    } else if (searchQuery) {
      // Search filter
      const query = searchQuery.toLowerCase();
      filesToShow = allFiles.filter(f => 
        f.path.toLowerCase().includes(query) ||
        (f as any).cameraModel?.toLowerCase().includes(query) ||
        (f as any).lensModel?.toLowerCase().includes(query)
      );
    } else {
      // Folder filter
      for (const folder of folders) {
        if (folderFilter !== null && folder.id !== folderFilter) continue;
        const visible = filesToShow.filter((f) => f.folderId === folder.id && matchesCullFilter(f));
        const inFolder = allFiles.filter((f) => f.folderId === folder.id);
        tallyScope(inFolder);
        if (visible.length === 0) continue;
        gridEntries.push({ kind: 'heading', folderName: folder.name });
        for (const row of chunkIntoRows(visible)) {
          gridEntries.push({ kind: 'row', files: row });
        }
      }
      repaintGrid();
      return;
    }
    
    // Apply cull filter to the filtered set
    tallyScope(filesToShow);
    filesToShow = filesToShow.filter(matchesCullFilter);
    
    // Group by folder for display
    const filesByFolder = new Map<number, FileRecord[]>();
    for (const file of filesToShow) {
      if (!filesByFolder.has(file.folderId)) {
        filesByFolder.set(file.folderId, []);
      }
      filesByFolder.get(file.folderId)!.push(file);
    }
    
    for (const [folderId, files] of filesByFolder) {
      const folder = folders.find(f => f.id === folderId);
      if (!folder) continue;
      gridEntries.push({ kind: 'heading', folderName: folder.name });
      for (const row of chunkIntoRows(files)) {
        gridEntries.push({ kind: 'row', files: row });
      }
    }
    
    repaintGrid();
  }

  // The single repaint tail: update the virtualizer's item count, re-derive
  // the visible list, and repaint grid + footer + dependents from it. Every
  // path that changes what the grid should show ends here.
  function repaintGrid(): void {
    virtualizer.setOptions({ ...virtualizer.options, count: gridEntries.length });
    virtualizer.measure();
    collectVisibleFiles();
    pruneSelectionToVisible();
    renderVisibleRows();
    updateFooter();
    // Thumbnails share the session cache, so this re-render re-points <img>
    // srcs without re-extracting anything.
    filmstrip.setFiles((visibleFiles ?? allFiles).length);
    if (getState().module === 'contact') renderContactSheet();
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

  // Cull metadata (rating / flag / colour) is what the smart collections query,
  // so every writer of it refreshes their counts too -- otherwise a rule like
  // "5 stars" keeps showing a stale number until something else re-renders it.
  function refreshCullDependents(): void {
    rebuildGrid();
    void renderSmartCollections();
    // The strip mirrors the marks the grid shows; badges repaint in place
    // (no rebuild -- a per-keystroke image rebuild would flicker the strip).
    filmstrip.syncRatings();
    if (getState().module === 'compare') renderCompareView();
  }

  // Applies a rating to the file whose stars were clicked; clicking the current
  // rating again clears it. The keyboard path (1..5) is the selection-wide one
  // (see the cull key handler): a key press names no target, so it rates every
  // selected photo, while a click names exactly one.
  async function rateFile(file: FileRecord, rating: number): Promise<void> {
    try {
      const patch = file.rating === rating ? { rating: 0 } : { rating };
      applyCullResult(file, await setCull(db, file.id, patch));
      refreshCullDependents();
    } catch (err) {
      showError("Couldn't save the rating.", errorDetail(err));
    }
  }

  // The one entry point for "the grid must now match the world": resync the
  // virtualizer's cached rect/offset (a display:none round trip can leave the
  // ResizeObserver-fed values stale at 0, which blanks the grid until a
  // manual scroll -- review 2026-09-18 #1), then rebuild + repaint. Call this
  // from module onShow; data/filter changes keep calling rebuildGrid().
  function refreshGrid(): void {
    virtualizer.scrollRect = { width: libraryScroll.offsetWidth, height: libraryScroll.offsetHeight };
    virtualizer.scrollOffset = libraryScroll.scrollTop;
    rebuildGrid();
  }

  // The files the grid currently shows, in reading order (collection / smart
  // collection / search / folder scope + cull filter). One owner for "what's
  // visible": the footer counts it, the arrow keys walk it, shift-click ranges
  // over it, and the reject handler moves selection within it. Rebuilt with
  // gridEntries in rebuildGrid(); null = before the first rebuild.
  let visibleFiles: FileRecord[] | null = null;

  // Files the new view hides (rejected under hide-rejected, re-rated out of a
  // smart collection, ...) must leave the selection too, or the footer keeps
  // claiming "1 selected" over a photo the grid no longer shows and the next
  // digit key hits a phantom (review 2026-09-18 #2/#3).
  function pruneSelectionToVisible(): void {
    if (getState().module !== 'library' || !visibleFiles || !visibleFiles.length) return;
    const { selectedId, selectedIds } = getState();
    if (!selectedIds.length) return;
    const visible = new Set(visibleFiles.map((f) => f.id));
    const keep = selectedIds.filter((id) => visible.has(id));
    if (keep.length === selectedIds.length) return;
    setSelection(keep, keep.includes(selectedId ?? -1) ? selectedId : keep[keep.length - 1] ?? null);
  }

  function collectVisibleFiles(): void {
    const files: FileRecord[] = [];
    for (const entry of gridEntries) {
      if (entry.kind === 'row') files.push(...entry.files);
    }
    visibleFiles = files;
  }

  // Star-chip tooltips carry the per-rating counts; the footer shows the total
  // in the CURRENT scope -- the collection, smart collection, or search the
  // grid is showing, not just the folder -- plus how many photos the cull
  // filter hid (a smaller grid with an unchanged "6 photos" footer reads as a
  // broken grid, not as a working filter). Re-run on folder/filter/cull
  // changes (rebuildGrid).
  function updateFooter(): void {
    const scope = visibleFiles ?? allFiles.filter((f) => folderFilter === null || f.folderId === folderFilter);
    const counts = [0, 0, 0, 0, 0, 0];
    for (const f of scope) counts[f.rating ?? 0]++;
    footerFilterButtons.forEach((btn) => {
      const min = Number(btn.dataset.minrating);
      const n = min === 0 ? scopeTotal : (scopeRating[min] ?? 0);
      btn.title = `${min === 0 ? 'Show all ratings' : `Show only ${min}\u2605 (click the lit chip again to clear)`} -- ${n} photo${n === 1 ? '' : 's'}`;
      btn.textContent = '';
      btn.append(min === 0 ? 'All' : '\u2605'.repeat(min));
      const badge = document.createElement('span');
      badge.className = 'chip-count';
      badge.textContent = String(n);
      btn.appendChild(badge);
    });
    // 'of' wording names the hidden remainder against the real total instead
    // of a bare hidden count that changed with the filter.
    footerCounts.textContent = scope.length === scopeTotal
      ? `${scopeTotal} photo${scopeTotal === 1 ? '' : 's'}`
      : `${scope.length} of ${scopeTotal} photos`;
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
    if (showFps) perfMarks.renderStart = performance.now();
    
    // The brush mask lives CPU-side (authoritative); push any change to the GPU
    // before the render dispatches the dodgeBurn pass (which samples it).
    syncDodgeMaskToGPU();
    const W = lastDecoded?.width ?? canvas.width;
    const H = lastDecoded?.height ?? canvas.height;
    if (cropModeActive) {
      // Crop workbench: full image at source size, blit identity, frame overlay.
      ensureCanvasSize(W, H);
      pipeline.setCanvasRect([0, 0, 1, 1]);
    } else {
      // Done: loupe refits to the crop -- canvas buffer = the mask bbox, blit
      // samples cropRegion, so edits continue on the cropped view. A neutral
      // crop is [0,0,1,1] = the full source (no visual change).
      const [rx, ry, rw, rh] = cropRegion(ops, W, H);
      ensureCanvasSize(Math.max(1, Math.round(rw * W)), Math.max(1, Math.round(rh * H)));
      // Apply viewState zoom/pan on top of the crop region: when zoomed in,
      // the canvas shows a sub-region of the crop (not the full crop).
      if (viewState.zoom > 1) {
        const [vx, vy, vw, vh] = viewStateToCropFrac(viewState);
        // viewState is normalized to the crop region, so scale to crop coords.
        pipeline.setCanvasRect([
          rx + vx * rw,
          ry + vy * rh,
          vw * rw,
          vh * rh,
        ]);
      } else {
        pipeline.setCanvasRect([rx, ry, rw, rh]);
      }
    }
    pipeline.render(ops);
    if (cropModeActive) {
      drawCropOverlay(readCropParams()); // unhides the overlay
    } else {
      cropOverlay.hidden = true;
    }
    // Update zoom indicator after every render.
    updateZoomIndicator();
    
    if (showFps) {
      perfMarks.renderEnd = performance.now();
      logPerformance();
    }
  }

  // Resizes the canvas drawing buffer (guarded -- setting width/height resets
  // the buffer even to the same value) and re-creates the WebGPU surface at the
  // new size. Chrome ties the drawing buffer to the canvas size at configure()
  // time, so the blit target must be reconfigured whenever the buffer changes.
  function ensureCanvasSize(w: number, h: number): void {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      pipeline.show();
    }
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
    // An empty grid used to be a silent void -- the first-run user saw
    // nothing to act on, and a filtered-to-zero view looked broken (review
    // 2026-09-18 #4/QA-gap). renderVisibleRows runs on every rebuild, so the
    // CTA can't disagree with what the grid holds.
    if (gridEntries.length === 0) {
      libraryEmpty.hidden = false;
      libraryEmpty.textContent = folders.length === 0 && allFiles.length === 0
        ? 'Add a folder of photos to start.\nNothing is uploaded -- it is read in your browser only.'
        : 'No photos match this view.\nClear the search or filters, or pick another folder.';
    } else {
      libraryEmpty.hidden = true;
    }
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
        // foot (star N sets *this* photo's rating, clicking the current rating
        // clears it -- the 1..5 keys are what rate the whole selection), color
        // as a left edge bar.
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
          s.title = `${n}\u2605 (rate this photo; click again to clear)`;
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
    const loaded: FileRecord[] = [];
    for (const folder of folders) {
      if (folderFilter !== null && folder.id !== folderFilter) continue;
      loaded.push(...(await listFiles(db, folder.id)));
    }
    // Assign once, at the end: the collection panels count over allFiles, and
    // anything repainted while the list was being rebuilt would otherwise read
    // a half-filled array and show 0.
    allFiles = loaded;
    rebuildGrid(); // repaintGrid() refreshes the filmstrip count
    renderFolderList();
  }

  // Every view switch goes through here. The collection panels read allFiles, so
  // they are repainted only after renderCatalog() resolves -- refreshing them
  // alongside it counts over the file list of the view being left behind (or an
  // unloaded one), which shows stale or zero counts.
  async function reloadCatalog(): Promise<void> {
    await renderCatalog();
    void renderCollections();
    void renderSmartCollections();
  }

  function renderFolderList(): void {
    folderListEl.textContent = '';
    appendFolderRow(null, 'All folders');
    for (const folder of folders) {
      appendFolderRow(folder.id, folder.name);
    }
  }

  async function renderCollections(): Promise<void> {
    collections = await listCollections(db);
    collectionListEl.textContent = '';
    for (const collection of collections) {
      const row = document.createElement('div');
      row.className = 'collection-row' + (activeCollectionId === collection.id ? ' active' : '');
      row.innerHTML = `
        <span class="collection-name">${collection.name}</span>
        <span class="collection-count">${collection.fileIds.length}</span>
        <button class="collection-add" title="Add the selected photos to this collection">＋</button>
        <button class="collection-delete" title="Delete collection">×</button>
      `;
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('collection-add')) {
          e.stopPropagation();
          void addSelectionToCollection(collection);
          return;
        }
        if (target.classList.contains('collection-delete')) {
          e.stopPropagation();
          if (confirm(`Delete collection "${collection.name}"?`)) {
            deleteCollection(db, collection.id!).then(() => renderCollections());
          }
          return;
        }
        activeCollectionId = collection.id!;
        activeSmartCollectionId = null;
        folderFilter = null;
        // renderCatalog(), never rebuildGrid(): rebuildGrid() re-paints the file
        // list it already holds, which is still scoped to the folder that was
        // open a moment ago, so the collection would show only that folder's
        // photos. reloadCatalog() re-reads every folder with folderFilter null.
        void reloadCatalog();
      });
      collectionListEl.appendChild(row);
    }
    syncCollectionActions();
  }

  async function renderSmartCollections(): Promise<void> {
    smartCollections = await listSmartCollections(db);
    smartCollectionListEl.textContent = '';
    for (const smart of smartCollections) {
      const matchingFiles = querySmartCollection(allFiles, smart.criteria);
      const row = document.createElement('div');
      row.className = 'collection-row' + (activeSmartCollectionId === smart.id ? ' active' : '');
      row.innerHTML = `

        <span class="collection-name">${smart.name}</span>
        <span class="collection-count">${matchingFiles.length}</span>
        <button class="collection-edit" title="Edit criteria">&#9998;</button>
        <button class="collection-delete" title="Delete smart collection">×</button>
      `;
      // The rule itself, so a row is readable without opening the dialog.
      row.title = `Matches ${describeCriteria(smart.criteria)}`;
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('collection-edit')) {
          e.stopPropagation();
          openSmartDialog(smart);
          return;
        }
        if (target.classList.contains('collection-delete')) {
          e.stopPropagation();
          if (confirm(`Delete smart collection "${smart.name}"?`)) {
            deleteSmartCollection(db, smart.id!).then(() => renderSmartCollections());
          }
          return;
        }
        activeSmartCollectionId = smart.id!;
        activeCollectionId = null;
        folderFilter = null;
        void reloadCatalog();
      });
      smartCollectionListEl.appendChild(row);
    }
  }


  function appendFolderRow(id: number | null, name: string): void {
    const row = document.createElement('button');
    row.className = 'folder-row' + (folderFilter === id ? ' active' : '');
    row.textContent = name;
    row.addEventListener('click', () => {
      // Folder, collection and smart collection are one view selector between
      // them: rebuildGrid checks the collections first, so a stale
      // activeCollectionId would keep filtering the grid no matter what
      // folder was picked (clicking a folder looked like it did nothing).
      folderFilter = id;
      activeCollectionId = null;
      activeSmartCollectionId = null;
      void reloadCatalog(); // also re-renders the folder list active state
    });
    folderListEl.appendChild(row);
  }

  function renderMetadata(): void {
    metadataEl.textContent = '';
    const file = allFiles.find((f) => f.id === currentFileId);
    if (!file) {
      // The panel was a fully empty column with nothing but its header --
      // read as broken, not as no-selection (visual pass 2026-09-18).
      const hint = document.createElement('p');
      hint.className = 'meta-hint';
      hint.textContent = 'Select a photo to see its file info.';
      metadataEl.appendChild(hint);
      return;
    }
    appendMeta('Name', file.name);
    // A Library selection hasn't decoded yet (lazy pipeline) -- the grid's
    // thumbnail blob knows the dimensions now; fill that row from it instead
    // of showing a permanent em-dash next to the file the user is looking at
    // (review 2026-09-18 #10).
    appendMeta('Dimensions', lastDecoded ? `${lastDecoded.width} × ${lastDecoded.height}` : '…', 'meta-dims');
    appendMeta('Size', file.size >= 1024 * 1024
      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.size / 1024))} KB`); // 0.0 MB is not a size (review #10)
    appendMeta('Modified', new Date(file.lastModified).toLocaleString());
    if (!lastDecoded) {
      // The file itself, not the cached thumbnail -- thumbnails are scaled
      // down (max 320px), and reporting a scaled size as the real one would
      // be a wrong number instead of an honest '…'.
      void file.handle.getFile().then((f) => createImageBitmap(f)).then((bm) => {
        const row = metadataEl.querySelector<HTMLElement>('[data-meta="meta-dims"]');
        if (row && currentFileId === file.id) row.textContent = `${bm.width} × ${bm.height}`;
        bm.close();
      }).catch(() => { /* permission pending or unsupported -- leave '…' */ });
    }
  }

  function appendMeta(label: string, value: string, key?: string): void {
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('span');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'meta-value';
    if (key) v.dataset.meta = key;
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
        applyOpsToSliders(opsAtCursor, currentCameraKey());
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
    // Ratings persisted across reload but the selection evaporated -- the user
    // came back to an unanchored grid (review #6). Remember the last opened
    // photo; init() re-selects it after the catalog loads.
    try { localStorage.setItem('candela.lastFile', String(record.id)); } catch { /* private mode */ }
    // Reset zoom/pan when switching files so each photo opens at fit-to-view.
    viewState = defaultViewState();
    // Temporary perf probe (click-jank investigation): every selection
    // synchronously notifies subscribers -- the filmstrip scrolls the
    // selected cell into view and re-renders its visible cells. Log how long

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
      const alreadyGranted = await queryReadPermission(record.handle);

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
      applyOpsToSliders(ops, currentCameraKey());

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
          applyOpsToSliders(currentOps(currentEditState), currentCameraKey());
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
      } else if (err instanceof ImageDecodeError) {
        showError("Couldn't read this image -- it may be corrupted or in an unsupported format.", err.message);
      } else {
        showError('Something went wrong opening this file.', errorDetail(err));
      }
    }

  }

  // Re-enables the adjust sliders when real (decoded) Bayer data takes over.
  // While a preview is showing they're disabled, so the UI doesn't offer an
  // adjustment that can't do anything.
  function setAdjustEnabled(enabled: boolean): void {
    adjustEnabled = enabled;
    for (const cfg of ALL_SLIDERS) cfg.slider.disabled = !enabled;
    profileSelect.disabled = !enabled;
    lightleakPatternSelect.disabled = !enabled;
    bwTreatmentSelect.disabled = !enabled;
    frameStyleSelect.disabled = !enabled;
    cropAspectSelect.disabled = !enabled;
    rotateCcwBtn.disabled = !enabled;
    rotateCwBtn.disabled = !enabled;
    syncBwEnabled();
    curveAdjust.disabled = !enabled;
    curveCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
    curveResetButton.disabled = !enabled;
    // Dodge & Burn: the brush can't paint on a preview (no decoded texture),
    // so the whole tool (toggle + clear + mode + sliders) locks with the rest.
    dodgeBrushBtn.disabled = !enabled;
    dodgeClearBtn.disabled = !enabled;
    dodgeModeSelect.disabled = !enabled;
    dodgeOverlayColor.disabled = !enabled;
    // No decoded texture -> nothing to overlay; don't leave a stale mask
    // floating over an embedded-JPEG preview.
    if (!enabled) maskOverlay.hidden = true;
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

  // Decodes `record` (LibRaw for raw files, browser native for standard images),
  // sizes the canvas, and uploads the data to the GPU. Callers own the render.
  // Returns false if a newer selection superseded this one mid-decode.
  async function loadIntoPipeline(record: FileRecord, requestId: number): Promise<boolean> {
    // Already showing this file (re-clicking the current photo, or clicking
    // back to one that's loaded) -- nothing to decode; the pipeline holds the
    // image data. This is what keeps filmstrip clicking in Develop fast
    // instead of re-running the decode on every click.
    if (loadedFileId === record.id) return true;
    // Same selection already decoding (e.g. onShow's ensureDevelopImage raced
    // with the click's openFile, both with this requestId) -- share it.
    if (inflightDecode && inflightDecode.id === record.id && inflightDecode.requestId === requestId) {
      return inflightDecode.promise;
    }
    const start = performance.now();
    const promise = (async () => {
      // Fresh photo opens in the clean loupe, not a stale crop workbench.
      setCropMode(false);
      const file = await record.handle.getFile();
      const fileBytes = await file.arrayBuffer();
      if (requestId !== openRequestId) return false; // superseded during file read
      
      const isRaw = isRawFileName(record.name);
      
      if (isRaw) {
        // Raw file: use LibRaw to decode Bayer data
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
              lastDecoded = { width: dims.width, height: dims.height, cameraMeta: null, make: '', model: '' };
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
        // Fresh CPU brush mask at this file's capped dims (the GPU mask texture
        // was just created empty in load()). applyOpsToSliders repopulates it
        // from the loaded edit if this photo has a dodgeBurn op.
        resizePaintMask(decoded.effectiveWidth ?? decoded.width, decoded.effectiveHeight ?? decoded.height);
        // Per-photo grain seed -- deterministic per file, different between
        // photos (two takes get different grain; a re-open gets the same).
        setGrainSeed(seedFromPath(record.path));
        // The fresh (no-WB-op) default renders at the camera's As-Shot gains;
        // the WB slider readout is derived from them (kelvin/tint).
        if (decoded.asShotGains) {
          const cameraKey = cameraCalibrationKey(decoded.make, decoded.model);
          asShotWB = {
            gains: decoded.asShotGains,
            kelvin: gainsToKelvin(decoded.asShotGains, decoded.camXyz, cameraKey),
            tint: gainsToTint(decoded.asShotGains, decoded.camXyz, cameraKey),
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
        lastDecoded = {
          width: decoded.effectiveWidth ?? decoded.width,
          height: decoded.effectiveHeight ?? decoded.height,
          cameraMeta: decoded.cameraMeta,
          make: decoded.make,
          model: decoded.model,
        };
        // waitForGPU() is awaited only for the perf log below -- it doesn't gate
        // anything, since nothing after it touches shared state.
        await pipeline.waitForGPU();
        console.log(`decode+demosaic: ${(performance.now() - start).toFixed(1)}ms (${decoded.width}x${decoded.height})`);
        return true;
      } else {
        // Standard image (JPEG/PNG/TIFF/WebP/HEIC): use browser native decode
        let decodedImage: DecodedImage;
        try {
          decodedImage = await decodeImage(fileBytes);
        } catch (err) {
          if (err instanceof ImageDecodeError) {
            showError("Couldn't read this image -- it may be corrupted or in an unsupported format.", err.message);
          } else {
            showError('Something went wrong opening this file.', errorDetail(err));
          }
          return false;
        }
        if (requestId !== openRequestId) return false; // superseded during decode
        hidePreview();
        canvas.width = decodedImage.width;
        canvas.height = decodedImage.height;
        pipeline.show();
        pipeline.loadImage(decodedImage);
        resizePaintMask(decodedImage.width, decodedImage.height);
        setGrainSeed(seedFromPath(record.path));
        // Standard images have no raw WB data
        asShotWB = null;
        loadedFileId = record.id;
        lastDecoded = {
          width: decodedImage.width,
          height: decodedImage.height,
          cameraMeta: decodedImage.cameraMeta,
          make: decodedImage.make,
          model: decodedImage.model,
        };
        await pipeline.waitForGPU();
        console.log(`image decode: ${(performance.now() - start).toFixed(1)}ms (${decodedImage.width}x${decodedImage.height})`);
        return true;
      }
    })();
    inflightDecode = { id: record.id, requestId, promise };
    try {
      return await promise;
    } finally {
      if (inflightDecode?.id === record.id && inflightDecode.requestId === requestId) inflightDecode = null;
    }
  }

  // Decodes + loads the current selection if its image data isn't already in
  // the pipeline. Called on Develop entry for a file that was selected from
  // Library (which no longer decodes eagerly).
  async function ensureDevelopImage(): Promise<void> {
    // openFile owns the decode for the file it just opened: wait for its
    // promise and let openFile render afterwards. Sharing it via
    // loadIntoPipeline's requestId dedup resolves true the moment the load
    // finishes -- BEFORE openFile's own applyOpsToSliders/renderOps ran --
    // so this caller's render raced ahead of the owner's state and left a
    // blank canvas behind.
    if (inflightDecode && currentFileId !== null && inflightDecode.id === currentFileId) {
      await inflightDecode.promise;
      return;
    }
    if (loadedFileId === currentFileId) return;
    const record = allFiles.find((f) => f.id === currentFileId);
    if (!record) return;
    try {
      await loadIntoPipeline(record, openRequestId);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError("Couldn't read this photo -- it may be corrupted or in an unsupported format.", `LibRaw error ${err.code}`);
      } else if (err instanceof ImageDecodeError) {
        showError("Couldn't read this image -- it may be corrupted or in an unsupported format.", err.message);
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
    try {
      do {
        liveRenderPending = false;
        const start = performance.now();
        renderOps(currentOpsFromSliders());
        await pipeline.waitForGPU();
        console.log(`slider->frame: ${(performance.now() - start).toFixed(1)}ms`);
      } while (liveRenderPending);
    } catch (err) {
      // One failed render must not brick the live loop forever: without the
      // finally below, liveRenderInFlight stays true and every later drag is
      // swallowed as "pending" -- image frozen, no error anywhere (the bug
      // that looked like "bw mix doesn't change anything"). Log and move on.
      console.error('[live render failed]', err);
    } finally {
      liveRenderInFlight = false;
    }
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
      // Opacity/feather live-reshape the painted mask (effectiveMask at upload),
      // so the mask texture must re-upload on drag -- renderOps only re-uploads
      // when dodgeMaskDirty is set, and the slider alone doesn't paint.
      if (cfg.slider === dodgeOpacitySlider || cfg.slider === dodgeFeatherSlider) dodgeMaskDirty = true;
      // Straighten is a crop-tool control: dragging it re-opens the workbench.
      if (cfg.entersCrop) setCropMode(true);
      paintSliders();
      onSliderInput();
    });
    cfg.slider.addEventListener('change', () => {
      commitCurrentEdit();
    });
    // LrC's double-click-to-default: the slider snaps back to the value a
    // fresh open shows. For WB/tint that is the camera's As-Shot (the no-op
    // state applyOpsToSliders renders for an untouched file), not the raw
    // slider midpoint.
    cfg.slider.addEventListener('dblclick', () => {
      if (currentFileId === null) return;
      if (cfg.slider === wbSlider || cfg.slider === tintSlider) {
        wbSlider.value = String(kelvinToWbSlider(asShotWB?.kelvin ?? WB_NEUTRAL_KELVIN));
        tintSlider.value = String(asShotWB?.tint ?? 0);
        wbTouched = false;
      } else {
        cfg.slider.value = String(cfg.neutral);
      }
      paintSliders();
      onSliderInput();
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

  // Film frame is a discrete mode switch like B&W treatment.
  frameStyleSelect.addEventListener('change', () => {
    onSliderInput();
    commitCurrentEdit();
  });

  // Light-leak pattern is a discrete set switch (Auto / Set A..D) -- one
  // render + one history commit per change, like the frame style select.
  lightleakPatternSelect.addEventListener('change', () => {
    onSliderInput();
    commitCurrentEdit();
  });

  // Crop aspect is a discrete pick like profile; the rotate buttons step the
  // quarter-turn state. All three render + commit per change. Picking a preset
  // also drops any freeform drag rect (LrC re-snaps to a centered preset).
  // The Crop/Done button toggles LrC-style crop mode: "Crop" opens the
  // workbench (full image + frame), "Done" refits the loupe to the crop and
  // editing continues on the cropped view. A pure view toggle -- no op change,
  // so no history commit (the crop op was already committed when it moved).
  cropToggleBtn.addEventListener('click', () => {
    if (currentFileId === null) return;
    setCropMode(!cropModeActive);
    onSliderInput();
  });
  cropAspectSelect.addEventListener('change', () => {
    cropFreeform = null;
    setCropMode(true); // picking a preset re-opens the workbench
    onSliderInput();
    commitCurrentEdit();
  });
  rotateCcwBtn.addEventListener('click', () => {
    if (currentFileId === null) return;
    cropRotate90 = (cropRotate90 + 3) % 4;
    recenterCropRect();
    setCropMode(true);
    onSliderInput();
    commitCurrentEdit();
  });
  rotateCwBtn.addEventListener('click', () => {
    if (currentFileId === null) return;
    cropRotate90 = (cropRotate90 + 1) % 4;
    recenterCropRect();
    setCropMode(true);
    onSliderInput();
    commitCurrentEdit();
  });

  // The crop frame is draggable/resizable like LrC: pointer-down on a handle
  // (or inside the rect to move) starts a drag, the rect follows the pointer
  // live (rendered through the normal slider path), and release commits one
  // undo step. Aspect-locked resize uses the selected preset; 'original' is a
  // free drag. The overlay canvas only captures events for the drag.
  cropOverlay.addEventListener('pointerdown', (e) => {
    if (currentFileId === null) return;
    const rect = canvas.getBoundingClientRect();
    const dispScale = rect.width > 0 ? rect.width / canvas.width : 1;
    // Same display-scaled radius as drawCropOverlay draws (fixed CSS px);
    // the margin lets a flush-edge handle's clipped outer half be grabbed.
    const hs = Math.max(8, 12 / dispScale);
    const pt = eventToBufferPt(e, hs);
    if (!pt) return;
    const curCrop = readCropParams();
    const r = cropOverlayRect(curCrop, canvas.width, canvas.height);
    const mode = cropHandleAt(r, pt[0], pt[1], hs);
    if (!mode) return;
    e.preventDefault();
    cropOverlay.setPointerCapture(e.pointerId);
    // cropFreeform stores CENTER + size; a first drag starts from the frame
    // bbox (left/top/size), so convert its center. Feeding the left edge as the
    // center made the first resize-from-default-frame drag land in the wrong
    // place (dragCropRect clamps cx = x + dx/2 off the frame's left corner).
    const cur = cropFreeform ?? { x: (r.x + r.w / 2) / canvas.width, y: (r.y + r.h / 2) / canvas.height, w: r.w / canvas.width, h: r.h / canvas.height };
    cropDrag = { mode, startX: pt[0], startY: pt[1], orig: cur };
  });
  cropOverlay.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    // Same margin as pointerdown so a drag can push a frame flush to the edge
    // (the pointer rides a handle-radius outside the image).
    const rect = canvas.getBoundingClientRect();
    const dispScale = rect.width > 0 ? rect.width / canvas.width : 1;
    const pt = eventToBufferPt(e, Math.max(8, 12 / dispScale));
    if (!pt) return;
    e.preventDefault();
    const curCrop = readCropParams();
    cropFreeform = dragCropRect(cropDrag.mode, cropDrag.orig, pt[0] - cropDrag.startX, pt[1] - cropDrag.startY, canvas.width, canvas.height, curCrop.aspect, curCrop.rotate90);
    onSliderInput();
  });
  const endCropDrag = (): void => {
    if (!cropDrag) return;
    cropDrag = null;
    commitCurrentEdit();
  };
  cropOverlay.addEventListener('pointerup', endCropDrag);
  cropOverlay.addEventListener('pointercancel', endCropDrag);

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

    // Second Monitor support: the controls window mirrors MIRROR_CONTROLS, and
  // paintSliders() pushes every panel repaint into it. Clicking again focuses
  // the window that is already open.
  let controlsWindow: ControlsWindow | null = null;
  const secondMonitorBtn = document.querySelector<HTMLButtonElement>('#second-monitor-btn')!;
  secondMonitorBtn.addEventListener('click', () => {
    if (controlsWindow && !controlsWindow.window.closed) {
      controlsWindow.window.focus();
      return;
    }
    const opened = openControlsWindow({
      controls: MIRROR_CONTROLS,
      onAction: (action) => {
        if (action === 'reset') resetButton.click();
        else if (action === 'copy') void copySettingsToClipboard();
        else void pasteSettingsFromClipboard();
      },
    });
    if (!opened) {
      showError('ไม่สามารถเปิดหน้าต่างควบคุมได้ - อาจถูก popup blocker บล็อก');
      return;
    }
    controlsWindow = opened;
    syncControlsWindow = opened.sync;

    const checkClosed = setInterval(() => {
      if (!opened.window.closed) return;
      clearInterval(checkClosed);
      syncControlsWindow = null;
      controlsWindow = null;
    }, 1000);
  });

  // Export current Develop state -> JPEG/PNG download. The one allowed
  // GPU->CPU readback. A preview (HE*/undecodable file) can't be exported --
  // there's no full-res image behind it, only the embedded JPEG.
  // Social presets are format/bit/long-edge combos (LrC publish services);
  // they don't force a crop aspect -- the user's own crop stands, IG accepts
  // any aspect within the 1080px limit. Selecting one locks the controls;
  // tweaking any of them drops back to Custom.
  // ponytail: no aspect-crop presets (IG story 1080x1920) -- long-edge only.
  const EXPORT_PRESETS: Record<string, { format: string; bitDepth: string; size: string }> = {
    instagram: { format: 'jpeg', bitDepth: '8', size: '1080' },
    facebook: { format: 'jpeg', bitDepth: '8', size: '2048' },
  };
  const applyExportPreset = () => {
    const p = EXPORT_PRESETS[exportPreset.value];
    if (p) {
      exportFormat.value = p.format;
      exportBitDepth.value = p.bitDepth;
      exportSize.value = p.size;
    }
    const custom = !p;
    // JPEG is 8-bit only (LrC disables 16-bit for it too).
    const isJpeg = exportFormat.value === 'jpeg';
    exportFormat.disabled = !custom;
    exportBitDepth.disabled = !custom || isJpeg;
    exportSize.disabled = !custom;
  };
  exportPreset.addEventListener('change', applyExportPreset);
  for (const sel of [exportFormat, exportBitDepth, exportSize]) {
    sel.addEventListener('change', () => {
      if (exportPreset.value !== 'custom') exportPreset.value = 'custom';
      applyExportPreset();
    });
  }
  applyExportPreset();

  exportButton.addEventListener('click', async () => {
    if (currentFileId === null) return;
    if (loadedFileId !== currentFileId) {
      showError("Nothing to export yet — open the photo in Develop first (press E), then export.");
      return;
    }
    const format = exportFormat.value as 'jpeg' | 'png' | 'tiff';
    const bitDepth = exportBitDepth.value === '16' ? 16 : 8;
    const longEdge = exportSize.value === 'original' ? null : Number(exportSize.value);
    exportButton.disabled = true;
    try {
      syncDodgeMaskToGPU();
      const blob = await pipeline.exportImage(currentOpsFromSliders(), { format, bitDepth, longEdge });
      const record = allFiles.find((f) => f.id === currentFileId);
      const base = record?.name.replace(/\.[^.]+$/, '') ?? 'export';
      const ext = format === 'jpeg' ? 'jpg' : format;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError('Export failed.', errorDetail(err));
    } finally {
      exportButton.disabled = false;
    }
  });

  // Performance profiling (Phase 3.4)
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  let currentFps = 0;
  const fpsDisplay = document.createElement('div');
  fpsDisplay.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.7);
    color: #0f0;
    padding: 4px 8px;
    font-family: monospace;
    font-size: 11px;
    border-radius: 3px;
    pointer-events: none;
    z-index: 1000;
    display: none;
  `;
  document.body.appendChild(fpsDisplay);
  
  let showFps = false;
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      showFps = !showFps;
      fpsDisplay.style.display = showFps ? 'block' : 'none';
    }
  });
  
  function updateFpsCounter() {
    if (!showFps) return;
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
      currentFps = frameCount;
      frameCount = 0;
      lastFpsUpdate = now;
      fpsDisplay.textContent = `FPS: ${currentFps}`;
    }
    requestAnimationFrame(updateFpsCounter);
  }
  updateFpsCounter();
  
  // Performance marks for key operations
  const perfMarks = {
    decodeStart: 0,
    decodeEnd: 0,
    renderStart: 0,
    renderEnd: 0,
  };
  
  function logPerformance() {
    if (!showFps) return;
    const decodeTime = perfMarks.decodeEnd - perfMarks.decodeStart;
    const renderTime = perfMarks.renderEnd - perfMarks.renderStart;
    console.log(`[perf] decode: ${decodeTime.toFixed(1)}ms, render: ${renderTime.toFixed(1)}ms`);
  }

  // Edit State Backup (Phase 4.3)
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  
  function startBackupSystem() {
    if (backupTimer) return;
    backupTimer = setInterval(() => {
      if (!currentFileId || !currentEditState) return;
      saveEditState(db, currentFileId, currentEditState).catch(err => {
        console.warn('[backup] failed:', err);
      });
    }, 30000); // 30 seconds
  }
  
  function stopBackupSystem() {
    if (backupTimer) {
      clearInterval(backupTimer);
      backupTimer = null;
    }
  }
  
  // Start backup system
  startBackupSystem();
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    stopBackupSystem();
    // Final save
    if (currentFileId && currentEditState) {
      saveEditState(db, currentFileId, currentEditState).catch(() => {});
    }
  });

  // Batch export functionality
  const batchExportRow = document.querySelector<HTMLElement>('#batch-export-row')!;
  const batchExportBtn = document.querySelector<HTMLButtonElement>('#batch-export-btn')!;
  const exportProgress = document.querySelector<HTMLElement>('#export-progress')!;
  const exportProgressBar = document.querySelector<HTMLElement>('#export-progress-bar')!;
  const exportProgressText = document.querySelector<HTMLElement>('#export-progress-text')!;
  const exportCancelBtn = document.querySelector<HTMLButtonElement>('#export-cancel-btn')!;
  
  let batchExportCancelled = false;
  
  // Update batch export button visibility and text based on selection
  subscribe(() => {
    const selectedIds = getState().selectedIds;
    if (selectedIds.length > 1) {
      batchExportRow.style.display = 'flex';
      batchExportBtn.textContent = `Batch Export Selected (${selectedIds.length})`;
    } else {
      batchExportRow.style.display = 'none';
    }
  });
  
  batchExportBtn.addEventListener('click', async () => {
    const selectedIds = getState().selectedIds;
    if (selectedIds.length < 2) return;
    
    const format = exportFormat.value as 'jpeg' | 'png' | 'tiff';
    const bitDepth = exportBitDepth.value === '16' ? 16 : 8;
    const longEdge = exportSize.value === 'original' ? null : Number(exportSize.value);
    const ext = format === 'jpeg' ? 'jpg' : format;
    
    // Ask user for output directory
    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      
      batchExportCancelled = false;
      batchExportBtn.disabled = true;
      exportButton.disabled = true;
      exportProgress.style.display = 'block';
      exportProgressBar.style.width = '0%';
      exportProgressText.textContent = 'Starting batch export...';
      
      let completed = 0;
      const total = selectedIds.length;
      
      for (const fileId of selectedIds) {
        if (batchExportCancelled) {
          exportProgressText.textContent = `Cancelled (${completed}/${total} completed)`;
          break;
        }
        
        const record = allFiles.find((f) => f.id === fileId);
        if (!record) continue;
        
        exportProgressText.textContent = `Exporting ${completed + 1}/${total}: ${record.name}`;
        
        try {
          // Load the file into pipeline
          const file = await record.handle.getFile();
          const fileBytes = await file.arrayBuffer();
          
          let decoded;
          if (isRawFileName(record.name)) {
            decoded = await decode(fileBytes);
            pipeline.load(decoded);
          } else {
            decoded = await decodeImage(fileBytes);
            pipeline.loadImage(decoded);
          }
          
          // Load edit state
          const editState = await loadEditState(db, fileId);
          const ops = currentOps(editState);
          
          // Export
          syncDodgeMaskToGPU();
          const blob = await pipeline.exportImage(ops, { format, bitDepth, longEdge });
          
          // Save to directory
          const base = record.name.replace(/\.[^.]+$/, '');
          const fileHandle = await dirHandle.getFileHandle(`${base}.${ext}`, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          
          completed++;
          exportProgressBar.style.width = `${(completed / total) * 100}%`;
        } catch (err) {
          console.error(`Failed to export ${record.name}:`, err);
          // Continue with next file
        }
      }
      
      if (!batchExportCancelled) {
        exportProgressText.textContent = `Completed ${completed}/${total} exports`;
      }
      
      // Restore current file
      if (currentFileId) {
        await openFile(allFiles.find(f => f.id === currentFileId)!);
      }
      
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        showError('Batch export failed.', errorDetail(err));
      }
    } finally {
      batchExportBtn.disabled = false;
      exportButton.disabled = false;
      setTimeout(() => {
        exportProgress.style.display = 'none';
      }, 3000);
    }
  });
  
  exportCancelBtn.addEventListener('click', () => {
    batchExportCancelled = true;
    exportProgressText.textContent = 'Cancelling...';
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

  // ---- Dodge & Burn brush ----
  // Paints a signed density mask in display space (positive=dodge,
  // negative=burn). The mask is CPU-authoritative Float32 (the GPU texture is a
  // r8unorm mirror); history stores a compact Int8 quantization. Amount is a
  // magnitude (0..100 -> 0..4 EV); the mode select sets the stroke sign.
  function paintAt(pt: [number, number]): void {
    if (!paintMask) return;
    const p = readDodgeParams();
    const sign = dodgeModeSelect.value === 'dodge' ? 1 : -1;
    const radius = (p.size / 100) * (Math.max(paintMaskW, paintMaskH) / 2);
    const from = lastBrushPt ?? pt;
    paintStroke(paintMask, paintMaskW, paintMaskH, from[0], from[1], pt[0], pt[1], radius, sign);
    lastBrushPt = pt;
    dodgeMaskDirty = true;
    drawDodgeOverlay();
  }

  function endStroke(): void {
    if (!brushPainting) return;
    brushPainting = false;
    lastBrushPt = null;
    // Auto-hide the red mask on pointer-up so the real darken/lighten shows
    // immediately (LrC auto-show).
    drawDodgeOverlay();
    commitCurrentEdit();
  }

  dodgeBrushBtn.addEventListener('click', () => {
    brushActive = !brushActive;
    dodgeBrushBtn.classList.toggle('active', brushActive);
    dodgeBrushBtn.textContent = brushActive ? 'Brush: on' : 'Brush';
    canvas.style.cursor = brushActive ? 'crosshair' : 'default';
    drawDodgeOverlay();
  });

  // Overlay color swatch: recolor the auto-shown mask (LrC's is red by
  // default but swappable) while painting.
  dodgeOverlayColor.addEventListener('input', drawDodgeOverlay);

  dodgeClearBtn.addEventListener('click', () => {
    if (!paintMask) return;
    paintMask.fill(0);
    dodgeMaskDirty = true;
    drawDodgeOverlay();
    renderOps(currentOpsFromSliders());
    commitCurrentEdit();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!brushActive || !adjustEnabled || !paintMask || e.button !== 0) return;
    const pt = eventToMaskPt(e);
    if (!pt) return;
    brushPainting = true;
    lastBrushPt = null;
    paintAt(pt);
    renderOps(currentOpsFromSliders());
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!brushPainting) return;
    const pt = eventToMaskPt(e);
    if (!pt) return;
    paintAt(pt);
    renderOps(currentOpsFromSliders());
  });
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  // ---- zoom & pan (Develop module) ----
  // Mouse wheel → zoom toward cursor; middle-click drag → pan; Z key → toggle zoom.
  // Zoom is bounded [1, 8]; pan is bounded by image edges.
  canvas.addEventListener('wheel', (e) => {
    if (getState().module !== 'develop' || cropModeActive) return;
    e.preventDefault();
    // Zoom factor: 1.1x per wheel tick, clamped to [1, 8].
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(1, Math.min(8, viewState.zoom * zoomFactor));
    if (newZoom === viewState.zoom) return;

    // Cursor position in normalized image coordinates.
    const rect = canvas.getBoundingClientRect();
    const cursorX = (e.clientX - rect.left) / rect.width;
    const cursorY = (e.clientY - rect.top) / rect.height;
    // Convert canvas coords to image coords (account for current view).
    const [vx, vy, vw, vh] = viewStateToCropFrac(viewState);
    const imgX = vx + cursorX * vw;
    const imgY = vy + cursorY * vh;

    viewState = zoomToward(viewState, imgX, imgY, newZoom);
    renderOps(currentOpsFromSliders());
  }, { passive: false });

  // Double-click → jump to 2x (1:1 on a fit view) centered on the cursor,
  // then back to fit. Same cursor->image mapping as the wheel zoom above.
  canvas.addEventListener('dblclick', (e) => {
    if (getState().module !== 'develop' || cropModeActive) return;
    if (viewState.zoom > 1) {
      viewState = defaultViewState();
    } else {
      const rect = canvas.getBoundingClientRect();
      const [vx, vy, vw, vh] = viewStateToCropFrac(viewState);
      const imgX = vx + ((e.clientX - rect.left) / rect.width) * vw;
      const imgY = vy + ((e.clientY - rect.top) / rect.height) * vh;
      viewState = zoomToward(viewState, imgX, imgY, 2);
    }
    renderOps(currentOpsFromSliders());
  });

  // Middle-click drag → pan.
  let panStart: { x: number; y: number; panX: number; panY: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (getState().module !== 'develop' || cropModeActive || e.button !== 1) return;
    e.preventDefault();
    panStart = { x: e.clientX, y: e.clientY, panX: viewState.panX, panY: viewState.panY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!panStart) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - panStart.x) / rect.width;
    const dy = (e.clientY - panStart.y) / rect.height;
    // Convert canvas delta to image delta (account for zoom).
    const [_, __, vw, vh] = viewStateToCropFrac(viewState);
    viewState = panBy(
      { zoom: viewState.zoom, panX: panStart.panX, panY: panStart.panY },
      -dx * vw,
      -dy * vh,
    );
    renderOps(currentOpsFromSliders());
  });
  canvas.addEventListener('pointerup', (e) => {
    if (panStart && e.button === 1) {
      panStart = null;
      canvas.releasePointerCapture(e.pointerId);
    }
  });

  // Z key → toggle zoom: Fit → 100% → 200% → Fit.
  window.addEventListener('keydown', (e) => {
    if (getState().module !== 'develop' || cropModeActive) return;
    if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (viewState.zoom === 1) {
        viewState = { zoom: 2, panX: 0.5, panY: 0.5 };
      } else if (viewState.zoom === 2) {
        viewState = { zoom: 4, panX: 0.5, panY: 0.5 };
      } else {
        viewState = defaultViewState();
      }
      renderOps(currentOpsFromSliders());
    }
  });

  // Zoom toolbar buttons.
  zoomFitBtn.addEventListener('click', () => {
    viewState = defaultViewState();
    renderOps(currentOpsFromSliders());
  });

  zoomFillBtn.addEventListener('click', () => {
    // Fill: zoom so the image fills the canvas (no letterbox).
    // Compute from canvas/image aspect ratio.
    const W = lastDecoded?.width ?? 1;
    const H = lastDecoded?.height ?? 1;
    const canvasAspect = canvas.clientWidth / canvas.clientHeight;
    const imgAspect = W / H;
    const zoom = canvasAspect > imgAspect ? canvasAspect / imgAspect : imgAspect / canvasAspect;
    viewState = { zoom: Math.max(1, zoom), panX: 0.5, panY: 0.5 };
    renderOps(currentOpsFromSliders());
  });
  zoom100Btn.addEventListener('click', () => {
    viewState = { zoom: 2, panX: 0.5, panY: 0.5 }; // 1:1 = 2x on a fit view
    renderOps(currentOpsFromSliders());
  });
  zoom200Btn.addEventListener('click', () => {
    viewState = { zoom: 4, panX: 0.5, panY: 0.5 }; // 2:1 = 4x on a fit view
    renderOps(currentOpsFromSliders());
  });

  // ---- Loupe Info Overlay (Phase 3.1) ----
  // Show EXIF info when hovering top-left corner of canvas
  const infoOverlay = document.createElement('div');
  infoOverlay.id = 'info-overlay';
  infoOverlay.style.cssText = `
    position: absolute;
    top: 10px;
    left: 10px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 10px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.6;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 100;
  `;
  canvas.parentElement?.appendChild(infoOverlay);
  
  let infoOverlayTimeout: number | null = null;
  
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Show overlay when mouse is in top-left 150x150px area
    if (x < 150 && y < 150 && currentFileId && lastDecoded) {
      const file = allFiles.find(f => f.id === currentFileId);
      if (file) {
        const meta = lastDecoded.cameraMeta;
        let info = `<strong>${file.name}</strong><br>`;
        if (lastDecoded.make || lastDecoded.model) {
          info += `${lastDecoded.make} ${lastDecoded.model}<br>`;
        }
        const exifParts = [];
        if (meta?.iso) exifParts.push(`ISO ${meta.iso}`);
        if (meta?.shutter) {
          const exp = meta.shutter;
          if (exp < 1) {
            exifParts.push(`1/${Math.round(1/exp)}s`);
          } else {
            exifParts.push(`${exp}s`);
          }
        }
        if (meta?.aperture) exifParts.push(`f/${meta.aperture}`);
        if (meta?.focal) exifParts.push(`${meta.focal}mm`);
        if (exifParts.length > 0) {
          info += exifParts.join(' · ');
        }

        infoOverlay.innerHTML = info;
        infoOverlay.style.opacity = '1';
        
        if (infoOverlayTimeout) {
          clearTimeout(infoOverlayTimeout);
        }
        infoOverlayTimeout = window.setTimeout(() => {
          infoOverlay.style.opacity = '0';
        }, 3000);
      }
    } else {
      infoOverlay.style.opacity = '0';
      if (infoOverlayTimeout) {
        clearTimeout(infoOverlayTimeout);
        infoOverlayTimeout = null;
      }
    }
  });
  
  canvas.addEventListener('mouseleave', () => {
    infoOverlay.style.opacity = '0';
    if (infoOverlayTimeout) {
      clearTimeout(infoOverlayTimeout);
      infoOverlayTimeout = null;
    }
  });

  // ---- before / after (Develop) ----
  // LrC's \ key holds the original as-imported look; the footer button makes it
  // sticky. "Before" = empty ops (the same fresh-import render Reset shows).

  // but leaves the button lit until clicked again -- acceptable, the momentary
  // \ is the primary gesture.
  let beforeAfter = false;
  let beforeAfterSticky = false;
  function setBeforeAfter(v: boolean, sticky: boolean): void {
    if (beforeAfter === v && beforeAfterSticky === sticky) return;
    beforeAfter = v;
    beforeAfterSticky = sticky;
    beforeAfterBtn.classList.toggle('active', v);
    // currentOpsFromSliders, not currentEditState: a drag live-renders from
    // the sliders while the history commit (which updates currentEditState)
    // runs async on release -- reading the committed state showed the
    // pre-drag edits (or nothing) when leaving Before mode.
    renderOps(v ? [] : currentOpsFromSliders());
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
      // Export this preset to a shareable data file (a .candela-preset.json
      // of the op chain) -- presets are data, not code, so a preset survives
      // as a plain text file you can hand to someone or back up.
      const exportBtn = document.createElement('button');
      exportBtn.textContent = '⤓';
      exportBtn.title = 'Export preset';
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slug = preset.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'preset';
        const blob = new Blob([serializePreset(preset.name, preset.ops)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${slug}${PRESET_FILE_EXT}`;
        a.click();
        URL.revokeObjectURL(url);
      });
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
      row.append(name, exportBtn, del);
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

  // Import a preset from a data file: read + validate (parsePreset throws on
  // anything unrecognizable -- bad JSON, wrong version, ops that fail
  // validation), then save it into the library like a locally-saved preset.
  const presetFileInput = document.createElement('input');
  presetFileInput.type = 'file';
  presetFileInput.accept = '.json';
  presetFileInput.hidden = true;
  document.body.appendChild(presetFileInput);
  presetImportButton.addEventListener('click', () => presetFileInput.click());
  presetFileInput.addEventListener('change', async () => {
    const file = presetFileInput.files?.[0];
    presetFileInput.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      // fallback name = the file's own name minus its extension, for files
      // hand-edited without a `name` field.
      const parsed = parsePreset(await file.text(), file.name.replace(/\.[^.]*$/, ''));
      await savePreset(db, parsed.name, parsed.ops);
      presets = await listPresets(db);
      renderPresets();
    } catch (err) {
      showError("Couldn't import the preset — it isn't a valid preset file.", errorDetail(err));
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
  // 36 per sheet (fewer on the last), overflow starts a new sheet. The sheet
  // follows the same cull filter as the grid (rejects hidden / picks only /
  // min rating) -- a proofing sheet that showed frames the grid had hidden
  // would be useless for culling.
  let contactSheetIdx = 0;

  function renderContactSheet(): void {
    const scope = folderFilter !== null ? allFiles.filter((f) => f.folderId === folderFilter) : [...allFiles];
    const sheets = buildContactSheets(scope, cullFilter);
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
    // One row = one strip of film: 6 frames side by side (real 35mm is cut
    // and printed in 6-frame strips); the sprocket bands are the CSS
    // ::before/::after on .contact-strip.
    const FRAMES_PER_STRIP = 6;
    for (let r = 0; r < frames.length; r += FRAMES_PER_STRIP) {
      const strip = document.createElement('div');
      strip.className = 'contact-strip';
      const inner = document.createElement('div');
      inner.className = 'contact-strip-frames';
      frames.slice(r, r + FRAMES_PER_STRIP).forEach((file, j) => {
        const cell = document.createElement('div');
        cell.className = 'contact-frame';
        cell.title = file.path;
        cell.addEventListener('click', () => {
          openFile(file);
          switchModule('develop'); // proofing: click a frame, see it full
        });
        const num = document.createElement('span');
        num.className = 'contact-frame-num';
        num.textContent = String(contactSheetIdx * CONTACT_SHEET_SIZE + r + j + 1).padStart(2, '0');
        cell.appendChild(num);
        inner.appendChild(cell);
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
      strip.appendChild(inner);
      contactGrid.appendChild(strip);
    }
  }

  // Rasterize the visible sheet to a PNG at 2x, mirroring the DOM strip
  // layout (sprocket bands, 3:2 cover-cropped frames, frame numbers).
  function exportContactSheet(): void {
    const S = 2; // export scale
    const FW = 240 * S; // frame width
    const FH = Math.round((FW * 2) / 3); // 3:2 frame height
    const GAP = 8 * S; // between frames
    const BAND_H = 10 * S; // sprocket band height
    const STRIP_GAP = 6 * S; // band -> frames -> band
    const PAD_X = 12 * S;
    const PAD_Y = 8 * S;
    const SHEET_GAP = 14 * S;
    const PER_STRIP = 6;
    const strips = [...contactGrid.querySelectorAll<HTMLElement>('.contact-strip')];
    if (strips.length === 0) return;
    const stripContentW = PER_STRIP * FW + (PER_STRIP - 1) * GAP;
    const totalW = stripContentW + PAD_X * 2;
    const stripH = PAD_Y * 2 + BAND_H * 2 + STRIP_GAP * 2 + FH;
    const totalH = strips.length * stripH + (strips.length - 1) * SHEET_GAP;
    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0d0d0d'; // paper
    ctx.fillRect(0, 0, totalW, totalH);
    const drawSprocket = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = '#171614';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#d9d5cc';
      const pitch = 7 * S;
      const holeX = 5 * S;
      const holeW = 4 * S;
      for (let hx = x; hx < x + w; hx += pitch * 2) {
        ctx.fillRect(hx + holeX, y + 3 * S, holeW, h - 6 * S);
      }
    };
    strips.forEach((strip, si) => {
      const stripY = si * (stripH + SHEET_GAP);
      ctx.fillStyle = '#232323';
      ctx.fillRect(0, stripY, totalW, stripH);
      drawSprocket(PAD_X, stripY + PAD_Y, stripContentW, BAND_H);
      drawSprocket(PAD_X, stripY + stripH - PAD_Y - BAND_H, stripContentW, BAND_H);
      const framesY = stripY + PAD_Y + BAND_H + STRIP_GAP;
      const cells = [...strip.querySelectorAll<HTMLElement>('.contact-frame')];
      cells.forEach((cell, i) => {
        const x = PAD_X + i * (FW + GAP);
        ctx.fillStyle = '#0a0a0a'; // placeholder while a thumbnail is missing
        ctx.fillRect(x, framesY, FW, FH);
        const img = cell.querySelector<HTMLImageElement>('img');
        if (img && img.complete && img.naturalWidth > 0) {
          const s = Math.max(FW / img.naturalWidth, FH / img.naturalHeight);
          const sw = FW / s;
          const sh = FH / s;
          ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, framesY, FW, FH);
        }
        // frame number chip (matches .contact-frame-num)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(x, framesY, FW, 22 * S);
        ctx.fillStyle = '#eee';
        ctx.font = `${11 * S}px ui-monospace, monospace`;
        const num = cell.querySelector('.contact-frame-num')?.textContent ?? '';
        ctx.fillText(num, x + 6 * S, framesY + 16 * S);
      });
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contact-sheet-${contactSheetIdx + 1}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  // Compare View: side-by-side comparison of selected photos
  function renderCompareView(): void {
    const container = document.querySelector<HTMLElement>('#compare-container')!;
    const empty = document.querySelector<HTMLElement>('#compare-empty')!;
    const selectedIds = getState().selectedIds;
    
    // Clear previous canvases
    container.querySelectorAll('.compare-canvas-wrapper').forEach(el => el.remove());
    
    if (selectedIds.length < 2) {
      empty.style.display = 'flex';
      return;
    }
    
    empty.style.display = 'none';
    
    // Set grid layout based on count
    const count = Math.min(selectedIds.length, 4);
    container.className = 'compare-canvas-container';
    if (count === 2) container.classList.add('grid-1x2');
    else if (count === 3) container.classList.add('grid-1x3');
    else container.classList.add(count === 4 ? 'grid-2x2' : 'grid-1x4');
    
    // Create canvas for each selected photo
    for (let i = 0; i < count; i++) {
      const fileId = selectedIds[i];
      const file = allFiles.find(f => f.id === fileId);
      if (!file) continue;
      
      const wrapper = document.createElement('div');
      wrapper.className = 'compare-canvas-wrapper';
      
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      wrapper.appendChild(canvas);
      
      const label = document.createElement('div');
      label.className = 'compare-canvas-label';
      label.textContent = file.name;
      wrapper.appendChild(label);
      
      container.appendChild(wrapper);
      
      // Load and render the photo
      loadCompareImage(fileId, canvas);
    }
  }
  
  async function loadCompareImage(fileId: number, canvas: HTMLCanvasElement): Promise<void> {
    try {
      const file = allFiles.find(f => f.id === fileId);
      if (!file) return;
      
      // Create a separate pipeline for this canvas
      const comparePipeline = await Pipeline.create(canvas);
      
      // Load the file
      const blob = await file.handle.getFile();
      const buffer = await blob.arrayBuffer();
      if (isRawFileName(file.name)) {
        const decoded = await decode(buffer);
        comparePipeline.load(decoded);
        const editState = await loadEditState(db, fileId);
        const ops = currentOps(editState);
        comparePipeline.render(ops);
      } else {
        const decoded = await decodeImage(buffer);
        comparePipeline.loadImage(decoded);
        const editState = await loadEditState(db, fileId);
        const ops = currentOps(editState);
        comparePipeline.render(ops);
      }
    } catch (err) {
      console.error('Failed to load compare image:', err);
    }
  }
  // ---- print ----
  // The sheet carries the same developed bitmap the Export path produces
  // (exportImage), so a print can never drift from what the sliders show --
  // the only print-specific concern here is laying it out on paper.
  // Paper sizes are the physical sheet sizes in portrait; a 5x7 is photo
  // paper, not a document size.
  const PRINT_PAPERS: Record<string, { w: number; h: number }> = {
    a4: { w: 210, h: 297 },
    letter: { w: 215.9, h: 279.4 },
    '5x7': { w: 127, h: 177.8 },
  };
  let printObjectUrl: string | null = null;

  // @page can't read custom properties, so the sheet size handed to the print
  // dialog lives in a style element rewritten on every layout change.
  const printPageStyle = document.createElement('style');
  document.head.appendChild(printPageStyle);

  function applyPrintLayout(): void {
    const paper = PRINT_PAPERS[printPaper.value] ?? PRINT_PAPERS.a4;
    const landscape = printOrientation.value === 'landscape';
    const w = landscape ? paper.h : paper.w;
    const h = landscape ? paper.w : paper.h;
    printPageEl.style.setProperty('--print-page-w', `${w}mm`);
    printPageEl.style.setProperty('--print-page-h', `${h}mm`);
    printPageEl.style.setProperty('--print-margin', `${printMargin.value}mm`);
    printPageStyle.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
    fitPrintPreview();
  }

  // The preview page is real size (an A4 sheet is 1123px tall); in a shorter
  // window most of it sat below the fold with no hint to scroll (visual pass
  // 2026-09-18). Scale-to-fit down (never up) so the whole sheet reads at a
  // glance; @media print resets the transform, the dialog prints at real size.
  function fitPrintPreview(): void {
    const box = printPageEl.parentElement;
    if (!box || box.clientWidth === 0) return; // hidden module: no geometry
    const availW = box.clientWidth - 48; // .print-content padding
    const availH = box.clientHeight - 48;
    const pageW = printPageEl.offsetWidth || 1;
    const pageH = printPageEl.offsetHeight || 1;
    const scale = Math.max(0.1, Math.min(1, availW / pageW, availH / pageH));
    printPageEl.style.setProperty('--print-scale', String(scale));
  }
  window.addEventListener('resize', fitPrintPreview);

  function setPrintImage(blob: Blob | null): void {
    if (printObjectUrl) {
      URL.revokeObjectURL(printObjectUrl);
      printObjectUrl = null;
    }
    if (!blob) {
      printImageEl.removeAttribute('src');
      printImageEl.hidden = true;
      printEmptyEl.hidden = false;
      return;
    }
    printObjectUrl = URL.createObjectURL(blob);
    printImageEl.src = printObjectUrl;
    printImageEl.hidden = false;
    printEmptyEl.hidden = true;
  }

  async function renderPrintView(): Promise<void> {
    applyPrintLayout();
    // The developed pixels only exist once the file is loaded in the pipeline
    // (openFile decodes lazily), so printing a grid-only selection would print
    // a thumbnail-grade nothing. Say so instead.
    if (currentFileId === null || loadedFileId !== currentFileId) {
      printEmptyEl.textContent = currentFileId === null
        ? 'Select a photo in Library to print it.'
        : "Open this photo in Develop first — its edits aren't on the GPU yet.";
      setPrintImage(null);
      return;
    }
    const url = currentFileId;
    try {
      syncDodgeMaskToGPU();
      const blob = await pipeline.exportImage(currentOpsFromSliders(), {
        format: 'jpeg',
        bitDepth: 8,
        longEdge: null,
      });
      if (currentFileId !== url) return; // selection moved on mid-encode
      setPrintImage(blob);
    } catch (err) {
      showError("Couldn't lay out the print page.", errorDetail(err));
    }
  }

  for (const control of [printPaper, printOrientation, printMargin]) {
    control.addEventListener('change', applyPrintLayout);
  }
  printButton.addEventListener('click', () => {
    window.print();
  });
  applyPrintLayout();

  // ---- module wiring ----
  // ---- module wiring ----
  registerModule({
    id: 'library',
    root: document.querySelector('#module-library')!,
    onShow: () => refreshGrid(),
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
      // chunk across sheets. renderContactSheet derives the roll scope from
      // folderFilter + cullFilter itself, so a folder or cull change shows up
      // the next time the sheet is rendered.
      contactRollLabel.textContent = folderFilter !== null
        ? (folders.find((f) => f.id === folderFilter)?.name ?? 'Roll')
        : 'All folders';
      contactSheetIdx = 0;
      renderContactSheet();
    },
    onHide: () => {},
  });
  registerModule({
    id: 'compare',
    root: document.querySelector('#module-compare')!,
    onShow: () => {
      renderCompareView();
    },
    onHide: () => {},
  });
  registerModule({
    id: 'print',
    root: document.querySelector('#module-print')!,
    // Re-encode on entry: edits made in Develop while this module was hidden
    // are not in the sheet that is already on screen.
    onShow: () => {
      void renderPrintView();
    },
    onHide: () => {},
  });
  contactPrev.addEventListener('click', () => {
    if (contactSheetIdx > 0) {
      contactSheetIdx--;

    }
  });
  contactNext.addEventListener('click', () => {
    contactSheetIdx++;
    renderContactSheet();
  });
  contactExport.addEventListener('click', exportContactSheet);

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-module]')) {
    button.addEventListener('click', () => switchModule(button.dataset.module as ModuleId));
  }

  document.querySelector<HTMLButtonElement>('#help-btn')!.addEventListener('click', () => {
    document.querySelector<HTMLDialogElement>('#help-dialog')!.showModal();
  });

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
    syncCollectionActions();
  });

    // The same "everything selected, else the open photo" rule the settings
  // actions use.
  function selectionTargets(): number[] {
    const { selectedId, selectedIds } = getState();
    return selectedIds.length ? selectedIds : [selectedId].filter((id) => id !== null);
  }

  // Transient footer message; the next selection change repaints that footer
  // from state.
  function flashSelectionInfo(message: string): void {
    selectionInfo.textContent = message;
    setTimeout(() => { selectionInfo.textContent = ''; }, 2000);
  }

  // Copy/paste settings. Named functions, not shortcut-only code: the Second
  // Monitor window's Copy/Paste buttons run the same two, so a clipboard
  // round-trip behaves identically whichever window started it.
  async function copySettingsToClipboard(): Promise<void> {
    if (!currentEditState) return;
    const ops = currentOps(currentEditState);
    try {
      await navigator.clipboard.writeText(JSON.stringify(ops));
      flashSelectionInfo('✓ settings copied');
    } catch (err) {
      showError("Couldn't copy settings.", errorDetail(err));
    }
  }

  async function pasteSettingsFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      const ops = JSON.parse(text) as Op[];
      if (!Array.isArray(ops)) throw new Error('Invalid settings format');
      // Paste to selected photo(s) or current photo.
      const targets = selectionTargets();
      if (!targets.length) return;
      for (const id of targets) {
        const state = await loadEditState(db, id);
        await saveEditState(db, id, commitEdit(state, ops));
      }
      // Re-render if the current file was pasted to.
      if (targets.includes(currentFileId!)) {
        currentEditState = await loadEditState(db, currentFileId!);
        applyOpsToSliders(currentOps(currentEditState));
        renderOps(currentOps(currentEditState));
      }
      flashSelectionInfo(`✓ pasted to ${targets.length} photo${targets.length > 1 ? 's' : ''}`);
    } catch (err) {
      showError("Couldn't paste settings.", errorDetail(err));
    }
  }

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

    // Copy/paste settings (Develop module only).
    if (action.type === 'copy') {
      e.preventDefault();
      await copySettingsToClipboard();
      return;
    }
    if (action.type === 'paste') {
      e.preventDefault();
      await pasteSettingsFromClipboard();
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
      const ids = selectionTargets();
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
          applyCullResult(record, await setCull(db, id, patch));
        }
        // Position in the visible list BEFORE the marks land: refreshCullDependents
        // rebuilds it, and the photo being marked may leave it (reject under
        // hide-rejected, re-rate out of a collection).
        const beforeList = visibleFiles ?? allFiles;
        const refBefore = getState().selectedId;
        const pos = refBefore === null ? -1 : beforeList.findIndex((f) => f.id === refBefore);
        refreshCullDependents();
        // Walk the grid's own list (the old version skipped to a photo the
        // filter hides -- an off-screen "advance" is the phantom-selection bug
        // re-imported). Advance when auto-advance is on, and ALWAYS when the
        // reference photo left the view: X must not orphan the selection or
        // reset the arrow cursor to the top of the grid (review #3).
        const afterList = visibleFiles ?? allFiles;
        const ref = getState().selectedId;
        const refGone = ref === null || !afterList.some((f) => f.id === ref);
        const wantAdvance = refGone ||
          (autoAdvanceCheckbox.checked && ids.length === 1 &&
            (action.type === 'rate' || action.type === 'pick' || action.type === 'reject'));
        if (wantAdvance && getState().module === 'library' && pos >= 0) {
          const afterIds = new Set(afterList.map((f) => f.id));
          let next: FileRecord | null = null;
          for (let i = pos + 1; i < beforeList.length; i++) {
            if (afterIds.has(beforeList[i].id)) { next = beforeList[i]; break; }
          }
          if (next && next.id !== ref) await openFile(next);
        }
      } catch (err) {
        showError("Couldn't save the cull mark.", errorDetail(err));
      }
      return;
    }

    // prev/next walk the same visible list the grid AND the filmstrip show,
    // in every module -- so the arrow keys never land on a photo the user
    // can't see; with no selection yet, the first arrow selects the first
    // file (Lightroom-ish). Falls back to the flat list before the first
    // rebuild.
    e.preventDefault();
    const walk = visibleFiles ?? allFiles;
    const index = walk.findIndex((f) => f.id === getState().selectedId);
    const nextIndex = index === -1 ? 0 : action.type === 'next' ? index + 1 : index - 1;
    const file = walk[nextIndex];
    if (file) await openFile(file);
  });

  // ---- cull filter bar (grid + filmstrip + arrow navigation all follow it) ----
  function applyCullFilterControls(): void {
    cullFilter = {
      hideRejected: filterHideRejected.checked,
      pickedOnly: filterPicked.checked,
      minRating: Number(filterMinRating.value),
      exactRating: exactRatingFilter,
    };
    // The chips' active state tracks the exact filter they own -- no longer
    // mirrored from the Min rating select (different semantics now).
    footerFilterButtons.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.minrating) === cullFilter.exactRating);
    });
    rebuildGrid();
  }
  libraryEmpty.addEventListener('click', () => addFolderButton.click());
  autoAdvanceCheckbox.checked = localStorage.getItem('candela.autoAdvance') === '1';
  autoAdvanceCheckbox.addEventListener('change', () => {
    localStorage.setItem('candela.autoAdvance', autoAdvanceCheckbox.checked ? '1' : '0');
  });

  filterHideRejected.addEventListener('change', applyCullFilterControls);
  filterPicked.addEventListener('change', applyCullFilterControls);
  filterMinRating.addEventListener('change', applyCullFilterControls);
  // Chip click toggles the exact-rating filter (click the active chip again
  // to clear it -- same semantics as the grid stars clearing a rating).
  footerFilterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.minrating);
      exactRatingFilter = exactRatingFilter === v ? 0 : v;
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
  // The strip shows the SAME set the grid shows (a 1-star filter that left 12
  // thumbnails including 2-star photos beside a 1-photo grid read as a broken
  // filter -- user report 2026-09-18). Counts refresh in repaintGrid.
  const filmstrip = createFilmstrip({
    scrollEl: filmstripScroll,
    trackEl: filmstripTrack,
    getFiles: () => visibleFiles ?? allFiles,
    getThumbnail,
    onSelect: (file) => openFile(file),
    onRate: (file, rating) => void rateFile(file, rating),
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
      await reloadCatalog();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showError("Couldn't import that folder.", errorDetail(err));
    } finally {
      addFolderButton.disabled = false;
    }
  });

  // ---- collections ----
  // Photos get into a collection from the grid selection: ＋ on a row adds the
  // selection to that collection, − removes the selection from the open one.
  // Both go through the catalog helpers, so the row counts and the grid always
  // come back from the store rather than being patched locally.
  function syncCollectionActions(): void {
    const { selectedIds } = getState();
    collectionRemoveSelectedBtn.disabled = activeCollectionId === null || selectedIds.length === 0;
  }

  async function addSelectionToCollection(collection: Collection): Promise<void> {
    const ids = selectionTargets();
    if (!ids.length) {
      flashSelectionInfo('select photos first');
      return;
    }
    try {
      await addFilesToCollection(db, collection.id!, ids);
      await renderCollections();
      if (activeCollectionId === collection.id) rebuildGrid();
      flashSelectionInfo(`✓ ${collection.name}: ${ids.length} photo${ids.length > 1 ? 's' : ''} added`);
    } catch (err) {
      showError("Couldn't add photos to the collection.", errorDetail(err));
    }
  }

  collectionRemoveSelectedBtn.addEventListener('click', async () => {
    const collection = collections.find((c) => c.id === activeCollectionId);
    if (!collection) return;
    const ids = selectionTargets();
    if (!ids.length) return;
    try {
      await removeFilesFromCollection(db, collection.id!, ids);
      await renderCollections();
      rebuildGrid();
      flashSelectionInfo(`✓ ${ids.length} removed from ${collection.name}`);
    } catch (err) {
      showError("Couldn't remove photos from the collection.", errorDetail(err));
    }
  });

    // The header + creates a collection *from the selection* -- the only thing
  // "I picked these photos, put them somewhere" can mean in this panel. The
  // smart panel's + is the one that makes a rule; making that difference real
  // is what stops the two + buttons from being confused.
  addCollectionBtn.addEventListener('click', async () => {
    const name = prompt('Collection name:');
    if (!name) return;
    const ids = selectionTargets();
    try {
      const created = await createCollection(db, name, ids);
      await renderCollections();
      flashSelectionInfo(ids.length ? `✓ ${created.name}: ${ids.length} photo${ids.length === 1 ? '' : 's'} added` : `✓ created ${created.name}`);
    } catch (err) {
      showError("Couldn't create collection.", errorDetail(err));
    }
  });

  // ---- smart collection dialog -------------------------------------------
  // Criteria are edited in a real form. The prompt() chain this replaces could
  // express a rating and nothing else, silently turned a typo ("four stars")
  // into an all-photos rule (parseInt -> NaN), and gave no way back in to fix a
  // saved rule. The dialog adds the flag and modified-date criteria the engine
  // already evaluates, and shows the match count before saving.
  let editingSmartId: number | null = null;
  // The photo ids an edited rule was built from. Held across the dialog so a
  // reopened rule shows its own scope -- and so saving an edit never silently
  // re-bounds a saved rule to whatever happens to be selected at the time.
  let editingScopeIds: number[] | null = null;

  function readSmartForm(): CriteriaForm {
    return {
      ratingOp: smartRatingOpSelect.value,
      rating: smartRatingSelect.value,
      flag: smartFlagSelect.value,
      from: smartFromInput.value,
      to: smartToInput.value,
    };
  }

  // The form is half the rule and the scope is the other half, and the scope is
  // not a form value (it is a list of photo ids). Preview and save both go
  // through here, so the count the dialog prints is the count that gets saved.
  function smartCriteriaFromForm(): SmartCollectionCriteria {
    const criteria = buildCriteria(readSmartForm());
    if (smartScopeSelect.value === 'selected') {
      const ids = editingScopeIds ?? getState().selectedIds;
      if (ids.length > 0) criteria.fileIds = [...ids];
    }
    return criteria;
  }

  function updateSmartPreview(): void {
    const criteria = smartCriteriaFromForm();
    const count = querySmartCollection(allFiles, criteria).length;
    // The preview doubles as the validation message: a rule with no conditions
    // and no scope is refused on save, and picking either clears the warning.
    smartPreviewEl.classList.remove('warn');
    smartPreviewEl.textContent = `Matches ${count} photo${count === 1 ? '' : 's'} — ${describeCriteria(criteria)}`;
  }

  function openSmartDialog(existing?: SmartCollection): void {
    editingSmartId = existing?.id ?? null;
    editingScopeIds = existing?.criteria.fileIds ?? null;
    smartDialogTitle.textContent = existing ? 'Edit smart collection' : 'New smart collection';
    const form = existing ? criteriaToForm(existing.criteria) : { ratingOp: '>=', rating: 'any', flag: 'any', from: '', to: '' };
    smartNameInput.value = existing?.name ?? '';
    smartRatingOpSelect.value = form.ratingOp ?? '>=';
    smartRatingSelect.value = form.rating ?? 'any';
    smartFlagSelect.value = form.flag ?? 'any';
    smartFromInput.value = form.from ?? '';
    smartToInput.value = form.to ?? '';

    // Name the scope option with what it holds, then pick it: a saved rule keeps
    // its own scope, while a fresh rule opened right after picking photos starts
    // bounded to them -- that is the reading that made "1 star" pull in every
    // starred photo in the catalog look like a bug rather than a rule.
    const scopeIds = editingScopeIds ?? getState().selectedIds;
    const count = scopeIds.length;
    const scopeOption = smartScopeSelect.querySelector<HTMLOptionElement>('option[value="selected"]')!;
    scopeOption.textContent = editingScopeIds
      ? `Only the ${count} photo${count === 1 ? '' : 's'} this rule was built from`
      : `Only the ${count} selected photo${count === 1 ? '' : 's'}`;
    scopeOption.disabled = count === 0;
    smartScopeSelect.value = existing ? (editingScopeIds ? 'selected' : 'all') : count > 0 ? 'selected' : 'all';

    updateSmartPreview();
    smartDialog.showModal();
    smartNameInput.focus();
  }

  addSmartCollectionBtn.addEventListener('click', () => openSmartDialog());
  smartDialog.addEventListener('input', updateSmartPreview);

// The form is method="dialog", so Save and Cancel both submit and then close
  // it, and the submitter's value says which. Handling submit rather than the
  // dialog's close event is deliberate: the handler can preventDefault() to keep
  // the dialog open when the rule is not saveable yet.
  smartForm.addEventListener('submit', async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== 'save') return;
    const name = smartNameInput.value.trim();
    if (!name) return;
    const criteria = smartCriteriaFromForm();
    // A rule with no conditions and no scope matches every photo in the catalog
    // -- that is
    // how "select two photos, press + here" ends up showing photos the user
    // never selected. Refuse it instead of saving it silently.
    if (!hasCriteria(criteria)) {
      e.preventDefault();
      smartPreviewEl.classList.add('warn');
      smartPreviewEl.textContent = `Pick at least one condition — a rule with none would match every photo (${allFiles.length})`;
      return;
    }
    try {
      if (editingSmartId !== null) {
        await updateSmartCollection(db, editingSmartId, { name, criteria });
      } else {
        await createSmartCollection(db, name, criteria);
      }
      // renderSmartCollections() refreshes the cached list rebuildGrid() filters
      // through, so it has to run first: an edited rule would otherwise keep
      // showing the old photos until some unrelated repaint, and the stale row
      // count already looked right, which is what made it invisible.
      await renderSmartCollections();
      // Only an edit of the rule on screen changes the view; editing any other
      // row must leave it alone.
      if (editingSmartId !== null && activeSmartCollectionId === editingSmartId) rebuildGrid();
    } catch (err) {
      showError("Couldn't save the smart collection.", errorDetail(err));
    }
  });


  // ---- tethered capture ----
  // New frames land in the catalog as the camera writes them, so a shoot can be
  // culled in the grid without leaving the app. Only the watched folder is
  // touched, and only files that appear after watching starts.
  let tethered: TetheredCapture | null = null;

  tetheredStartBtn.addEventListener('click', async () => {
    if (tethered) return;
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // user dismissed the picker
    }
    const capture = new TetheredCapture(
      db,
      dirHandle,
      (name) => {
        tetheredStatusEl.textContent = `Watching ${dirHandle.name} — imported ${name}`;
        void reloadCatalog();
      },
      (err) => showError("Tethered capture couldn't read the folder.", errorDetail(err)),
    );
    try {
      await capture.start();
    } catch (err) {
      showError("Couldn't start tethered capture.", errorDetail(err));
      return;
    }
    tethered = capture;
    tetheredStatusEl.textContent = `Watching ${capture.folderName}`;
    tetheredStartBtn.disabled = true;
    tetheredStopBtn.disabled = false;
  });

  tetheredStopBtn.addEventListener('click', () => {
    tethered?.stop();
    tethered = null;
    tetheredStatusEl.textContent = 'Stopped';
    tetheredStartBtn.disabled = false;
    tetheredStopBtn.disabled = true;
  });

  // ---- search ----
  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;

    activeCollectionId = null;
    activeSmartCollectionId = null;
    rebuildGrid();
  });

  // ---- drag & drop folder import ----
  const libraryContent = document.querySelector<HTMLElement>('#module-library .content')!;
  libraryContent.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  libraryContent.addEventListener('drop', async (e) => {
    e.preventDefault();
    const items = e.dataTransfer?.items;
    if (!items) return;
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry?.isDirectory) {
          try {
            const handle = await (item as any).getAsFileSystemHandle();
            if (handle?.kind === 'directory') {
              await importFolderFromHandle(db, handle);
              await reloadCatalog();
              await renderCollections();
              await renderSmartCollections();
            }

          } catch (err) {
            showError("Couldn't import dropped folder.", errorDetail(err));
          }
        }
      }
    }
  });

  // ---- fullscreen mode ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11' || (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen();
      }
    }
  });

  await renderCatalog();
  await renderCollections();
  await renderSmartCollections();

  {
    const lastId = Number(localStorage.getItem('candela.lastFile') ?? '0');
    const rec = lastId ? allFiles.find((f) => f.id === lastId) : undefined;
    if (rec) await openFile(rec);
    else renderMetadata(); // no restored selection: the panel shows its hint
  }

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
