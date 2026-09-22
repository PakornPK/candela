import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  toggleFilterValue,
  clearColumn,
  isFilterActive,
  describeFilters,
  FILTER_PRESETS,
  NONE,
  range,
  type FilterState,
} from './filters';
import type { FileRecord } from '../catalog/types';

const F = (id: number, over: Partial<FileRecord> = {}): FileRecord => ({
  id,
  folderId: 1,
  path: `day1/img${id}.cr3`,
  name: `img${id}.cr3`,
  handle: {} as FileSystemFileHandle,
  size: 0,
  lastModified: 0,
  ...over,
});

const EMPTY: FilterState = { columns: {} };
const ids = (files: FileRecord[]) => files.map((f) => f.id);

describe('applyFilters — LrC join semantics', () => {
  const files = [
    F(1, { rating: 5, cameraModel: 'Fujifilm X100V' }),
    F(2, { rating: 3, cameraModel: 'Fujifilm X100V' }),
    F(3, { rating: 5, cameraModel: 'Canon R5' }),
    F(4, { cameraModel: 'Canon R5' }), // unrated
  ];

  it('no columns, no text: every file passes (copy, not the input array)', () => {
    const out = applyFilters(files, EMPTY);
    expect(ids(out)).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(files);
  });

  it('values inside one column OR together', () => {
    const out = applyFilters(files, { columns: { camera: ['Canon R5', 'Fujifilm X100V'] } });
    expect(ids(out)).toEqual([1, 2, 3, 4]); // either camera passes
  });

  it('rating values OR within the column (>= each number, LrC-style)', () => {
    // LrC's rating menu is threshold-based: 5 and 3 both active ORs them.
    const out = applyFilters(files, { columns: { rating: [5] } });
    expect(ids(out)).toEqual([1, 3]); // "at least 5"
    const both = applyFilters(files, { columns: { rating: [4, 2] } });
    // OR of ">=4" and ">=2" is ">=2" — proves intra-column OR, not AND.
    expect(ids(both)).toEqual([1, 2, 3]);
  });

  it('columns AND together (rating>=3 AND camera Canon R5)', () => {
    const out = applyFilters(files, { columns: { rating: [3], camera: ['Canon R5'] } });
    expect(ids(out)).toEqual([3]);
  });

  it('an EMPTY column array is ignored, not "matches nothing"', () => {
    const out = applyFilters(files, { columns: { rating: [], camera: ['Canon R5'] } });
    expect(ids(out)).toEqual([3, 4]); // rating cleared; camera still filters
    const allEmpty = applyFilters(files, { columns: { rating: [], flag: [] } });
    expect(ids(allEmpty)).toEqual([1, 2, 3, 4]);
  });

  it('text ANDs with columns', () => {
    const out = applyFilters(files, {
      columns: { rating: [5] },
      text: { query: 'R5', scope: 'any' },
    });
    expect(ids(out)).toEqual([3]);
  });
});

describe('applyFilters — the none sentinel', () => {
  const files = [
    F(1, { rating: 2, keywords: ['wedding'] }),
    F(2), // unrated, no keywords, no label
    F(3, { color: 1, keywords: [] }), // labeled, keywords present-but-empty
  ];

  it('rating none = unrated only (culling.ts deletes cleared marks, so rating is absent or 1..5)', () => {
    // File 3 carries color but no rating — it is ALSO unrated and must match.
    expect(ids(applyFilters(files, { columns: { rating: [NONE] } }))).toEqual([2, 3]);
  });

  it('keywords none = no keywords, including an empty stored array', () => {
    expect(ids(applyFilters(files, { columns: { keywords: [NONE] } }))).toEqual([2, 3]);
  });

  it('label none = no color label', () => {
    expect(ids(applyFilters(files, { columns: { label: [NONE] } }))).toEqual([1, 2]);
  });

  it('flag none = unflagged (absent, not picked/rejected)', () => {
    const flagged = [F(1, { flag: true }), F(2, { flag: false }), F(3)];
    expect(ids(applyFilters(flagged, { columns: { flag: [NONE] } }))).toEqual([3]);
  });

  it('none ORs with concrete values in one column (unrated OR 5-star backlog)', () => {
    const files2 = [F(1, { rating: 5 }), F(2), F(3, { rating: 2 })];
    expect(ids(applyFilters(files2, { columns: { rating: [NONE, 5] } }))).toEqual([1, 2]);
  });
});

