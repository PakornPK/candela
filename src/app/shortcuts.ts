// Maps a keydown event to an app action. Pure (no DOM side effects) so it
// is unit-testable; main.ts wires the returned action to real behavior.
// Focus guard: when the event originated in an <input> (sliders),
// <select>, <textarea>, or content-editable region, returns null so
// arrows and Ctrl+Z keep their native meaning (slider arrows, text undo).
export type Action = 'grid' | 'loupe' | 'prev' | 'next' | 'undo' | 'redo';

// The five event fields keyToAction reads. Structural: a real KeyboardEvent
// satisfies it, and so do plain test objects (no DOM types needed).
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

function isEditable(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName ?? '';
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

export function keyToAction(e: KeyEventLike): Action | null {
  if (isEditable(e.target)) return null;

  const key = e.key.toLowerCase();
  if (key === 'g') return 'grid';
  if (key === 'e') return 'loupe';
  if ((e.ctrlKey || e.metaKey) && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowleft') return 'prev';
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowright') return 'next';
  return null;
}
