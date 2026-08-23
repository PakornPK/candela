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

// Interactive listeners are attached only after init() succeeds (see below)
// so a file pick or slider move can never race Pipeline.create() -- with no
// pipeline yet assigned, that race would surface as a misleading "failed to
// decode" message instead of the real "WebGPU is not available" cause.
async function init(): Promise<void> {
  let pipeline: Pipeline;
  try {
    pipeline = await Pipeline.create(canvas);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'WebGPU is not available.');
    fileInput.disabled = true;
    exposureSlider.disabled = true;
    wbSlider.disabled = true;
    return;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    clearError();
    try {
      // Tracks the brief's < 2s decode+demosaic budget. Stops right after
      // load() (which does the actual decode + demosaic dispatch), not
      // after the later render() call (adjust + blit, a separate stage) --
      // and waits for the GPU to actually finish the work, not just for
      // submit() to return, since submit() enqueues commands without
      // blocking on their execution.
      const start = performance.now();
      const decoded = await decode(await file.arrayBuffer());
      // WebGPU derives the swap-chain size from the canvas's current
      // dimensions at render time, not from whatever size was in effect
      // when Pipeline.create() called configure() -- so this must happen
      // before load()/render(), not before create().
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      pipeline.load(decoded);
      await pipeline.waitForGPU();
      const elapsed = performance.now() - start;
      console.log(`decode+demosaic: ${elapsed.toFixed(1)}ms (${decoded.width}x${decoded.height})`);
      pipeline.render(state);
    } catch (err) {
      if (err instanceof DecodeError) {
        showError(`Couldn't read this file (LibRaw error ${err.code}).`);
      } else {
        showError(err instanceof Error ? err.message : 'Failed to decode file.');
      }
    }
  });

  // Tracks the brief's < 50ms slider->frame budget. Waits for the GPU to
  // actually finish (see waitForGPU()'s comment) rather than just timing
  // how long it takes to encode and submit the adjust+blit commands.
  async function onSliderInput(): Promise<void> {
    const start = performance.now();
    pipeline.render(state);
    await pipeline.waitForGPU();
    const elapsed = performance.now() - start;
    console.log(`slider->frame: ${elapsed.toFixed(1)}ms`);
  }

  exposureSlider.addEventListener('input', () => {
    state.exposureEV = Number(exposureSlider.value);
    onSliderInput();
  });

  wbSlider.addEventListener('input', () => {
    state.wbShift = Number(wbSlider.value);
    onSliderInput();
  });
}

init();
