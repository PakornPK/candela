// The Library filter bar (gap-analysis P0-5), pure and unit-tested.
//
// LrC's semantics, cloned exactly because a wrong join flips the meaning of a
// cull: values WITHIN one column OR together, columns AND together, and the
// text query ANDs with everything (docs: "finding photos", the Metadata filter
// bar — up to 8 columns, "No Keywords"/"unrated" as explicit menu entries).
// A column holding an EMPTY array is IGNORED, not "matches nothing": that is
// how "clear one column" works without deleting the key's history.
//
// Today's app has folder + min-rating + rating chips + filename search only;
// this module is the data model the parent wires the UI onto. All metadata
// fields on FileRecord are optional (EXIF is being populated by a parallel
// agent), so every predicate treats a missing field as "no match", never as 0
// or ''.
import type { FileRecord } from '../catalog/types';
import { isRawFileName } from '../catalog/import';

export type FilterColumn =
  | 'rating'
  | 'flag'
  | 'label'
  | 'date'
  | 'camera'
  | 'lens'
  | 'iso'
  | 'focal'
  | 'keywords'
  | 'missing'
  | 'fileType'
  // "Has non-empty current ops" — not a FileRecord field: it lives in the
  // edits store, so it filters against ctx.editedIds (see FilterContext).
  | 'edited';

export interface RangeValue {
  kind: 'range';
  from?: number; // inclusive
  to?: number;   // inclusive
}

// LrC's "No Keywords" / "unrated" / "no label" menu entries. Distinct from a
// rating of 0 only in spirit: rating 0 is not stored (culling.ts deletes
// cleared marks), `none` means "the column has no value for this file".
export interface NoneValue {
  kind: 'none';
}

export type FilterValue = number | string | RangeValue | NoneValue;

// LrC's Text filter also searches title/caption/copyright; Candela stores no
// IPTC yet, so the scope is limited to what exists on FileRecord. When IPTC
// lands, add scopes here rather than widening 'any' silently.
export type TextScope = 'any' | 'filename' | 'keywords';

export interface TextFilter {
  query: string;
  scope: TextScope;
}

export type ColumnMap = { [C in FilterColumn]?: FilterValue[] };

export interface FilterState {
  columns: ColumnMap;
  text?: TextFilter;
}

// ---- value vocabulary -----------------------------------------------------
// Strings are the enum values the UI menu would show; the column docs state
// which are meaningful. camera/lens/keywords strings are matched exactly
// (case-insensitive) because LrC's menu offers catalog-derived exact values —
// the text search is the fuzzy tool, the column menu is not.
//   flag:      'picked' | 'rejected'   (none = unflagged)
//   label:     'red' | 'yellow' | 'green' | 'blue'  (none = no label)
//   fileType:  'raw' | 'image'
//   missing:   'missing' | 'present'   (none = present)
//   edited:    'edited' | 'unedited'   (matched against ctx.editedIds, not the row)
const LABEL_CODES: Record<string, number> = { red: 1, yellow: 2, green: 3, blue: 4 };

export const NONE: NoneValue = { kind: 'none' };
export function range(from?: number, to?: number): RangeValue {
  return { kind: 'range', from, to };
}

// ---- applyFilters ----------------------------------------------------------

// Per-render data the row-independent columns read. The 'edited' column is
// not derivable from FileRecord — edits live in their own store, and
// computing the edited set is an async IDB read (editsStore.listEditedFileIds).
export interface FilterContext {
  /** File ids whose current edit state has non-empty ops. ABSENT (never
   * computed) means the 'edited' column is IGNORED entirely — a sync render
   * that races the async computation must not empty the grid. An EMPTY set
   * is a real answer ("nothing is edited") and filters normally. */
  editedIds?: ReadonlySet<number>;
}

