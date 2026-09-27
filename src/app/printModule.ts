import type { Op } from '../catalog/types';
import type { Pipeline } from '../gpu/pipeline';

export interface PrintModuleOptions {
  // The pipeline that produces the developed bitmap the sheet prints.
  getPipeline(): Pipeline;
  // The selected photo, or null when nothing is selected.
  getCurrentFileId(): number | null;
  // Which file's pixels are loaded in the pipeline (null = none loaded).
  getLoadedFileId(): number | null;
  // The current Develop slider values as ops.
  currentOps(): Op[];
  // Upload the current dodge/burn mask so the sheet matches the loupe.
  syncDodgeMask(): void;
  // The app's error banner.
  showError(message: string, detail?: string): void;
  // The app's Error -> display string helper.
  errorDetail(err: unknown): string;
}

export interface PrintModule {
  // Re-render the sheet from the current photo and the current sliders.
  render(): Promise<void>;
}

// The Print module's sheet: a real-size page element carrying the developed
// JPEG the Export path would produce, laid out on the selected paper and
// margin, with the @page rule rewritten to match. DOM-owning like filmstrip.ts
// -- main.ts hands it the pipeline, the selection and the error banner, and the
// module keeps the object URL, the scale-to-fit listener and the print button
// to itself. applyPrintLayout / fitPrintPreview / setPrintImage stay private;
// the only thing outside needs is a re-render on module entry.
export function createPrintModule(opts: PrintModuleOptions): PrintModule {
  const printPaper = document.querySelector<HTMLSelectElement>('#print-paper')!;
  const printOrientation = document.querySelector<HTMLSelectElement>('#print-orientation')!;
  const printMargin = document.querySelector<HTMLSelectElement>('#print-margin')!;
  const printButton = document.querySelector<HTMLButtonElement>('#print-btn')!;
  const printPageEl = document.querySelector<HTMLDivElement>('#print-page')!;
  const printImageEl = document.querySelector<HTMLImageElement>('#print-image')!;
  const printEmptyEl = document.querySelector<HTMLDivElement>('#print-empty')!;

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
    const fileId = opts.getCurrentFileId();
    if (fileId === null || opts.getLoadedFileId() !== fileId) {
      printEmptyEl.textContent = fileId === null
        ? 'Select a photo in Library to print it.'
        : "Open this photo in Develop first — its edits aren't on the GPU yet.";
      setPrintImage(null);
      return;
    }
    const url = fileId;
    try {
      const pipeline = opts.getPipeline();
      opts.syncDodgeMask();
      const blob = await pipeline.exportImage(opts.currentOps(), {
        format: 'jpeg',
        bitDepth: 8,
        longEdge: null,
      });
      if (opts.getCurrentFileId() !== url) return; // selection moved on mid-encode
      setPrintImage(blob);
    } catch (err) {
      opts.showError("Couldn't lay out the print page.", opts.errorDetail(err));
    }
  }

  for (const control of [printPaper, printOrientation, printMargin]) {
    control.addEventListener('change', applyPrintLayout);
  }
  printButton.addEventListener('click', () => {
    window.print();
  });
  applyPrintLayout();
  return { render: renderPrintView };
}