describe('applyFilters — ranges', () => {
  const files = [
    F(1, { iso: 100 }),
    F(2, { iso: 800 }),
    F(3, { iso: 6400 }),
    F(4), // no ISO yet (EXIF pending) — must never match an ISO range
  ];

  it('closed range includes both ends', () => {
    expect(ids(applyFilters(files, { columns: { iso: [range(100, 800)] } }))).toEqual([1, 2]);
  });

  it('open-ended range (from only / to only)', () => {
    expect(ids(applyFilters(files, { columns: { iso: [range(800)] } }))).toEqual([2, 3]);
    expect(ids(applyFilters(files, { columns: { iso: [range(undefined, 800)] } }))).toEqual([1, 2]);
  });

  it('a file missing the field matches no range', () => {
    expect(ids(applyFilters(files, { columns: { iso: [range(1, 99999)] } }))).toEqual([1, 2, 3]);
  });

  it('focal ranges over focalLength', () => {
    const f2 = [F(1, { focalLength: 23 }), F(2, { focalLength: 56 }), F(3, { focalLength: 90 })];
    expect(ids(applyFilters(f2, { columns: { focal: [range(30, 100)] } }))).toEqual([2, 3]);
  });

  it('date ranges use dateTaken, falling back to lastModified', () => {
    const D = 86_400_000;
    const f2 = [
      F(1, { dateTaken: 100 * D, lastModified: 5000 * D }), // taken day 100, copied years later
      F(2, { lastModified: 150 * D }), // no EXIF: fallback = mtime day 150
      F(3, { dateTaken: 300 * D }),
    ];
    const out = applyFilters(f2, { columns: { date: [range(90 * D, 200 * D)] } });
    expect(ids(out)).toEqual([1, 2]); // 3 is day 300; 1 matches on dateTaken, NOT its mtime
  });
});

describe('applyFilters — enum-ish columns', () => {
  const files = [
    F(1, { flag: true, color: 1 }),
    F(2, { flag: false, color: 4 }),
    F(3, { color: 2 }),
    F(4, { name: 'scan.jpg', path: 'day1/scan.jpg' }),
    F(5, { missing: true }),
    F(6, { name: 'dng-file.dng', path: 'day1/dng-file.dng' }),
  ];

  it('flag picked/rejected', () => {
    expect(ids(applyFilters(files, { columns: { flag: ['picked'] } }))).toEqual([1]);
    expect(ids(applyFilters(files, { columns: { flag: ['picked', 'rejected'] } }))).toEqual([1, 2]);
  });

  it('label names map to the 1..4 color codes (culling.ts)', () => {
    expect(ids(applyFilters(files, { columns: { label: ['red', 'blue'] } }))).toEqual([1, 2]);
  });

  it('fileType raw vs image via import.ts allowlist (reuse of isRawFileName)', () => {
    expect(ids(applyFilters(files, { columns: { fileType: ['raw'] } }))).toEqual([1, 2, 3, 5, 6]);
    expect(ids(applyFilters(files, { columns: { fileType: ['image'] } }))).toEqual([4]);
  });

  it('missing present/missing', () => {
    expect(ids(applyFilters(files, { columns: { missing: ['missing'] } }))).toEqual([5]);
    expect(ids(applyFilters(files, { columns: { missing: ['present'] } }))).toEqual([1, 2, 3, 4, 6]);
  });

  it('camera/lens keyword columns match case-insensitively', () => {
    const f2 = [F(1, { cameraModel: 'Fujifilm X100V', lensModel: '23mm F2' })];
    expect(ids(applyFilters(f2, { columns: { camera: ['FUJIFILM X100V'] } }))).toEqual([1]);
    expect(ids(applyFilters(f2, { columns: { lens: ['23mm f2'] } }))).toEqual([1]);
  });

  it('keywords column matches a single keyword exactly (menu semantics)', () => {
    const f2 = [F(1, { keywords: ['Wedding', 'portrait'] }), F(2, { keywords: ['travel'] })];
    expect(ids(applyFilters(f2, { columns: { keywords: ['wedding'] } }))).toEqual([1]);
    expect(ids(applyFilters(f2, { columns: { keywords: ['wedding', 'travel'] } }))).toEqual([1, 2]);
  });
});

