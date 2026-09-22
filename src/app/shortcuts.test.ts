import { describe, it, expect } from 'vitest';
import { keyToAction } from './shortcuts';

// Minimal structural stand-ins for KeyboardEvent/HTMLElement -- the
// function only reads these fields, so plain objects work (no jsdom).
function ev(p: {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: unknown;
} = {}) {
  return {
    key: p.key ?? '',
    ctrlKey: p.ctrl ?? false,
    metaKey: p.meta ?? false,
    shiftKey: p.shift ?? false,
    altKey: p.alt ?? false,
    target: p.target,
  };
}

describe('keyToAction', () => {
  it('maps module and navigation keys', () => {
    expect(keyToAction(ev({ key: 'g' }))).toEqual({ type: 'grid' });
    expect(keyToAction(ev({ key: 'G' }))).toEqual({ type: 'grid' });
    expect(keyToAction(ev({ key: 'e' }))).toEqual({ type: 'loupe' });
    expect(keyToAction(ev({ key: 'ArrowLeft' }))).toEqual({ type: 'prev' });
    expect(keyToAction(ev({ key: 'ArrowRight' }))).toEqual({ type: 'next' });
  });

  it('maps Ctrl/Cmd+Z to undo, with Shift for redo', () => {
    expect(keyToAction(ev({ key: 'z', ctrl: true }))).toEqual({ type: 'undo' });
    expect(keyToAction(ev({ key: 'z', meta: true }))).toEqual({ type: 'undo' });
    expect(keyToAction(ev({ key: 'z', ctrl: true, shift: true }))).toEqual({ type: 'redo' });
  });

  it('maps culling keys: p/x/u pick, reject, and clear', () => {
    expect(keyToAction(ev({ key: 'p' }))).toEqual({ type: 'pick' });
    expect(keyToAction(ev({ key: 'X' }))).toEqual({ type: 'reject' });
    expect(keyToAction(ev({ key: 'u' }))).toEqual({ type: 'clearCull' });
  });

  it("maps s to sync (LrC's loupe Sync Settings key)", () => {
    expect(keyToAction(ev({ key: 's' }))).toEqual({ type: 'sync' });
    expect(keyToAction(ev({ key: 's', shift: true }))).toBeNull(); // shift is not sync
    expect(keyToAction(ev({ key: 's', meta: true }))).toBeNull(); // Cmd+S stays browser-save
  });

  it('maps 1-5 to ratings and 6-9 to colors (red/yellow/green/blue)', () => {
    expect(keyToAction(ev({ key: '1' }))).toEqual({ type: 'rate', rating: 1 });
    expect(keyToAction(ev({ key: '5' }))).toEqual({ type: 'rate', rating: 5 });
    expect(keyToAction(ev({ key: '6' }))).toEqual({ type: 'color', color: 1 });
    expect(keyToAction(ev({ key: '9' }))).toEqual({ type: 'color', color: 4 });
  });

  it('does not fire culls with a modifier held', () => {
    expect(keyToAction(ev({ key: 'p', ctrl: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'x', shift: true }))).toBeNull();
    expect(keyToAction(ev({ key: '3', meta: true }))).toBeNull();
  });

  it('ignores unknown keys', () => {
    expect(keyToAction(ev({ key: 'q' }))).toBeNull();
  });

  it('does not fire when focus is in an input, select, or textarea', () => {
    expect(keyToAction(ev({ key: 'g', target: { tagName: 'INPUT' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'ArrowLeft', target: { tagName: 'SELECT' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'z', ctrl: true, target: { tagName: 'TEXTAREA' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'e', target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });

  it('does not fire on content editable elements', () => {
    expect(keyToAction(ev({ key: 'e', target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });

  it('arrows keep their native meaning when a modifier is held', () => {
    expect(keyToAction(ev({ key: 'ArrowLeft', ctrl: true }))).toBeNull();
  });

  // ---- Target collection / Quick Collection family (gap P1-4) ----

  it('B with no modifier toggles membership in the target collection', () => {
    expect(keyToAction(ev({ key: 'b' }))).toEqual({ type: 'toggleTargetCollection' });
    expect(keyToAction(ev({ key: 'B' }))).toEqual({ type: 'toggleTargetCollection' });
  });

  it('Shift+B adds to the target and advances', () => {
    expect(keyToAction(ev({ key: 'b', shift: true }))).toEqual({ type: 'addToTargetAndAdvance' });
  });

  it('Cmd+Ctrl both open the target collection with plain B held', () => {
    expect(keyToAction(ev({ key: 'b', meta: true }))).toEqual({ type: 'openTargetCollection' });
    expect(keyToAction(ev({ key: 'b', ctrl: true }))).toEqual({ type: 'openTargetCollection' });
  });

  it('Cmd/Ctrl+Alt+B converts the target into a real collection', () => {
    expect(keyToAction(ev({ key: 'b', meta: true, alt: true }))).toEqual({ type: 'convertTargetToCollection' });
    expect(keyToAction(ev({ key: 'b', ctrl: true, alt: true }))).toEqual({ type: 'convertTargetToCollection' });
  });

  it('unassigned B chords stay inert (Alt+B, Ctrl/Cmd+Shift+B)', () => {
    expect(keyToAction(ev({ key: 'b', alt: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'b', meta: true, shift: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'b', ctrl: true, shift: true }))).toBeNull();
  });

  it('B family respects the editable-focus guard', () => {
    expect(keyToAction(ev({ key: 'b', target: { tagName: 'INPUT' } }))).toBeNull();
    expect(keyToAction(ev({ key: 'b', shift: true, target: { tagName: 'TEXTAREA' } }))).toBeNull();
  });

  // ---- Remove vs Delete-from-disk (gap P0-4) ----

  it('Delete/Backspace carry the collection context so main.ts picks the verb', () => {
    expect(keyToAction(ev({ key: 'Delete' }), { inCollection: true })).toEqual({
      type: 'removeOrDelete',
      inCollection: true,
    });
    expect(keyToAction(ev({ key: 'Backspace' }), { inCollection: false })).toEqual({
      type: 'removeOrDelete',
      inCollection: false,
    });
    // no context passed = the safe default (dialog, not silent membership edit)
    expect(keyToAction(ev({ key: 'Delete' }))).toEqual({ type: 'removeOrDelete', inCollection: false });
  });

  it('modified or shifted Delete stays browser/native, not an app action', () => {
    expect(keyToAction(ev({ key: 'Delete', meta: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'Backspace', ctrl: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'Delete', shift: true }))).toBeNull();
    expect(keyToAction(ev({ key: 'Delete', target: { tagName: 'INPUT' } }))).toBeNull();
  });

  // ---- Regression: every pre-existing binding still maps as before ----

  it('pre-existing bindings are unchanged by the new B/Delete family', () => {
    expect(keyToAction(ev({ key: 'g' }))).toEqual({ type: 'grid' });
    expect(keyToAction(ev({ key: 'e' }))).toEqual({ type: 'loupe' });
    expect(keyToAction(ev({ key: 'ArrowLeft' }))).toEqual({ type: 'prev' });
    expect(keyToAction(ev({ key: 'ArrowRight' }))).toEqual({ type: 'next' });
    expect(keyToAction(ev({ key: 'z', ctrl: true }))).toEqual({ type: 'undo' });
    expect(keyToAction(ev({ key: 'z', meta: true, shift: true }))).toEqual({ type: 'redo' });
    expect(keyToAction(ev({ key: 'c', ctrl: true, shift: true }))).toEqual({ type: 'copy' });
    expect(keyToAction(ev({ key: 'V', meta: true, shift: true }))).toEqual({ type: 'paste' });
    expect(keyToAction(ev({ key: 's' }))).toEqual({ type: 'sync' });
    expect(keyToAction(ev({ key: 'p' }))).toEqual({ type: 'pick' });
    expect(keyToAction(ev({ key: 'x' }))).toEqual({ type: 'reject' });
    expect(keyToAction(ev({ key: 'u' }))).toEqual({ type: 'clearCull' });
    expect(keyToAction(ev({ key: '3' }))).toEqual({ type: 'rate', rating: 3 });
    expect(keyToAction(ev({ key: '8' }))).toEqual({ type: 'color', color: 3 });
    expect(keyToAction(ev({ key: 'q' }))).toBeNull();
    expect(keyToAction(ev({ key: 'a' }))).toBeNull(); // 'a' was and stays unbound
  });
});
