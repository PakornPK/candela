import { describe, it, expect } from 'vitest';
import { keyToAction } from './shortcuts';

// Minimal structural stand-ins for KeyboardEvent/HTMLElement -- the
// function only reads these fields, so plain objects work (no jsdom).
function ev(p: {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  target?: unknown;
} = {}) {
  return {
    key: p.key ?? '',
    ctrlKey: p.ctrl ?? false,
    metaKey: p.meta ?? false,
    shiftKey: p.shift ?? false,
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
});
