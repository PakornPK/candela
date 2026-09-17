import { describe, it, expect } from 'vitest';
import { matchesCriteria, querySmartCollection, buildCriteria, criteriaToForm, describeCriteria, hasCriteria, type SmartCollectionCriteria } from './smartCollections';
import type { FileRecord } from './types';

// Only the fields the criteria engine reads matter here, so the file handle is a
// stub cast -- nothing in these tests touches the filesystem.
function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 1,
    folderId: 1,
    path: 'day1/a.jpg',
    name: 'a.jpg',
    handle: {} as FileSystemFileHandle,
    size: 1,
    lastModified: Date.parse('2024-05-10T18:00:00'),
    ...overrides,
  };
}

describe('matchesCriteria', () => {
  it('treats an unrated photo as 0 stars, not as a pass for rating >= 1', () => {
    expect(matchesCriteria(file({ rating: 4 }), { rating: { op: '>=', value: 4 } })).toBe(true);
    expect(matchesCriteria(file({ rating: 3 }), { rating: { op: '>=', value: 4 } })).toBe(false);
    expect(matchesCriteria(file(), { rating: { op: '>=', value: 1 } })).toBe(false);
  });

  it('keeps rejected and picked rules disjoint, and neither matches unflagged photos', () => {
    expect(matchesCriteria(file({ flag: false }), { flag: false })).toBe(true);
    expect(matchesCriteria(file({ flag: true }), { flag: false })).toBe(false);
    // The absent flag case: an unflagged photo must not read as "rejected".
    expect(matchesCriteria(file(), { flag: false })).toBe(false);
    expect(matchesCriteria(file(), { flag: true })).toBe(false);
    // null means "any flag", so everything passes.
    expect(matchesCriteria(file(), { flag: null })).toBe(true);
  });

  it('matches every photo when no criteria are set', () => {
    expect(querySmartCollection([file(), file({ rating: 5 }), file({ flag: false })], {})).toHaveLength(3);
  });

  it('dates a rule off lastModified, the one timestamp the catalog stores', () => {
    const inRange: SmartCollectionCriteria = { dateRange: { from: Date.parse('2024-05-01T00:00:00'), to: Date.parse('2024-05-31T23:59:59.999') } };
    expect(matchesCriteria(file(), inRange)).toBe(true);
    expect(matchesCriteria(file({ lastModified: Date.parse('2024-06-01T09:00:00') }), inRange)).toBe(false);
  });

  it('prefers a recorded capture date over the file timestamp', () => {
    const shotIn2019 = { ...file(), dateTaken: Date.parse('2019-03-02T10:00:00') } as FileRecord;
    expect(matchesCriteria(shotIn2019, { dateRange: { from: Date.parse('2024-01-01T00:00:00') } })).toBe(false);
  });

  it('filters by folder and by camera substring', () => {
    expect(matchesCriteria(file({ folderId: 7 }), { folderId: 7 })).toBe(true);
    expect(matchesCriteria(file({ folderId: 7 }), { folderId: 8 })).toBe(false);
    const withCamera = { ...file(), cameraModel: 'X100V' } as FileRecord;
    expect(matchesCriteria(withCamera, { camera: 'x100' })).toBe(true);
    // No stored camera model means no match -- the silent-empty case the UI avoids.
    expect(matchesCriteria(file(), { camera: 'x100' })).toBe(false);
  });
});