export function applyFilters(
  files: FileRecord[],
  state: FilterState,
  ctx: FilterContext = {},
): FileRecord[] {
  // Compile one predicate per active column; empty columns are skipped here,
  // which is the "empty column is ignored" rule in exactly one place.
  const predicates: Array<(f: FileRecord) => boolean> = [];
  for (const column of Object.keys(state.columns) as FilterColumn[]) {
    const values = state.columns[column];
    if (!values || values.length === 0) continue;
    // Same ignore rule, second instance by necessity: the 'edited' column
    // has no data when the set has not arrived yet. Intra-column OR makes
    // ['edited','unedited'] a no-op even WITH the set; skipping the column
    // makes it a no-op WITHOUT it, so a stale filter state can never blank
    // the grid during the async load.
    if (column === 'edited' && ctx.editedIds === undefined) continue;
    predicates.push((f) => values.some((v) => valueMatches(column, v, f, ctx)));
  }
  const text = state.text && state.text.query.trim() !== '' ? state.text : undefined;
  if (text) predicates.push((f) => textMatches(f, text));
  if (predicates.length === 0) return files.slice();
  // One pass, constant per-file work: O(files). Anything that re-scanned the
  // whole list per row (e.g. building distinct value sets) would be quadratic
  // on a 100k catalog — the number this product exists for.
  return files.filter((f) => {
    for (const p of predicates) if (!p(f)) return false;
    return true;
  });
}

function valueMatches(
  column: FilterColumn,
  value: FilterValue,
  f: FileRecord,
  ctx: FilterContext = {},
): boolean {
  if (column === 'edited') {
    // 'edited' has no row field and no none/range/number meaning: anything
    // other than the two vocabulary strings matches nothing, exactly like an
    // unknown value on the flag/missing columns.
    if (typeof value !== 'string') return false;
    const needle = value.toLowerCase();
    const has = ctx.editedIds?.has(f.id) ?? false;
    if (needle === 'edited') return has;
    if (needle === 'unedited') return !has;
    return false;
  }
  if (typeof value === 'object' && 'kind' in value) {
    if (value.kind === 'none') return isAbsent(column, f);
    return inRange(column, value, f);
  }
  if (typeof value === 'number') return numberMatches(column, value, f);
  return stringMatches(column, value, f);
}

// The NoneValue sentinel: LrC's "unrated" / "no flag" / "No Keywords" ...
// A `date` is never absent (lastModified always exists as fallback) and
// fileType is derived from the name, so `none` matches nothing there.
function isAbsent(column: FilterColumn, f: FileRecord): boolean {
  switch (column) {
    case 'rating':
      return (f.rating ?? 0) === 0;
    case 'flag':
      return f.flag === undefined;
    case 'label':
      return !f.color;
    case 'keywords':
      return !f.keywords || f.keywords.length === 0;
    case 'camera':
      return !f.cameraModel;
    case 'lens':
      return !f.lensModel;
    case 'iso':
      return f.iso === undefined;
    case 'focal':
      return f.focalLength === undefined;
    case 'missing':
      return !f.missing; // "none missing" == the file is on disk
    case 'date':
    case 'fileType':
    case 'edited':
      // 'edited' never sees the none sentinel: its "unedited" vocabulary word
      // already IS the negative, and valueMatches handles the column before
      // this switch is reached. Listed for exhaustiveness, not behaviour.
      return false;
  }
}

function inRange(column: FilterColumn, r: RangeValue, f: FileRecord): boolean {
  let v: number | undefined;
  switch (column) {
    case 'rating':
      v = f.rating ?? 0;
      break;
    case 'date':
      v = effectiveDate(f);
      break;
    case 'iso':
      v = f.iso;
      break;
    case 'focal':
      v = f.focalLength;
      break;
    default:
      return false; // ranges are meaningless on enum-like columns
  }
  if (v === undefined) return false;
  if (r.from !== undefined && v < r.from) return false;
  if (r.to !== undefined && v > r.to) return false;
  return true;
}

