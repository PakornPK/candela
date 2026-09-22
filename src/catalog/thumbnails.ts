import type { FileRecord, Op } from './types';
import { extractThumbnail } from '../raw/thumbnail';
import { isRawFileName } from './import';
import { ensureReadPermission } from './permissions';
import { loadEditState } from './editsStore';
import { currentOps } from './editHistory';

interface ThumbnailRow {
  fileId: number;
  blob: Blob | null;
  extractedAt: number;
}

// undefined = no row yet (never attempted); null = attempted and failed
// (negative cache, so a permanently-broken thumbnail isn't retried on
// every scroll); Blob = extracted successfully.
export function loadThumbnail(db: IDBDatabase, fileId: number): Promise<Blob | null | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('thumbnails', 'readonly').objectStore('thumbnails').get(fileId);
    request.onsuccess = () => {
      const row = request.result as ThumbnailRow | undefined;
      resolve(row ? row.blob : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

export function saveThumbnail(db: IDBDatabase, fileId: number, blob: Blob | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: ThumbnailRow = { fileId, blob, extractedAt: Date.now() };
    const request = db.transaction('thumbnails', 'readwrite').objectStore('thumbnails').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ---- Developed thumbnails (footer strip, grid, contact sheet) ----
//
// The `thumbnails` store above holds the CAMERA image (embedded JPEG for
// raws, browser decode for standard images). A photo edited in Develop also
// gets a small JPEG rendered through the GPU pipeline and kept in
// `editedThumbnails`, keyed by fileId and tagged with `digest` — a
// deterministic fingerprint of the exact op chain the render shows. A row is
// fresh iff digest === opDigest(currentOps(editState)), which makes undo/redo
// self-healing (walking back to a state rendered before matches instantly)
// and race-safe (a render that finishes after a newer commit carries the
// older digest and simply loses). Nothing to invalidate; correctness is by
// content.

// FNV-1a over the op chain. dodgeBurn masks are hashed byte-wise (they can
// be a 1MB Int8Array — still one linear pass, and they only change on commit).
//
// RENDER FORMAT VERSION: the digest is what makes an editedThumbnail row
// "current". Orientation (sensor flip) is NOT part of the op chain — it is
// baked into the pipeline's normalize pass per FILE — so when the GPU
// orientation fix landed (this change), every pre-existing row in the user's
// catalog was a wrong-orientation render that would keep matching its
// (unchanged) op digest forever and never re-render. Bumping the scheme
// prefix (`v2:`) makes every row written before it stale in one stroke:
// needsEditedThumbnail/getThumbnailBlob compare the full digest string, old
// rows (bare hex) never equal `v2:...`, so the idle-time queue re-renders
// them upright and the new rows overwrite them. This is the cheapest correct
// invalidation: a stored per-file 'flip' field would need a FileRecord schema
// change + a migration for data already in IndexedDB, and would only refresh
// flipped files, missing any other future render-semantics change. Bump the
// prefix (v3, v4, ...) on ANY change that alters the *pixels* a given op
// chain produces without changing the chain itself.
export const RENDER_DIGEST_VERSION = 'v2';

export function opDigest(ops: Op[]): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const feedNum = (n: number) => feed(Number.isFinite(n) ? n.toFixed(6) : 'x');
  for (const op of ops) {
    feed(op.kind);
    switch (op.kind) {
      case 'dodgeBurn':
        feedNum(op.amount); feedNum(op.size); feedNum(op.opacity); feedNum(op.feather);
        feed(`${op.maskW}x${op.maskH}:`);
        for (let i = 0; i < op.mask.length; i++) h = Math.imul(h ^ op.mask[i], 0x01000193) >>> 0;
        break;
      case 'toneCurve':
        if (op.mode === 'region') { feedNum(op.highlights); feedNum(op.lights); feedNum(op.darks); feedNum(op.shadows); }
        else for (const p of op.points) feedNum(p);
        break;
      case 'crop':
        feed(op.aspect); feedNum(op.rotate90); feedNum(op.angle);
        for (const v of [op.x, op.y, op.w, op.h] as (number | undefined)[]) if (v !== undefined) feedNum(v);
        break;
      case 'bw':
        for (const m of op.mix) feedNum(m);
        feed(op.tone);
        break;
      default: {
        const rec = op as unknown as Record<string, unknown>;
        for (const key of Object.keys(rec).sort()) {
          const v = rec[key];
          if (typeof v === 'number') feedNum(v);
          else if (typeof v === 'string') feed(v);
          else if (Array.isArray(v)) for (const n of v as number[]) feedNum(n);
          else if (v && typeof v === 'object') {
            // Nested field objects (whiteBalance.gains): feed sorted entries
            // so any component change moves the digest.
            const o = v as Record<string, number>;
            for (const k2 of Object.keys(o).sort()) feedNum(o[k2]);
          }
        }
      }
    }
    feed(';');
  }
  // Version prefix: rows stored by an older renderer (bare hex, no prefix)
  // can never match a v2 digest, so the whole editedThumbnail cache goes
  // stale on a render-semantics change. See RENDER_DIGEST_VERSION above.
  return `${RENDER_DIGEST_VERSION}:` + h.toString(16);
}

interface EditedThumbnailRow {
  fileId: number;
  blob: Blob;
  digest: string;
  renderedAt: number;
}

export function loadEditedThumbnail(db: IDBDatabase, fileId: number): Promise<EditedThumbnailRow | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('editedThumbnails', 'readonly').objectStore('editedThumbnails').get(fileId);
    request.onsuccess = () => resolve(request.result as EditedThumbnailRow | undefined);
    request.onerror = () => reject(request.error);
  });
}

