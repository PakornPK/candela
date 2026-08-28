import type { FileRecord } from '../catalog/types';

// Contact-sheet core, pure and unit-tested. One folder = one film roll laid
// out as 35mm contact sheets (36 frames per sheet, like a 6x6 print).
export const CONTACT_SHEET_SIZE = 36;

// The same cull state the Library grid honors (matchesCullFilter in main.ts).
// The sheet MUST follow it too -- a proofing sheet that still shows rejected
// frames after the grid hid them isn't usable for culling.
export interface ContactCullFilter {
  hideRejected: boolean;
  pickedOnly: boolean;
  minRating: number;
}

export function matchesContactCull(f: FileRecord, filter: ContactCullFilter): boolean {
  if (filter.hideRejected && f.flag === false) return false;
  if (filter.pickedOnly && f.flag !== true) return false;
  if (filter.minRating > 0 && (f.rating ?? 0) < filter.minRating) return false;
  return true;
}

// Filters `scope` through the cull filter, then chunks it into sheets of
// CONTACT_SHEET_SIZE (fewer on the last). Frame order follows `scope` (path
// order from the catalog = filename/shooting order for camera raws).
export function buildContactSheets(scope: FileRecord[], filter: ContactCullFilter): FileRecord[][] {
  const files = scope.filter((f) => matchesContactCull(f, filter));
  const sheets: FileRecord[][] = [];
  for (let i = 0; i < files.length; i += CONTACT_SHEET_SIZE) {
    sheets.push(files.slice(i, i + CONTACT_SHEET_SIZE));
  }
  return sheets;
}