function numberMatches(column: FilterColumn, value: number, f: FileRecord): boolean {
  switch (column) {
    // LrC's Rating filter is "greater than or equal" — clicking 3 stars shows
    // 3..5. Exact N (our footer chips' semantics) is {kind:'range',from:N,to:N}.
    case 'rating':
      return (f.rating ?? 0) >= value;
    case 'date':
      return effectiveDate(f) === value;
    case 'iso':
      return f.iso === value;
    case 'focal':
      return f.focalLength === value;
    default:
      return false;
  }
}

function stringMatches(column: FilterColumn, value: string, f: FileRecord): boolean {
  const needle = value.toLowerCase();
  switch (column) {
    case 'flag':
      if (needle === 'picked') return f.flag === true;
      if (needle === 'rejected') return f.flag === false;
      return false;
    case 'label':
      return f.color === LABEL_CODES[needle];
    case 'camera':
      return (f.cameraModel ?? '').toLowerCase() === needle;
    case 'lens':
      return (f.lensModel ?? '').toLowerCase() === needle;
    case 'keywords':
      return (f.keywords ?? []).some((k) => k.toLowerCase() === needle);
    case 'missing':
      if (needle === 'missing') return !!f.missing;
      if (needle === 'present') return !f.missing;
      return false;
    case 'fileType': {
      // One allowlist, one source of truth: import.ts decides what is raw at
      // ingest, so anything it accepted that is not raw is an image.
      const isRaw = isRawFileName(f.name);
      if (needle === 'raw') return isRaw;
      if (needle === 'image') return !isRaw;
      return false;
    }
    default:
      return false;
  }
}

// Capture time when EXIF landed, else the file's mtime. The fallback is a
// stopgap until the parallel EXIF agent fills `dateTaken` — for an imported
// archive lastModified is one ingest date for a decade of photos, so date
// filters will read wrong until then. Same precedence as smartCollections.ts.
function effectiveDate(f: FileRecord): number {
  return f.dateTaken ?? f.lastModified;
}

function textMatches(f: FileRecord, t: TextFilter): boolean {
  const q = t.query.trim().toLowerCase();
  switch (t.scope) {
    case 'filename':
      return f.name.toLowerCase().includes(q);
    case 'keywords':
      return (f.keywords ?? []).some((k) => k.toLowerCase().includes(q));
    case 'any': {
      // LrC's "Any Searchable Field", minus fields we do not store (IPTC).
      const hay = [f.name, f.path, f.cameraModel ?? '', f.lensModel ?? '', ...(f.keywords ?? [])]
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    }
  }
}

// ---- pure UI helpers --------------------------------------------------------

// Toggle a value in a column (click chip on / off), returning a NEW state.
// Untouched columns keep their array references — the module's contract is
// "never mutate what you were given", not "deep copy".
export function toggleFilterValue(state: FilterState, column: FilterColumn, value: FilterValue): FilterState {
  const current = state.columns[column] ?? [];
  const idx = current.findIndex((v) => sameValue(v, value));
  const next = idx === -1 ? [...current, value] : current.filter((_, i) => i !== idx);
  return { ...state, columns: { ...state.columns, [column]: next } };
}

// Clear one column: remove the key entirely (equivalent to the ignored-empty
// rule, but keeps the map honest for isFilterActive and JSON round-trips).
export function clearColumn(state: FilterState, column: FilterColumn): FilterState {
  if (!(column in state.columns)) return state;
  const rest = { ...state.columns };
  delete rest[column];
  return { ...state, columns: rest };
}

export function isFilterActive(state: FilterState): boolean {
  if (state.text && state.text.query.trim() !== '') return true;
  for (const column of Object.keys(state.columns) as FilterColumn[]) {
    const values = state.columns[column];
    if (values && values.length > 0) return true;
  }
  return false;
}

function sameValue(a: FilterValue, b: FilterValue): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    if (a.kind === 'none' && b.kind === 'none') return true;
    if (a.kind === 'range' && b.kind === 'range') return a.from === b.from && a.to === b.to;
  }
  return false;
}