describe('buildCriteria', () => {
  it('omits a criterion the form left at "any"', () => {
    expect(buildCriteria({ rating: 'any', flag: 'any' })).toEqual({});
    expect(buildCriteria({})).toEqual({});
  });

  it('maps a minimum rating and the two flags', () => {
    expect(buildCriteria({ rating: '4' })).toEqual({ rating: { op: '>=', value: 4 } });
    expect(buildCriteria({ flag: 'picked' })).toEqual({ flag: true });
    expect(buildCriteria({ flag: 'rejected' })).toEqual({ flag: false });
  });

  it('ignores junk in the rating field instead of turning it into "every photo"', () => {
    // A rule with no key at all matches everything, so a rating of 0/"any"
    // must be left out deliberately -- never by a failed parse.
    expect(buildCriteria({ rating: '0' })).toEqual({});
    expect(buildCriteria({ rating: '' })).toEqual({});
  });

  it('keeps the operator the form picked, defaulting to "at least"', () => {
    // "1 star" next to a "Rating" label reads as exactly one star; the engine's
    // default is at-least. The select is what removes that guess.
    expect(buildCriteria({ rating: '1', ratingOp: '=' })).toEqual({ rating: { op: '=', value: 1 } });
    expect(buildCriteria({ rating: '2', ratingOp: '<=' })).toEqual({ rating: { op: '<=', value: 2 } });
    expect(buildCriteria({ rating: '2', ratingOp: '>=' })).toEqual({ rating: { op: '>=', value: 2 } });
    expect(buildCriteria({ rating: '2' })).toEqual({ rating: { op: '>=', value: 2 } });
    // Junk from a stale DOM falls back to the default rather than widening or
    // inverting a saved rule.
    expect(buildCriteria({ rating: '2', ratingOp: 'nonsense' })).toEqual({ rating: { op: '>=', value: 2 } });
  });

  it('bounds the end date at the last millisecond of that day', () => {
    const criteria = buildCriteria({ from: '2024-05-01', to: '2024-05-10' });
    expect(criteria.dateRange).toEqual({ from: Date.parse('2024-05-01T00:00:00'), to: Date.parse('2024-05-10T23:59:59.999') });
    // The whole point of the inclusive bound: a photo modified at 18:00 on the
    // end date still matches.
    expect(matchesCriteria(file(), criteria)).toBe(true);
  });
});

describe('hasCriteria', () => {
  it('rejects a rule that would match every photo', () => {
    // The dialog refuses to save these: an empty rule is indistinguishable from
    // "All folders", and next to a grid selection it reads as "the photos I
    // picked" while actually pulling in the whole catalog.
    expect(hasCriteria({})).toBe(false);
    expect(hasCriteria(buildCriteria({ rating: 'any', flag: 'any' }))).toBe(false);
    expect(hasCriteria({ dateRange: {} })).toBe(false);
    expect(hasCriteria({ flag: undefined })).toBe(false);
    // A rejected flag is `false`, which is a real condition -- not "unset".
    expect(hasCriteria({ flag: false })).toBe(true);
  });

  it('accepts every condition the dialog and the engine can express', () => {
    expect(hasCriteria(buildCriteria({ rating: '1' }))).toBe(true);
    expect(hasCriteria(buildCriteria({ flag: 'picked' }))).toBe(true);
    expect(hasCriteria(buildCriteria({ from: '2024-05-01' }))).toBe(true);
    expect(hasCriteria(buildCriteria({ to: '2024-05-10' }))).toBe(true);
    expect(hasCriteria({ camera: 'ILCE' })).toBe(true);
    expect(hasCriteria({ lens: '24-70' })).toBe(true);
    expect(hasCriteria({ folderId: 3 })).toBe(true);
  });

  it('agrees with the engine: a rule it rejects matches every file', () => {
    const criteria: SmartCollectionCriteria = {};
    expect(querySmartCollection([file(), file({ id: 2 })], criteria)).toHaveLength(2);
    expect(hasCriteria(criteria)).toBe(false);
  });
});

describe('criteriaToForm', () => {
  it('round-trips a full rule so the edit dialog reopens with what was saved', () => {
    const criteria = buildCriteria({ rating: '4', flag: 'picked', from: '2024-05-01', to: '2024-05-10' });
    const form = criteriaToForm(criteria);
    expect(form).toEqual({ ratingOp: '>=', rating: '4', flag: 'picked', from: '2024-05-01', to: '2024-05-10' });
    expect(buildCriteria(form)).toEqual(criteria);
  });

  it('shows "any" for criteria a rule does not set', () => {
    expect(criteriaToForm({}).rating).toBe('any');
    expect(criteriaToForm({}).flag).toBe('any');
    expect(criteriaToForm({}).from).toBeUndefined();
  });
});

