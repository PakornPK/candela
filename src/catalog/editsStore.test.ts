import { describe, it, expect } from 'vitest';
import { isValidEditRow } from './editsStore';

describe('isValidEditRow', () => {
  it('accepts a valid row', () => {
    const row = { fileId: 1, history: [[], [{ kind: 'exposure', ev: 1 }]], cursor: 1 };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isValidEditRow(null)).toBe(false);
    expect(isValidEditRow(undefined)).toBe(false);
    expect(isValidEditRow('nope')).toBe(false);
    expect(isValidEditRow(42)).toBe(false);
  });

  it('rejects a missing history array', () => {
    expect(isValidEditRow({ fileId: 1, cursor: 0 })).toBe(false);
  });

  it('rejects an empty history array', () => {
    expect(isValidEditRow({ fileId: 1, history: [], cursor: 0 })).toBe(false);
  });

  it('rejects a snapshot that is not an array', () => {
    expect(isValidEditRow({ fileId: 1, history: [null], cursor: 0 })).toBe(false);
    expect(isValidEditRow({ fileId: 1, history: [{}], cursor: 0 })).toBe(false);
  });

  it('rejects a negative cursor', () => {
    expect(isValidEditRow({ fileId: 1, history: [[]], cursor: -1 })).toBe(false);
  });

  it('rejects a non-integer cursor', () => {
    expect(isValidEditRow({ fileId: 1, history: [[]], cursor: 0.5 })).toBe(false);
  });

  it('rejects a cursor one past the end of history', () => {
    expect(isValidEditRow({ fileId: 1, history: [[], []], cursor: 2 })).toBe(false);
  });

  it('rejects a snapshot containing null', () => {
    expect(isValidEditRow({ fileId: 1, history: [[null]], cursor: 0 })).toBe(false);
  });

  it('rejects a snapshot containing an empty object', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{}]], cursor: 0 })).toBe(false);
  });

  it('rejects an exposure op missing ev', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'exposure' }]], cursor: 0 })).toBe(false);
  });

  it('rejects an exposure op with a non-numeric ev', () => {
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'exposure', ev: 'not a number' }]], cursor: 0 })
    ).toBe(false);
  });

  it('rejects a whiteBalance op missing kelvin', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance' }]], cursor: 0 })).toBe(false);
  });

  it('rejects a whiteBalance op with a non-numeric kelvin', () => {
    expect(
      isValidEditRow({ fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 'warm' }]], cursor: 0 })
    ).toBe(false);
  });

  it('rejects an op with an unknown kind', () => {
    expect(isValidEditRow({ fileId: 1, history: [[{ kind: 'unknown' }]], cursor: 0 })).toBe(false);
  });

  it('accepts a row whose snapshot has a valid exposure op', () => {
    const row = { fileId: 1, history: [[{ kind: 'exposure', ev: 0.5 }]], cursor: 0 };
    expect(isValidEditRow(row)).toBe(true);
  });

  it('accepts a row whose snapshot has a valid whiteBalance op', () => {
    const row = { fileId: 1, history: [[{ kind: 'whiteBalance', kelvin: 5500 }]], cursor: 0 };
    expect(isValidEditRow(row)).toBe(true);
  });
});
