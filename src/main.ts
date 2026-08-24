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
import { isExposureOp, isWhiteBalanceOp, type Op, type EditState, type FileRecord } from './catalog/types';

const addFolderButton = document.querySelector<HTMLButtonElement>('#add-folder')!;
const catalogList = document.querySelector<HTMLUListElement>('#catalog-list')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const exposureValue = document.querySelector<HTMLOutputElement>('#exposure-value')!;
const wbValue = document.querySelector<HTMLOutputElement>('#wb-value')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;

function showError(message: string): void {
  errorEl.textContent = message;
}

function clearError(): void {
  errorEl.textContent = '';
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

// Interactive listeners are attached only after init() succeeds -- same
// boundary the spike used for Pipeline.create(), extended to also cover
// opening the catalog database, so neither failure mode can leave a
// half-wired UI behind.
async function init(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openCatalogDb();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to open the catalog database.');
    addFolderButton.disabled = true;
    return;
  }

  let pipeline: Pipeline;
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'WebGPU is not available.');
    addFolderButton.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
    return;
  }

  let currentFileId: number | null = null;
  let currentEditState: EditState | null = null;
  let openRequestId = 0;

  function renderOps(ops: Op[]): void {
    pipeline.render(opsToAdjustState(ops));
  }

  async function renderCatalog(): Promise<void> {
    catalogList.textContent = '';
    const folders = await listFolders(db);
    for (const folder of folders) {
      const folderItem = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = folder.name;
      folderItem.appendChild(heading);

      const fileList = document.createElement('ul');
      const files = await listFiles(db, folder.id);
      for (const file of files) {
        const fileItem = document.createElement('li');
        fileItem.textContent = `${file.path} (${file.size} bytes)`;
        fileItem.addEventListener('click', () => openFile(file));
        fileList.appendChild(fileItem);
      }
      folderItem.appendChild(fileList);
      catalogList.appendChild(folderItem);
    }
  }

  // Permission-checking lives inside this try block (not before it) so a
  // rejection from ensureReadPermission (e.g. requestPermission() called
  // without an active user gesture) is caught the same way a decode
  // failure is, instead of becoming an unhandled rejection.
  async function openFile(record: FileRecord): Promise<void> {
    clearError();
    const requestId = ++openRequestId;
    try {
      if (!(await ensureReadPermission(record.handle))) {
        showError(`Permission needed to read "${record.name}" -- click it again to retry.`);
        return;
      }

      const start = performance.now();
      const file = await record.handle.getFile();
      const decoded = await decode(await file.arrayBuffer());
      if (requestId !== openRequestId) return; // a newer click superseded this one -- drop our result

      canvas.width = decoded.width;
      canvas.height = decoded.height;
      pipeline.load(decoded);
      await pipeline.waitForGPU();
      const elapsed = performance.now() - start;
      console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);

      currentFileId = record.id;
      currentEditState = await loadEditState(db, record.id);
      if (requestId !== openRequestId) return; // superseded again while loading edit state
      const ops = currentOps(currentEditState);
      applyOpsToSliders(ops);
      renderOps(ops);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError(`Couldn't read this file (LibRaw error ${err.code}).`);
      } else {
        showError(err instanceof Error ? err.message : 'Failed to open file.');
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
      showError(err instanceof Error ? err.message : 'Failed to save edit.');
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

  window.addEventListener('keydown', async (e) => {
    if (currentFileId === null || !currentEditState) return;
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    currentEditState = e.shiftKey ? redo(currentEditState) : undo(currentEditState);
    const ops = currentOps(currentEditState);
    applyOpsToSliders(ops);
    renderOps(ops);
    try {
      await saveEditState(db, currentFileId, currentEditState);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to save undo/redo.');
    }
  });

  // AbortError means the user opened the folder picker and dismissed it --
  // the single most common outcome of clicking this button. That's not an
  // error worth surfacing; anything else (a real I/O failure, a rejected
  // permission request during the walk) goes through showError like every
  // other failure path in this file.
  addFolderButton.addEventListener('click', async () => {
    try {
      await importFolder(db);
      await renderCatalog();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showError(err instanceof Error ? err.message : 'Failed to import folder.');
    }
  });

  await renderCatalog();
}

init();
