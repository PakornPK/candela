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
    expect(keyToAction(ev({ key: 'g' }))).toBe('grid');
    expect(keyToAction(ev({ key: 'G' }))).toBe('grid');
    expect(keyToAction(ev({ key: 'e' }))).toBe('loupe');
    expect(keyToAction(ev({ key: 'ArrowLeft' }))).toBe('prev');
    expect(keyToAction(ev({ key: 'ArrowRight' }))).toBe('next');
  });

  it('maps Ctrl/Cmd+Z to undo, with Shift for redo', () => {
    expect(keyToAction(ev({ key: 'z', ctrl: true }))).toBe('undo');
    expect(keyToAction(ev({ key: 'z', meta: true }))).toBe('undo');
    expect(keyToAction(ev({ key: 'z', ctrl: true, shift: true }))).toBe('redo');
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
