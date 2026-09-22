// Catalog backup / restore + storage persistence (gap-analysis P0-2).
//
// Why this exists: every rating, edit, collection and keyword lives in ONE
// IndexedDB database that Chrome can evict under disk pressure, and the repo
// never called navigator.storage.persist() (grep was 0 hits). LrC's answer is
// the scheduled catalog backup, and Adobe's own warning is that the catalog IS
// the work product — the photos are re-downloadable, the cull decisions and
// develops are not. This module gives Candela the same two defenses:
//
//   1. Export/import of the catalog as a human-inspectable JSON file. Like an
//      LrC backup it carries metadata only — no photos, no preview blobs
//      (thumbnails are caches and get regenerated).
//   2. requestStoragePersistence(): ask Chrome to never evict our origin.
//
// The file that used to live here was dead (nothing imported it) and wrong
// twice: it JSON.stringify'd a `Map` (which yields `{}`) into localStorage,
// and its name made the next dev believe a backup existed. If you're looking
// for the "auto-save every 30s" behaviour, that's main.ts's `startBackupSystem`
// (XMP sidecars for the open file) — different thing, same fear behind it.
//
// Structure follows the repo pattern (sidecar.ts, orient.ts): all decisions
// are pure and unit-tested in backup.test.ts; the IndexedDB/DOM layer below
// is thin async glue main.ts wires with one call, wireCatalogBackup().


// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/**
 * One array per catalog table. Stores are read verbatim (the app's IndexedDB
 * rows are schemaless, so this module treats them as opaque JSON — only the
 * blob/typed-array rules below inspect values). `keywords` is optional
 * because the current schema (db.ts v5) keeps keywords on FileRecord; the
 * field is wired so a future dedicated store needs no backup-format bump.
 *
 * Deliberately absent: `thumbnails`, `editedThumbnails` (regenerable caches,
 * LrC backups contain no photos or previews) and `presets` (a separate
 * user-asset file format, not catalog state).
 */
export interface CatalogRows {
  folders: unknown[];
  files: unknown[];
  edits: unknown[];
  collections: unknown[];
  smartCollections: unknown[];
  keywords?: unknown[];
}

/** The on-disk envelope. `counts` + `exportedAt` exist so a human who opens
 *  the file can tell what it is and when it was taken without parsing rows. */
export interface CatalogBackupFile {
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
  rows: CatalogRows;
}

export const BACKUP_FORMAT_VERSION = 1;

/** Row fields dropped by serializeCatalog.
 *  - thumbnail/editedThumbnail: the spec's "no previews" rule. They live in
 *    their own stores today, but if a row ever embeds one, it must not ride
 *    along (base64 JPEG in a JSON backup would 4x the file for a cache we
 *    regenerate anyway).
 *  - handle: a FileSystemFile/DirectoryHandle JSON.stringify's to `{}` —
 *    leaving that in makes the file *look* like it holds a disk pointer when
 *    it holds nothing. After a restore the folder picker re-grant flow
 *    (main.ts's restore-access banner) rebuilds handles; ratings/edits
 *    survive in the meantime, which is exactly why this backup exists. */
const DROPPED_ROW_FIELDS = new Set(['thumbnail', 'editedThumbnail', 'handle']);

/** The catalog tables a backup carries, in restore order. */
const CATALOG_STORES = [
  'folders',
  'files',
  'edits',
  'collections',
  'smartCollections',
  'keywords',
] as const;

// ---------------------------------------------------------------------------
// Pure core: serialize / parse
// ---------------------------------------------------------------------------

interface TypedArrayMarker {
  __candela_typed__: string;
  __candela_bytes__: string;
}

/** JSON has no typed arrays, and JSON.stringify(int8Array) produces
 *  `{"0":..,"1":..}` garbage. dodgeBurn ops carry an Int8Array mask, so we
 *  encode any ArrayBufferView as base64 behind a marker. Generic over the
 *  element type — the day an op stores a Float32Array LUT it survives too. */
function encodeTypedArray(value: ArrayBufferView): TypedArrayMarker {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { __candela_typed__: value.constructor.name, __candela_bytes__: btoa(binary) };
}

function decodeTypedArray(marker: TypedArrayMarker): ArrayBufferView {
  const name = marker.__candela_typed__;
  const bytes = atobToBytes(marker.__candela_bytes__);
  const Ctor = TYPED_ARRAY_CTORS[name];
  if (!Ctor) throw new Error(`Backup contains an unknown typed array: ${name}`);
  if (name === 'Uint8Array') return bytes; // the decoded buffer itself, no copy
  return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
}

function atobToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Explicit whitelist instead of a globalThis[name] lookup: the name comes from
// an untrusted file, and `constructor.name` of a custom subclass would resolve
// to anything on window otherwise.
type TypedArrayViewCtor = {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): ArrayBufferView;
};

const TYPED_ARRAY_CTORS: Record<string, TypedArrayViewCtor> = {
  Int8Array: Int8Array,
  Uint8Array: Uint8Array,
  Uint8ClampedArray: Uint8ClampedArray,
  Int16Array: Int16Array,
  Uint16Array: Uint16Array,
  Int32Array: Int32Array,
  Uint32Array: Uint32Array,
  Float32Array: Float32Array,
  Float64Array: Float64Array,
};

function isTypedArrayMarker(value: unknown): value is TypedArrayMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.__candela_typed__ === 'string' && typeof v.__candela_bytes__ === 'string';
}

/** Walk a row tree before stringify: drop preview/handle fields, turn typed
 *  arrays into markers. Unknown fields pass through untouched — forward
 *  compat means a backup written by a newer build still loads here. */
function encodeValue(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Blob) return undefined; // object branch drops the key
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return encodeTypedArray(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const encoded = encodeValue(item);
      if (encoded !== undefined) out.push(encoded);
    }
    return out;
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (DROPPED_ROW_FIELDS.has(key)) continue;
      const encoded = encodeValue(inner);
      if (encoded !== undefined) out[key] = encoded;
    }
    return out;
  }
  return undefined; // functions, symbols — nothing serializable to lose
}

/** Inverse walk after parse: markers become real typed arrays again. */
function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (typeof value === 'object' && value !== null) {
    if (isTypedArrayMarker(value)) return decodeTypedArray(value);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = decodeValue(inner);
    return out;
  }
  return value;
}

function countRows(rows: CatalogRows): Record<string, number> {
  const counts: Record<string, number> = {
    folders: rows.folders.length,
    files: rows.files.length,
    edits: rows.edits.length,
    collections: rows.collections.length,
    smartCollections: rows.smartCollections.length,
  };
  if (rows.keywords) counts.keywords = rows.keywords.length;
  return counts;
}

/**
 * Serialize a catalog snapshot to the backup file's JSON text.
 * Compact (no indent): a 100k-file catalog pretty-printed roughly doubles the
 * download, and the top-level envelope — version/exportedAt/counts — is still
 * the first thing any editor shows when you open the file.
 */
export function serializeCatalog(rows: CatalogRows): string {
  const encoded = encodeValue(rows) as CatalogRows;
  const envelope: CatalogBackupFile = {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: countRows(rows),
    rows: encoded,
  };
  return JSON.stringify(envelope);
}

/**
 * Parse backup JSON into restorable rows. Throws with a clear message when
 * the file is not JSON, is missing/wrong `version`, or has no rows object —
 * a restore is destructive, so "looks like something else" must fail loudly.
 */