export function deleteEditedThumbnail(db: IDBDatabase, fileId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('editedThumbnails', 'readwrite').objectStore('editedThumbnails').delete(fileId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function saveEditedThumbnail(db: IDBDatabase, fileId: number, blob: Blob, digest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const row: EditedThumbnailRow = { fileId, blob, digest, renderedAt: Date.now() };
    const request = db.transaction('editedThumbnails', 'readwrite').objectStore('editedThumbnails').put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// The pure freshness decision behind needsEditedThumbnail (kept DB-free and
// exported so it is unit-testable without IndexedDB -- the sidecar.ts pattern
// of pulling logic out of the IDB-wiring layer). A developed render is needed
// when the cached row is absent or carries a different digest than the op
// chain it must show (cachedDigest undefined = no row = mismatch).
//
// For RAWs this applies at ANY op length, including zero: the camera JPEG is
// NOT the developed image. Fuji (and others) bake in-camera film simulations
// into the embedded preview -- a .raf shot under Acros renders B&W in the
// file but color through our pipeline's As-Shot WB + camera profile baseline
// (user report 2026-09-19: strip/grid showed B&W while Develop showed color).
// The pipeline render is the truth for RAWs, so an unedited RAW still needs
// one. Non-RAW files keep the old rule: the browser decode already matches
// the pipeline output, so an empty chain never needs a render.
export function developedRenderNeeded(
  isRaw: boolean,
  opsLength: number,
  cachedDigest: string | undefined,
  currentDigest: string,
): boolean {
  if (cachedDigest === currentDigest) return false;
  return isRaw || opsLength > 0;
}

// True when this photo has no current developed render -- i.e. the caller
// should queue an offscreen render (see developedRenderNeeded for the rule).
export async function needsEditedThumbnail(
  db: IDBDatabase,
  fileId: number,
  ops: Op[],
  isRaw: boolean,
): Promise<boolean> {
  if (ops.length === 0 && !isRaw) return false; // cheap-out: non-RAW unedited never needs one
  try {
    const row = await loadEditedThumbnail(db, fileId);
    return developedRenderNeeded(isRaw, ops.length, row?.digest, opDigest(ops));
  } catch {
    return false; // DB trouble: don't spin up renders for it
  }
}

// The blob a thumbnail cell should show: the developed render when it's
// current for this photo's committed edits, else the camera image (embedded
// or decoded). Callers queue renders for misses; this function never renders.
// For RAWs the editedThumbnails store is consulted even with an EMPTY op
// chain: the camera JPEG is not the developed image (in-camera film sims --
// Fuji Acros shows B&W in the embedded preview while the pipeline's baseline
// render is color, user report 2026-09-19), so the RAW thumbnail is always
// the developed render once one exists; until then the camera JPEG shows as
// the fast placeholder behind the offscreen render queue in main.ts.
export async function getThumbnailBlob(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  try {
    const state = await loadEditState(db, record.id);
    const ops = currentOps(state);
    if (ops.length > 0 || isRawFileName(record.name)) {
      const row = await loadEditedThumbnail(db, record.id);
      if (row && row.digest === opDigest(ops)) return row.blob;
    }
  } catch {
    // A broken edit/render row must not blank the grid; show the camera image.
  }
  return getOrExtractThumbnail(db, record);
}

// The camera image ONLY (contact sheet's 'Camera JPEG' mode): never the
// developed render, even when one is cached.
export async function getEmbeddedThumbnail(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  const cached = await loadThumbnail(db, record.id);
  if (cached !== undefined) return cached ?? undefined;
  return extractCameraThumbnail(db, record);
}

// Shared extraction path for getOrExtractThumbnail / getEmbeddedThumbnail.
async function extractCameraThumbnail(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  if (!(await ensureReadPermission(record.handle))) {
    return undefined; // not yet permitted -- don't negative-cache, may succeed later this session
  }

  try {
    const file = await record.handle.getFile();
    const fileBytes = await file.arrayBuffer();

    // Standard images (JPEG/PNG/TIFF/WebP/HEIC) use browser native decoding;
    // raw files use LibRaw's embedded thumbnail extraction.
    let blob: Blob;
    if (isRawFileName(record.name)) {
      blob = await extractThumbnail(fileBytes);
    } else {
      blob = await createImageThumbnail(fileBytes);
    }

    await saveThumbnail(db, record.id, blob);
    return blob;
  } catch (err) {
    console.warn(`Thumbnail extraction failed for "${record.path}":`, err);
    await saveThumbnail(db, record.id, null);
    return undefined;
  }
}

export async function getOrExtractThumbnail(db: IDBDatabase, record: FileRecord): Promise<Blob | undefined> {
  const cached = await loadThumbnail(db, record.id);
  if (cached !== undefined) return cached ?? undefined;
  return extractCameraThumbnail(db, record);
}

// Creates a thumbnail for a standard image file (JPEG/PNG/TIFF/WebP/HEIC)
// using the browser's native image decoding. Returns a JPEG blob.
async function createImageThumbnail(fileBytes: ArrayBuffer, maxSize = 320): Promise<Blob> {
  const blob = new Blob([fileBytes]);
  const bitmap = await createImageBitmap(blob);

  // Scale down to fit within maxSize while preserving aspect ratio
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to get 2D canvas context for thumbnail');
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}