// ---- describeFilters --------------------------------------------------------

// Human summary for the Library footer, e.g. "rating at least 4 · camera X100V".
// One phrase per active column, joined with ' · '.
export function describeFilters(state: FilterState): string {
  const parts: string[] = [];
  for (const column of Object.keys(state.columns) as FilterColumn[]) {
    const values = state.columns[column];
    if (!values || values.length === 0) continue;
    parts.push(describeColumn(column, values));
  }
  if (state.text && state.text.query.trim() !== '') {
    const label = state.text.scope === 'filename' ? 'name' : state.text.scope === 'keywords' ? 'kw' : 'text';
    parts.push(`${label} "${state.text.query.trim()}"`);
  }
  return parts.join(' · ');
}

// The nouns the none-sentinel reads against, and the column prefix used when
// a value is a bare word ('camera X100V').
const COLUMN_LABELS: Record<FilterColumn, string> = {
  rating: 'rating',
  flag: 'flag',
  label: 'label',
  date: 'date',
  camera: 'camera',
  lens: 'lens',
  iso: 'ISO',
  focal: 'focal',
  keywords: 'keywords',
  missing: 'files',
  fileType: 'type',
  edited: 'edited',
};

function describeColumn(column: FilterColumn, values: FilterValue[]): string {
  // A lone none-sentinel is a first-class phrase in LrC's own words:
  // "unrated", "no label", "no keywords" — not "rating unrated".
  if (values.length === 1 && typeof values[0] === 'object' && values[0].kind === 'none') {
    if (column === 'rating') return 'unrated';
    if (column === 'missing') return 'files present';
    return `no ${column === 'flag' ? 'flag' : COLUMN_LABELS[column].toLowerCase()}`;
  }
  if (column === 'missing') {
    return values.map((v) => (v === 'missing' ? 'missing files' : 'files present')).join(' / ');
  }
  if (column === 'edited') {
    // Reads as a sentence, not "edited edited": LrC's own menu says
    // "edited"/"not edited" for its Workflow column.
    return values.map((v) => (v === 'unedited' ? 'not edited' : 'edited')).join(' / ');
  }
  return `${COLUMN_LABELS[column]} ${values.map((v) => describeValue(column, v)).join(' / ')}`;
}

function describeValue(column: FilterColumn, v: FilterValue): string {
  if (typeof v === 'object' && v.kind === 'none') return 'none';
  if (typeof v === 'object' && v.kind === 'range') {
    return rangeText(v.from, v.to, column === 'date' ? 'from ' : '');
  }
  if (column === 'rating' && typeof v === 'number') return `at least ${v}`;
  if (column === 'date' && typeof v === 'number') return formatDate(v);
  return String(v);
}

function rangeText(from: number | undefined, to: number | undefined, prefix: string): string {
  const fmt = (n: number) => (prefix === 'from ' ? formatDate(n) : String(n));
  if (from !== undefined && from === to) return fmt(from); // exact value reads as one number, not "3–3"
  const f = from === undefined ? '' : fmt(from);
  const t = to === undefined ? '' : fmt(to);
  if (f && t) return `${prefix}${f}–${t}`; // prefix carries "from " for dates
  if (f) return `at least ${f}`;
  if (t) return `at most ${t}`;
  return 'any';
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- presets ----------------------------------------------------------------
// LrC ships Rated/Unrated/Flagged filter presets; these are the four the cull
// workflow needs in one click. Treated as read-only templates: callers pass
// them to applyFilters or clone them via toggleFilterValue, which never
// mutates its input.

export type FilterPresetId = 'unrated' | 'flagged' | 'rejected' | 'missing';

export const FILTER_PRESETS: Record<FilterPresetId, FilterState> = {
  unrated: { columns: { rating: [NONE] } },
  flagged: { columns: { flag: ['picked'] } },
  rejected: { columns: { flag: ['rejected'] } },
  missing: { columns: { missing: ['missing'] } },
};