describe('describeCriteria', () => {
  it('summarizes a rule for the row tooltip', () => {
    expect(describeCriteria(buildCriteria({ rating: '4', flag: 'picked' }))).toBe('rating ≥ 4 · picked');
    expect(describeCriteria(buildCriteria({ from: '2024-05-01', to: '2024-05-10' }))).toBe('modified 2024-05-01 → 2024-05-10');
    expect(describeCriteria({})).toBe('every photo');
  });

  it('shows the operator the rule was saved with', () => {
    expect(describeCriteria({ rating: { op: '=', value: 1 } })).toBe('rating = 1');
    expect(describeCriteria({ rating: { op: '<=', value: 2 } })).toBe('rating ≤ 2');
  });

  it('leads with the scope, so a bounded rule does not read like a global one', () => {
    expect(describeCriteria({ fileIds: [7, 8, 9, 10], rating: { op: '>=', value: 1 } })).toBe('4 chosen photos · rating ≥ 1');
    expect(describeCriteria({ fileIds: [7] })).toBe('1 chosen photo');
  });
});

// The complaint these cover: pick four photos (one at 1 star, three at 2), press
// + next to Smart Collections, choose "1 star" -- and get every starred photo in
// the catalog. Two things made that read as a bug: the rule was not bounded by
// the selection at all, and "1 star" meant "at least one".
describe('scoped rules', () => {
  const selected = (ids: number[], rating: number) => ids.map((id) => file({ id, rating }));

  it('matches only the photos the rule was built from', () => {
    const catalog = [...selected([1, 2, 3, 4], 2), ...selected([5, 6, 7], 5)];
    const criteria: SmartCollectionCriteria = { fileIds: [1, 2, 3, 4], rating: { op: '>=', value: 1 } };
    expect(querySmartCollection(catalog, criteria).map((f) => f.id)).toEqual([1, 2, 3, 4]);
    // Same rule, no scope: the whole-catalog behaviour the dialog used to give.
    expect(querySmartCollection(catalog, { rating: { op: '>=', value: 1 } })).toHaveLength(7);
  });

  it('narrows inside the scope when the operator is "exactly"', () => {
    const catalog = [file({ id: 1, rating: 1 }), file({ id: 2, rating: 2 }), file({ id: 3, rating: 2 }), file({ id: 4, rating: 2 })];
    const scope = { fileIds: [1, 2, 3, 4] };
    expect(querySmartCollection(catalog, { ...scope, rating: { op: '>=', value: 1 } })).toHaveLength(4);
    expect(querySmartCollection(catalog, { ...scope, rating: { op: '=', value: 1 } }).map((f) => f.id)).toEqual([1]);
    // Unrated stays out of both: an absent rating is 0 stars, not "any".
    expect(querySmartCollection([...catalog, file({ id: 5 })], { ...scope, rating: { op: '<', value: 1 } })).toHaveLength(0);
  });

  it('still updates as the photos change -- the scope does not freeze the marks', () => {
    const catalog = [file({ id: 1, rating: 1 }), file({ id: 2, rating: 2 }), file({ id: 3, rating: 5 })];
    const criteria: SmartCollectionCriteria = { fileIds: [1, 2], flag: true };
    // Same records, new marks: the rule re-evaluates, the scope holds.
    expect(querySmartCollection(catalog, criteria)).toHaveLength(0);
    expect(querySmartCollection(catalog.map((f) => ({ ...f, flag: true })), criteria)).toHaveLength(2);
  });

  it('counts a scope as a condition, so a selection-only rule saves', () => {
    expect(hasCriteria({ fileIds: [1, 2] })).toBe(true);
    expect(hasCriteria({ fileIds: [] })).toBe(false);
    expect(hasCriteria(buildCriteria({ rating: 'any' }))).toBe(false);
  });
});