describe('applyFilters — text scopes', () => {
  const files = [
    F(1, { name: 'DSC_0010.cr3', path: 'paris/DSC_0010.cr3', keywords: ['eiffel'] }),
    F(2, { name: 'DSC_0020.cr3', path: 'tokyo/DSC_0020.cr3', keywords: ['DSC-odd'], cameraModel: 'Sony A7 IV' }),
    F(3, { name: 'note.txt', path: 'misc/note.txt', lensModel: 'DSC prime' }),
  ];

  it('filename scope searches the name only', () => {
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'dsc_002', scope: 'filename' } }))).toEqual([2]);
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'paris', scope: 'filename' } }))).toEqual([]);
  });

  it('keywords scope searches keywords only', () => {
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'eiffel', scope: 'keywords' } }))).toEqual([1]);
    // substring inside a keyword value (DSC-odd contains dsc):
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'dsc', scope: 'keywords' } }))).toEqual([2]);
  });

  it('any scope spans filename, path, keywords, camera and lens', () => {
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'paris', scope: 'any' } }))).toEqual([1]);
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'sony', scope: 'any' } }))).toEqual([2]);
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'prime', scope: 'any' } }))).toEqual([3]);
  });

  it('matching is case-insensitive both ways', () => {
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'DSC_0010', scope: 'any' } }))).toEqual([1]);
    expect(ids(applyFilters(files, { columns: {}, text: { query: 'EIFFEL', scope: 'any' } }))).toEqual([1]);
  });

  it('blank / whitespace query is inactive', () => {
    expect(ids(applyFilters(files, { columns: {}, text: { query: '   ', scope: 'any' } }))).toHaveLength(3);
  });
});

describe('UI helpers', () => {
  it('toggleFilterValue adds, removes, and never mutates the input', () => {
    const s0: FilterState = { columns: {} };
    const s1 = toggleFilterValue(s0, 'rating', 5);
    expect(s1.columns.rating).toEqual([5]);
    expect(s0.columns.rating).toBeUndefined(); // input untouched
    const s2 = toggleFilterValue(s1, 'rating', 4);
    expect(s2.columns.rating).toEqual([5, 4]);
    expect(s1.columns.rating).toEqual([5]); // s1 untouched by the second toggle
    const s3 = toggleFilterValue(s2, 'rating', 5);
    expect(s3.columns.rating).toEqual([4]); // second click on 5 removes it
    expect(s2.columns.rating).toEqual([5, 4]);
  });

  it('toggleFilterValue matches range/none values structurally, not by identity', () => {
    const s1 = toggleFilterValue(EMPTY, 'iso', range(100, 800));
    expect(s1.columns.iso).toHaveLength(1);
    const s2 = toggleFilterValue(s1, 'iso', range(100, 800)); // equal, different object
    expect(s2.columns.iso).toHaveLength(0);
    const s3 = toggleFilterValue(EMPTY, 'keywords', NONE);
    const s4 = toggleFilterValue(s3, 'keywords', { kind: 'none' });
    expect(s4.columns.keywords).toHaveLength(0);
  });

  it('clearColumn removes the key, leaving siblings, and is identity-stable when absent', () => {
    const s: FilterState = { columns: { rating: [4], camera: ['Canon R5'] }, text: { query: 'x', scope: 'any' } };
    const out = clearColumn(s, 'rating');
    expect('rating' in out.columns).toBe(false);
    expect(out.columns.camera).toEqual(['Canon R5']);
    expect(out.text).toEqual(s.text);
    expect(s.columns.rating).toEqual([4]); // input untouched
    expect(clearColumn(out, 'rating')).toBe(out); // clearing an absent column = same object
  });

  it('isFilterActive: false on empty, true with values, empty arrays and whitespace text stay inactive', () => {
    expect(isFilterActive(EMPTY)).toBe(false);
    expect(isFilterActive({ columns: { rating: [] } })).toBe(false);
    expect(isFilterActive({ columns: {}, text: { query: '  ', scope: 'any' } })).toBe(false);
    expect(isFilterActive({ columns: { rating: [1] } })).toBe(true);
    expect(isFilterActive({ columns: {}, text: { query: 'a', scope: 'any' } })).toBe(true);
  });

  it('describeFilters phrases columns like the LrC footer', () => {
    expect(describeFilters(EMPTY)).toBe('');
    expect(describeFilters({ columns: { rating: [4] } })).toBe('rating at least 4');
    expect(describeFilters({ columns: { camera: ['X100V'], rating: [NONE] } })).toMatch('camera X100V');
    expect(describeFilters({ columns: { rating: [NONE] } })).toBe('unrated');
    expect(describeFilters({ columns: { label: [NONE] } })).toBe('no label');
    expect(describeFilters({ columns: { keywords: [NONE] } })).toBe('no keywords');
    expect(describeFilters({ columns: { flag: [NONE] } })).toBe('no flag');
    expect(describeFilters({ columns: { iso: [range(200, 1600)] } })).toBe('ISO 200–1600');
    expect(describeFilters({ columns: { iso: [range(800)] } })).toBe('ISO at least 800');
    expect(describeFilters({ columns: { iso: [range(200, 200)] } })).toBe('ISO 200'); // exact value, not 200–200
    expect(
      describeFilters({ columns: { date: [range(Date.UTC(2024, 0, 15), Date.UTC(2024, 2, 10))] } }),
    ).toBe('date from 2024-01-15–2024-03-10');
    expect(describeFilters({ columns: { rating: [5] }, text: { query: 'x100', scope: 'any' } })).toBe(
      'rating at least 5 · text "x100"',
    );
    expect(
      describeFilters({ columns: {}, text: { query: ' dsc ', scope: 'filename' } }),
    ).toBe('name "dsc"');
  });

  it('describeFilters returns a stable phrase for every preset', () => {
    for (const key of Object.keys(FILTER_PRESETS)) {
      expect(describeFilters(FILTER_PRESETS[key as keyof typeof FILTER_PRESETS]).length).toBeGreaterThan(0);
    }
  });
});

