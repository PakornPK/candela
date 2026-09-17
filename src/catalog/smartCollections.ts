// Smart collections: auto-updating based on criteria.
// Criteria are evaluated against file metadata at query time.

import type { FileRecord } from './types';

export interface SmartCollectionCriteria {
  rating?: { op: '>=' | '<=' | '=' | '>' | '<'; value: number };
  flag?: boolean | null; // true = picked, false = rejected, null = any
  camera?: string; // substring match on camera model
  lens?: string; // substring match on lens model
  dateRange?: { from?: number; to?: number }; // timestamp range
  folderId?: number;
  // The explicit set of photos the rule was built from (the grid selection).
  // `folderId` scopes by where a photo lives; this scopes by which photos the
  // user pointed at. Without it a rule made from a selection is unbounded, so
  // "1 star" means every starred photo in the catalog -- not what someone who
  // just picked four photos and reached for + is asking for.
  fileIds?: number[];
}

export interface SmartCollection {
  id?: number;
  name: string;
  criteria: SmartCollectionCriteria;
  createdAt: number;
  updatedAt: number;
}

export async function listSmartCollections(db: IDBDatabase): Promise<SmartCollection[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('smartCollections', 'readonly');
    const store = tx.objectStore('smartCollections');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createSmartCollection(db: IDBDatabase, name: string, criteria: SmartCollectionCriteria): Promise<SmartCollection> {
  const now = Date.now();
  const smart: SmartCollection = { name, criteria, createdAt: now, updatedAt: now };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('smartCollections', 'readwrite');
    const store = tx.objectStore('smartCollections');
    const request = store.add(smart);
    request.onsuccess = () => {
      smart.id = request.result as number;
      resolve(smart);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function updateSmartCollection(db: IDBDatabase, id: number, updates: Partial<Omit<SmartCollection, 'id' | 'createdAt'>>): Promise<SmartCollection> {
  const smart = await getSmartCollection(db, id);
  if (!smart) throw new Error(`Smart collection ${id} not found`);
  const updated = { ...smart, ...updates, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('smartCollections', 'readwrite');
    const store = tx.objectStore('smartCollections');
    const request = store.put(updated);
    request.onsuccess = () => resolve(updated);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSmartCollection(db: IDBDatabase, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('smartCollections', 'readwrite');
    const store = tx.objectStore('smartCollections');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getSmartCollection(db: IDBDatabase, id: number): Promise<SmartCollection | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('smartCollections', 'readonly');
    const store = tx.objectStore('smartCollections');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

// Evaluate criteria against a file record.
export function matchesCriteria(file: FileRecord, criteria: SmartCollectionCriteria): boolean {
  if (criteria.rating) {
    const rating = file.rating ?? 0;
    const { op, value } = criteria.rating;
    if (op === '>=' && rating < value) return false;
    if (op === '<=' && rating > value) return false;
    if (op === '=' && rating !== value) return false;
    if (op === '>' && rating <= value) return false;
    if (op === '<' && rating >= value) return false;
  }
  if (criteria.flag !== undefined && criteria.flag !== null) {
    if (criteria.flag === true && file.flag !== true) return false;
    if (criteria.flag === false && file.flag !== false) return false;
  }
  if (criteria.camera) {
    const model = (file as any).cameraModel ?? '';
    if (!model.toLowerCase().includes(criteria.camera.toLowerCase())) return false;
  }
  if (criteria.lens) {
    const lens = (file as any).lensModel ?? '';
    if (!lens.toLowerCase().includes(criteria.lens.toLowerCase())) return false;
  }
  if (criteria.dateRange) {
    // `lastModified` is the only timestamp the catalog stores (the "Modified"
    // row in the Metadata panel). There is no EXIF capture date yet, so a date
    // rule keys off it; `dateTaken` wins if a record ever carries one.
    const date = (file as any).dateTaken ?? file.lastModified ?? 0;
    if (criteria.dateRange.from && date < criteria.dateRange.from) return false;
    if (criteria.dateRange.to && date > criteria.dateRange.to) return false;
  }
  if (criteria.folderId !== undefined && file.folderId !== criteria.folderId) return false;
  if (criteria.fileIds && !criteria.fileIds.includes(file.id)) return false;
  return true;
}

// Query files matching smart collection criteria.
export function querySmartCollection(files: FileRecord[], criteria: SmartCollectionCriteria): FileRecord[] {
  return files.filter((f) => matchesCriteria(f, criteria));
}

// ---- form <-> criteria --------------------------------------------------
// The panel edits criteria as form strings (select/date input values). Keeping
// the conversion here, as pure functions, is what the UI and its tests share:
// an "any" select must produce no key at all, or the rule matches nothing.

export interface CriteriaForm {
  ratingOp?: string; // '>=' (default) | '=' | '<='
  rating?: string; // 'any' or '1'..'5'
  flag?: string; // 'any' | 'picked' | 'rejected'
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
}

function parseDay(value?: string): number | null {
  if (!value) return null;
  const day = Date.parse(`${value}T00:00:00`); // local midnight, matching <input type="date">
  return Number.isNaN(day) ? null : day;
}

function dayString(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildCriteria(form: CriteriaForm): SmartCollectionCriteria {
  const criteria: SmartCollectionCriteria = {};
  const rating = Number.parseInt(form.rating ?? '', 10);
  if (!Number.isNaN(rating) && rating > 0) {
    // "1 star" alone means "at least" to Lightroom and "exactly" to almost
    // everyone else, so the operator is a select beside the number rather than
    // a convention the label has to carry. Anything unrecognised falls back to
    // '>=' -- the form can only produce the three options it offers.
    const op = form.ratingOp === '=' || form.ratingOp === '<=' ? form.ratingOp : '>=';
    criteria.rating = { op, value: rating };
  }
  if (form.flag === 'picked') criteria.flag = true;
  else if (form.flag === 'rejected') criteria.flag = false;
  const from = parseDay(form.from);
  const to = parseDay(form.to);
  if (from !== null || to !== null) {
    criteria.dateRange = {};
    if (from !== null) criteria.dateRange.from = from;
    // Inclusive of the whole end day: a file modified at 18:00 on the "before"
    // date has to match, so the bound is that day's last millisecond.
    if (to !== null) criteria.dateRange.to = to + 86_400_000 - 1;
  }
  return criteria;
}

// A rule with no conditions and no scope matches every record, which is
// indistinguishable from the "All folders" view -- and, sitting next to a grid
// selection, it reads as "the photos I picked" while actually pulling in the
// whole catalog. The dialog refuses to save one and says why; buildCriteria
// itself stays a pure form conversion. A rule that only carries a scope (the
// selection, nothing else) is bounded and saves fine.
export function hasCriteria(criteria: SmartCollectionCriteria): boolean {
  return Boolean(
    criteria.fileIds?.length ||
      criteria.rating ||
      (criteria.flag !== undefined && criteria.flag !== null) ||
      criteria.camera ||
      criteria.lens ||
      criteria.dateRange?.from ||
      criteria.dateRange?.to ||
      criteria.folderId !== undefined,
  );
}

export function criteriaToForm(criteria: SmartCollectionCriteria): CriteriaForm {
  const form: CriteriaForm = {
    ratingOp: criteria.rating?.op ?? '>=',
    rating: criteria.rating ? String(criteria.rating.value) : 'any',
    flag: criteria.flag === true ? 'picked' : criteria.flag === false ? 'rejected' : 'any',
  };
  if (criteria.dateRange?.from) form.from = dayString(criteria.dateRange.from);
  // The inclusive end bound (that day's last millisecond) still lands inside the
  // chosen day, so mapping it straight back to a date is the inverse -- stepping
  // back a whole day would show the day before.
  if (criteria.dateRange?.to) form.to = dayString(criteria.dateRange.to);
  return form;
}

// One-line summary for the row tooltip -- so a rule is readable without
// opening the dialog ("rating ≥ 4 · picked").
export function describeCriteria(criteria: SmartCollectionCriteria): string {
  const parts: string[] = [];
  // The scope leads: "4 chosen photos · rating ≥ 1" reads as a bound on the
  // rule, not as one more condition sitting beside the rating.
  if (criteria.fileIds) {
    const n = criteria.fileIds.length;
    parts.push(`${n} chosen photo${n === 1 ? '' : 's'}`);
  }
  if (criteria.rating) {
    const symbol = criteria.rating.op === '>=' ? '≥' : criteria.rating.op === '<=' ? '≤' : criteria.rating.op;
    parts.push(`rating ${symbol} ${criteria.rating.value}`);
  }
  if (criteria.flag === true) parts.push('picked');
  if (criteria.flag === false) parts.push('rejected');
  if (criteria.camera) parts.push(`camera ~ ${criteria.camera}`);
  if (criteria.lens) parts.push(`lens ~ ${criteria.lens}`);
  if (criteria.dateRange) {
    const { from, to } = criteria.dateRange;
    parts.push(`modified ${from ? dayString(from) : '…'} → ${to ? dayString(to) : '…'}`);
  }
  if (criteria.folderId !== undefined) parts.push(`folder #${criteria.folderId}`);
  return parts.length > 0 ? parts.join(' · ') : 'every photo';
}