export function parseCatalogBackup(json: string): CatalogRows {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new Error('Backup file is empty — nothing to restore.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Backup file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Backup file is not a Candela catalog backup (expected a JSON object).');
  }
  const envelope = parsed as { version?: unknown; rows?: unknown };
  if (typeof envelope.version !== 'number') {
    throw new Error(
      'Backup file has no version field — not a Candela catalog backup ' +
        `(this build reads version ${BACKUP_FORMAT_VERSION}).`,
    );
  }
  if (envelope.version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Backup file is version ${envelope.version}; this build only reads version ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  if (typeof envelope.rows !== 'object' || envelope.rows === null || Array.isArray(envelope.rows)) {
    throw new Error('Backup file has no rows object — refusing to restore an empty shell.');
  }
  const raw = envelope.rows as Partial<Record<(typeof CATALOG_STORES)[number], unknown>>;
  const rows: CatalogRows = {
    folders: [],
    files: [],
    edits: [],
    collections: [],
    smartCollections: [],
  };
  for (const store of CATALOG_STORES) {
    const value = raw[store];
    if (value === undefined) continue; // store added later, or absent — tolerate
    if (!Array.isArray(value)) {
      throw new Error(`Backup rows.${store} is not an array — the file is malformed.`);
    }
    const decoded = value.map(decodeValue);
    if (store === 'keywords') rows.keywords = decoded;
    else rows[store] = decoded;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pure copy
// ---------------------------------------------------------------------------

/** LrC names catalog backups with a date stamp; same idea here. Local date
 *  components on purpose: a user comparing "today's backup" against the
 *  calendar must see today's date, not UTC's. */
export function backupFileName(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `candela-catalog-${y}-${m}-${day}.json`;
}

/** Copy for the destructive confirm dialog. Must state the count and that
 *  the current catalog is replaced — the restore is CLEAR + PUT; there is no
 *  undo (same honesty as LrC's "this will replace your catalog"). */
export function restoreConfirmationMessage(fileCount: number): string {
  const photos = `${fileCount} photo${fileCount === 1 ? '' : 's'}`;
  return (
    `Restore this backup? It REPLACES your entire current catalog.\n\n` +
    `Your catalog now (${photos}) — every rating, edit, collection and keyword — ` +
    `would be overwritten by the backup (${photos}). This cannot be undone.\n\n` +
    `If you are not sure, cancel and export a backup of your current catalog first.`
  );
}

// ---------------------------------------------------------------------------
// Byte formatting + persistence report (pure text part)
// ---------------------------------------------------------------------------

export interface PersistenceReport {
  persisted: boolean;
  usage: number;
  quota: number;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** SI units — disk quotas are quoted in decimal, so '4.2 GB' here means what
 *  Chrome's own storage UI would show, not 4.2 GiB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1000) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${BYTE_UNITS[unit]}`;
}

/** The one-line state shown in #backup-status, e.g.
 *  'Catalog protected from eviction · 12 MB of 4.2 GB'.
 *  The NOT-protected case is the whole point of showing this: a denied
 *  persist() is a state the user must see, not a crash to swallow. */
export function persistenceStatusText(report: PersistenceReport): string {
  const head = report.persisted
    ? 'Catalog protected from eviction'
    : 'NOT protected — Chrome may evict this catalog under disk pressure';
  if (report.usage === 0 && report.quota === 0) return head; // no estimate available
  return `${head} · ${formatBytes(report.usage)} of ${formatBytes(report.quota)}`;
}

// ---------------------------------------------------------------------------
// IndexedDB layer
// ---------------------------------------------------------------------------

function readStore(db: IDBDatabase, name: string): Promise<unknown[]> {
  // A store the schema doesn't have (older db version) yields [] instead of
  // the NotFoundError db.transaction would throw — an old catalog simply has
  // fewer tables, which is a backup shape, not a failure.
  if (!db.objectStoreNames.contains(name)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const request = db.transaction(name, 'readonly').objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    // DOMException is null on some abort paths; an error without a message
    // is worse than a generic one when it surfaces in onError toasts.
    request.onerror = () => reject(request.error ?? new Error(`Could not read '${name}'`));
  });
}

/** Snapshot every catalog table. Sequential on purpose: six parallel getAll()
 *  of 100k rows each is a memory spike in the middle of an export the user
 *  expected to be invisible. */
export async function collectCatalogRows(db: IDBDatabase): Promise<CatalogRows> {
  const rows: CatalogRows = {
    folders: await readStore(db, 'folders'),
    files: await readStore(db, 'files'),
    edits: await readStore(db, 'edits'),
    collections: await readStore(db, 'collections'),
    smartCollections: await readStore(db, 'smartCollections'),
  };
  // keywords exists from a future schema version (today they live on files);
  // keep the field off when the store is absent so counts stay honest.
  if (db.objectStoreNames.contains('keywords')) rows.keywords = await readStore(db, 'keywords');
  return rows;
}

/**
 * CLEAR + PUT one store. Atomicity comes for free from IndexedDB's
 * transaction model: a transaction commits only if EVERY request in it
 * succeeds — if any put errors, the whole transaction (including the clear)
 * aborts and the store is left exactly as it was. So a failed restore can
 * never leave a half-cleared store; the promise rejects with the error and
 * the current catalog survives intact. The clear() and all puts MUST
 * therefore share the single transaction below — one transaction per request
 * would make the clear durable on its own.
 *
 * put(row) preserves each row's exported key (folders/files/collections use
 * keyPath 'id', edits 'fileId'; put with an existing key keeps it), so
 * file.folderId, edit.fileId and collection.fileIds all stay consistent.
 */
function restoreStore(db: IDBDatabase, name: string, records: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(name)) {
      // Backup carries a table this schema doesn't have (newer build wrote
      // it). Skipping keeps an old-schema restore working instead of dying;
      // those rows stay in the file, ready for the next version bump.
      console.warn(`[backup] restore skipped '${name}': store does not exist in this schema`);
      resolve();
      return;
    }
    const tx = db.transaction(name, 'readwrite');
    const store = tx.objectStore(name);
    store.clear();
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error(`Restore of '${name}' aborted`));
    // An unhandled request error aborts the transaction anyway; onerror is
    // here only to surface the real DOMException, not tx.error===null guesswork.
    tx.onerror = () => reject(tx.error ?? new Error(`Restore of '${name}' failed`));
  });
}

