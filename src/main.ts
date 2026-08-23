import { Pipeline } from './gpu/pipeline';
import { decode, DecodeError } from './raw/decode';
import type { AdjustState } from './gpu/uniforms';

const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const exposureSlider = document.querySelector<HTMLInputElement>('#exposure')!;
const wbSlider = document.querySelector<HTMLInputElement>('#wb')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;

const state: AdjustState = { exposureEV: 0, wbShift: 0 };

function showError(message: string): void {
  errorEl.textContent = message;
}

function clearError(): void {
  errorEl.textContent = '';
}

let pipeline: Pipeline;

async function init(): Promise<void> {
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'WebGPU is not available.');
    fileInput.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
  }
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  clearError();
  try {
    const decoded = await decode(await file.arrayBuffer());
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    pipeline.load(decoded);
    pipeline.render(state);
  } catch (err) {
    if (err instanceof DecodeError) {
      showError(`Couldn't read this file (LibRaw error ${err.code}).`);
    } else {
      showError(err instanceof Error ? err.message : 'Failed to decode file.');
    }
  }
});

exposureSlider.addEventListener('input', () => {
  state.exposureEV = Number(exposureSlider.value);
  pipeline?.render(state);
});

wbSlider.addEventListener('input', () => {
  state.wbShift = Number(wbSlider.value);
  pipeline?.render(state);
});

init();
