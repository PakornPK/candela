import { describe, it, expect } from 'vitest';
import { pathPrefixRange } from './paths';

describe('pathPrefixRange', () => {
  it('returns the prefix as the lower bound and prefix+\\uffff as the upper bound', () => {
    expect(pathPrefixRange('day1/')).toEqual({ lower: 'day1/', upper: 'day1/￿' });
  });

  it('excludes a sibling folder whose name starts with the same characters', () => {
    const { upper } = pathPrefixRange('day1/');
    expect('day10/photo.cr3' > upper).toBe(true);
  });

  it('matches every path when the prefix is empty', () => {
    const { lower, upper } = pathPrefixRange('');
    expect('anything.cr3' >= lower && 'anything.cr3' < upper).toBe(true);
  });

  it('does NOT exclude a sibling folder when the prefix lacks a trailing slash', () => {
    // Documents the caller contract: without a trailing "/" (or ""),
    // pathPrefixRange cannot distinguish "day1" as a folder boundary from
    // "day1" as a plain string prefix, so "day10/..." is not excluded.
    const { upper } = pathPrefixRange('day1');
    expect('day10/photo.cr3' > upper).toBe(false);
  });
});