/**
 * Replace the whole catalog with the backup's rows, then return the number
 * of file rows restored. Each store restores inside its own atomic
 * transaction (see restoreStore); stores are done sequentially so a failure
 * stops early — any store already committed is exactly the backup's content,
 * and #backup-import-btn re-runs the whole restore to finish the job.
 */
export async function restoreCatalogRows(db: IDBDatabase, rows: CatalogRows): Promise<number> {
  const stores: Array<[store: string, records: unknown[]]> = [
    ['folders', rows.folders],
    ['files', rows.files],
    ['edits', rows.edits],
    ['collections', rows.collections],
    ['smartCollections', rows.smartCollections],
    ['keywords', rows.keywords ?? []],
  ];
  for (const [name, records] of stores) await restoreStore(db, name, records);
  return rows.files.length;
}

// ---------------------------------------------------------------------------
// Browser layer
// ---------------------------------------------------------------------------

/**
 * Ask Chrome not to evict our origin (P0-2 layer 1 — without this, a cull of
 * 10,000 photos can vanish under disk pressure with no warning), then read
 * back how much quota we're using. NEVER throws: persist() can legitimately
 * resolve false (no user gesture, quota policy), and that is a state to show
 * in #backup-status, not a crash. Guarded for browsers with no
 * navigator.storage at all.
 */
export async function requestStoragePersistence(): Promise<PersistenceReport> {
  const report: PersistenceReport = { persisted: false, usage: 0, quota: 0 };
  try {
    const storage: StorageManager | undefined =
      typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : undefined;
    if (!storage) return report;
    try {
      report.persisted = (await storage.persist()) === true;
    } catch {
      report.persisted = false;
    }
    // persist() returns false when *this call* was refused, even if an
    // earlier grant (user or Chrome's heuristics) already holds: persisted()
    // reports the truth so the status line never cries eviction when there
    // will be none.
    if (!report.persisted && typeof storage.persisted === 'function') {
      try {
        report.persisted = (await storage.persisted()) === true;
      } catch {
        /* stay false — can't confirm, report as unprotected */
      }
    }
    try {
      const estimate = await storage.estimate();
      report.usage = estimate.usage ?? 0;
      report.quota = estimate.quota ?? 0;
    } catch {
      /* usage/quota stay 0: persistenceStatusText hides the estimate line */
    }
  } catch {
    /* navigator.storage exploded: report unprotected */
  }
  return report;
}

/** Blob → object URL → click an anchor with [download] → revoke. Lives here
 *  (not main.ts) so the parent's wiring is one call, and so the revoke is
 *  provably paired with the createObjectURL — leaking these pins the whole
 *  catalog string in memory for the tab's lifetime. */