describe('FILTER_PRESETS', () => {
  it('has exactly the four LrC-cull presets', () => {
    expect(Object.keys(FILTER_PRESETS).sort()).toEqual(['flagged', 'missing', 'rejected', 'unrated']);
  });

  it('each preset has the shape its name promises', () => {
    expect(FILTER_PRESETS.unrated.columns.rating).toEqual([NONE]);
    expect(FILTER_PRESETS.flagged.columns.flag).toEqual(['picked']);
    expect(FILTER_PRESETS.rejected.columns.flag).toEqual(['rejected']);
    expect(FILTER_PRESETS.missing.columns.missing).toEqual(['missing']);
    for (const p of Object.values(FILTER_PRESETS)) {
      expect(isFilterActive(p)).toBe(true);
    }
  });

  it('presets actually filter a mixed catalog the way their names say', () => {
    const files = [
      F(1, { rating: 3 }),
      F(2),
      F(3, { flag: true }),
      F(4, { flag: false }),
      F(5, { missing: true }),
    ];
    expect(ids(applyFilters(files, FILTER_PRESETS.unrated))).toEqual([2, 3, 4, 5]);
    expect(ids(applyFilters(files, FILTER_PRESETS.flagged))).toEqual([3]);
    expect(ids(applyFilters(files, FILTER_PRESETS.rejected))).toEqual([4]);
    expect(ids(applyFilters(files, FILTER_PRESETS.missing))).toEqual([5]);
  });

  it('using a preset via toggleFilterValue leaves the shared object untouched', () => {
    const before = JSON.stringify(FILTER_PRESETS.unrated);
    const mutated = toggleFilterValue(FILTER_PRESETS.unrated, 'rating', 5);
    expect(JSON.stringify(FILTER_PRESETS.unrated)).toBe(before);
    expect(mutated.columns.rating).toEqual([NONE, 5]);
  });
});

describe('scale — 10k rows, linear cost', () => {
  it('a full multi-column filter over 10k files is ~linear, not quadratic', () => {
    const N = 10_000;
    const files: FileRecord[] = [];
    for (let i = 0; i < N; i++) {
      files.push(
        F(i, {
          rating: i % 6 || undefined,
          iso: 100 * (1 + (i % 40)),
          cameraModel: i % 3 === 0 ? 'Fujifilm X100V' : 'Canon R5',
          keywords: i % 7 === 0 ? ['wedding'] : undefined,
          dateTaken: Date.UTC(2024, 0, 1) + i * 3_600_000,
        }),
      );
    }
    const state: FilterState = {
      columns: {
        rating: [3],
        camera: ['Fujifilm X100V'],
        iso: [range(100, 2000)],
        date: [range(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 31))],
        keywords: [NONE],
      },
      text: { query: 'img', scope: 'any' },
    };
    const run = () => applyFilters(files, state).length;
    const baseline = run(); // warm up
    const t0 = performance.now();
    for (let rep = 0; rep < 3; rep++) expect(run()).toBe(baseline);
    const t10k = (performance.now() - t0) / 3;

    // 2x the rows: a linear pass costs ~2x; a hidden quadratic would cost ~4x.
    // Compare against 2.6x the per-10k cost with generous timer slack, and
    // re-measure on failure so scheduler noise cannot be reported as O(n^2).
    const doubled = files.concat(files);
    const t0d = performance.now();
    for (let rep = 0; rep < 3; rep++) applyFilters(doubled, state);
    const t20k = (performance.now() - t0d) / 3;
    if (t20k > 2.6 * t10k) {
      // Retry once (the first 3-rep loop primed the JIT; a cold second batch
      // can lose to GC noise). A real quadratic loses both comparisons.
      const t0b = performance.now();
      applyFilters(doubled, state);
      const again = performance.now() - t0b;
      const t0s = performance.now();
      applyFilters(files, state);
      const t10kAgain = performance.now() - t0s;
      expect(again).toBeLessThanOrEqual(2.6 * t10kAgain);
    }
    expect(baseline).toBeGreaterThan(0); // the state really does filter
  }, 15_000);
});
