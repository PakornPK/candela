import { Pipeline } from './pipeline';
import { decode } from '../raw/decode';
import { decodeImage } from '../raw/imageDecode';
import { isRawFileName } from '../catalog/import';
import { effectiveMask, maskToBytes, opToMask } from './dodge';
import { getGrainSeed, seedFromPath, setGrainSeed } from './grain';
import type { FileRecord, Op } from '../catalog/types';

// An offscreen WebGPU renderer for developed thumbnails and the navigator.
// The main `pipeline` is welded to the loupe canvas (render() blits there and
// load() destroys the file's textures), so anything that must render a DIFFERENT
// file — or the same file while the loupe is busy — needs its own Pipeline over
// a detached canvas. The Compare view already proved the pattern
// (Pipeline.create per canvas); this is the same instance reused serially.
//
// One image lives in its textures at a time (load() destroys the previous —
// same memory discipline as the main pipeline), and calls are serialized:
// concurrent loads would trash each other's textures mid-render.
export class OffscreenRenderer {
  private pipeline: Promise<Pipeline> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private loadedFileId: number | null = null;

  // The canvas is never attached: WebGPU accepts a canvas-context surface on a
  // detached element (verified in-browser — getCurrentTexture returns the
  // buffer at the element's size), and exportImage's 8-bit path already
  // readbacks through its own scratch canvas.
  private ensure(): Promise<Pipeline> {
    if (!this.pipeline) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      this.pipeline = Pipeline.create(canvas).catch((err) => {
        this.pipeline = null; // a failed create must not poison later calls
        throw err;
      });
    }
    return this.pipeline;
  }

  // Renders `record` with `ops` to a JPEG Blob at `longEdge` px (crop applied,
  // exactly like the loupe's export path). Serialized; safe to call fire-and-
  // forget — errors reject the returned promise, never corrupt the queue.
  renderThumbnail(record: FileRecord, ops: Op[], longEdge: number): Promise<Blob> {
    const run = this.queue.then(async () => {
      const pipeline = await this.ensure();
      if (this.loadedFileId !== record.id) {
        const file = await record.handle.getFile();
        const bytes = await file.arrayBuffer();
        if (isRawFileName(record.name)) {
          pipeline.load(await decode(bytes));
        } else {
          pipeline.loadImage(await decodeImage(bytes));
        }
        this.loadedFileId = record.id;
      }
      // The dodge/burn mask texture was created empty at load(); the live
      // path's syncDodgeMaskToGPU only knows the LOUPE's paint state. For an
      // arbitrary op chain, rebuild the effective mask from the op itself so
      // a dodged photo doesn't thumbnail flat (same CPU->bytes path main.ts
      // uses before pipeline.render).
      const db = ops.find((op) => op.kind === 'dodgeBurn');
      if (db && db.kind === 'dodgeBurn') {
        const mask = effectiveMask(opToMask(db), db.maskW, db.maskH, db.opacity, db.feather);
        pipeline.setDodgeMask(maskToBytes(mask));
      }
      // Grain is seeded per file so a thumbnail's noise matches the loupe's;
      // the seed is a module global, so restore the loupe's afterwards --
      // otherwise a strip render of another file would flip the grain pattern
      // mid-edit on the loupe (the next renderOps uses whatever seed is set).
      const prevSeed = getGrainSeed();
      setGrainSeed(seedFromPath(record.path));
      try {
        // exportImage readbacks + encodes through a scratch canvas; the surface
        // itself is unused. 8-bit JPEG (0.92) is plenty at thumbnail sizes.
        return await pipeline.exportImage(ops, { format: 'jpeg', bitDepth: 8, longEdge });
      } finally {
        setGrainSeed(prevSeed);
      }
    });
    this.queue = run.catch(() => {}); // keep the queue alive after a failure
    return run;
  }

  // The file whose data currently sits in the textures (navigator fast path:
  // re-rendering the same image at a new digest skips decode entirely).
  get currentFileId(): number | null {
    return this.loadedFileId;
  }
}