export function downloadCatalogBackup(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** File picker entry → rows. parseCatalogBackup's version/format errors
 *  propagate as rejections; the wiring turns them into onError() toasts. */
export async function readBackupFile(file: File): Promise<CatalogRows> {
  return parseCatalogBackup(await file.text());
}

// ---------------------------------------------------------------------------
// Wiring for main.ts — one call
// ---------------------------------------------------------------------------

/** Element ids the parent adds to index.html. Guarded: a page missing the
 *  section (or any one button) must never crash app boot. */
export const BACKUP_EXPORT_BTN_ID = 'backup-export-btn';
export const BACKUP_IMPORT_BTN_ID = 'backup-import-btn';
export const BACKUP_IMPORT_INPUT_ID = 'backup-import-input';
export const BACKUP_STATUS_ID = 'backup-status';

/** A file as far as this module cares: readable to text. */
export interface BackupFileLike {
  text(): Promise<string>;
}

export interface WireEvent {
  target: WireElement | null;
}

/** The minimal element surface the wiring touches. Real HTMLElements satisfy
 *  this structurally; tests inject fakes, which is how wireCatalogBackup's
 *  control flow is unit-tested without a DOM (no jsdom dependency). */
export interface WireElement {
  addEventListener(type: string, listener: (event: WireEvent) => void): void;
  textContent?: string;
  click?: () => void;
  files?: ArrayLike<BackupFileLike | null> | null;
  accept?: string;
  value?: string;
}

export interface BackupWireDeps {
  db: IDBDatabase;
  /** Called after a restore commits, with the number of file rows restored —
   *  main.ts re-queries the tables and re-renders from here. */
  onRestored: (fileCount: number) => void;
  onError: (title: string, detail?: string) => void;
}

export interface BackupWirePorts {
  getElementById: (id: string) => WireElement | null;
  collectRows: (db: IDBDatabase) => Promise<CatalogRows>;
  restoreRows: (db: IDBDatabase, rows: CatalogRows) => Promise<number>;
  readFile: (file: BackupFileLike) => Promise<CatalogRows>;
  download: (json: string, filename: string) => void;
  confirm: (message: string) => boolean;
  now: () => Date;
  requestPersistence: () => Promise<PersistenceReport>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bind #backup-export-btn / #backup-import-btn / #backup-import-input /
 * #backup-status. main.ts calls this once after openCatalogDb(); adding the
 * markup is the parent's only other job.
 */
export function wireCatalogBackup(deps: BackupWireDeps): void {
  wireCatalogBackupWithPorts(deps, {
    getElementById: (id) => document.getElementById(id) as WireElement | null,
    collectRows: collectCatalogRows,
    restoreRows: restoreCatalogRows,
    readFile: (file) => readBackupFile(file as File),
    download: downloadCatalogBackup,
    confirm: (message) => window.confirm(message),
    now: () => new Date(),
    requestPersistence: requestStoragePersistence,
  });
}

/** wireCatalogBackup with its browser/IDB touchpoints injected — the seam
 *  backup.test.ts uses to exercise the control flow without a DOM. */
export function wireCatalogBackupWithPorts(deps: BackupWireDeps, ports: BackupWirePorts): void {
  const setStatus = (report: PersistenceReport): void => {
    const el = ports.getElementById(BACKUP_STATUS_ID);
    if (el) el.textContent = persistenceStatusText(report);
  };

  // Ask for persistence (and paint the status) even when the page has no
  // #backup-status span: requesting it is the data-loss fix; the span is
  // just the diagnosis. requestStoragePersistence never rejects.
  void ports.requestPersistence().then(setStatus);

  const exportBtn = ports.getElementById(BACKUP_EXPORT_BTN_ID);
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const rows = await ports.collectRows(deps.db);
          ports.download(serializeCatalog(rows), backupFileName(ports.now()));
        } catch (err) {
          deps.onError('Could not export the catalog backup', errorMessage(err));
        }
      })();
    });
  }

  const importBtn = ports.getElementById(BACKUP_IMPORT_BTN_ID);
  const fileInput = ports.getElementById(BACKUP_IMPORT_INPUT_ID);
  if (importBtn && fileInput) {
    // The markup carries the accept attribute; set it here too so a future
    // copy of the section can't import, say, a .lrcat silently.
    fileInput.accept = 'application/json,.json';
    importBtn.addEventListener('click', () => fileInput.click?.());

    fileInput.addEventListener('change', (event) => {
      void (async () => {
        const input = event.target ?? fileInput;
        const file = input.files ? input.files[0] : null;
        // Reset first: Chrome won't fire change when the same file is
        // re-selected, which is exactly what someone retrying a typo'd
        // password-less-but-corrupt backup does.
        if (typeof input.value === 'string') input.value = '';
        if (!file) return;
        try {
          const rows = await ports.readFile(file);
          const fileCount = rows.files.length;
          // Destructive gate: a restore replaces the live catalog.
          if (!ports.confirm(restoreConfirmationMessage(fileCount))) return;
          const restoredFiles = await ports.restoreRows(deps.db, rows);
          deps.onRestored(restoredFiles);
          setStatus(await ports.requestPersistence()); // usage changed
        } catch (err) {
          deps.onError('Could not restore this backup', errorMessage(err));
        }
      })();
    });
  }
}
