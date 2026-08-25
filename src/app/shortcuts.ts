// Maps a keydown event to an app action. Pure (no DOM side effects) so it
// is unit-testable; main.ts wires the returned action to real behavior.
// Focus guard: when the event originated in an <input> (sliders),
// <select>, <textarea>, or content-editable region, returns null so
// arrows and Ctrl+Z keep their native meaning (slider arrows, text undo).
export type Action =
  | { type: 'grid' }
  | { type: 'loupe' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'pick' } // P -- flag as picked
  | { type: 'reject' } // X -- flag as rejected
  | { type: 'clearCull' } // U -- clear flag/rating/color
  | { type: 'rate'; rating: number } // 1..5 stars
  | { type: 'color'; color: number }; // 1..4 red/yellow/green/blue (keys 6..9)

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
  if (key === 'g') return { type: 'grid' };
  if (key === 'e') return { type: 'loupe' };
  if ((e.ctrlKey || e.metaKey) && key === 'z') return { type: e.shiftKey ? 'redo' : 'undo' };
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowleft') return { type: 'prev' };
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowright') return { type: 'next' };

  // Culling: single unmodified keys. Number-row and numpad both report the
  // digit in `key`, so 1..5 rate and 6..9 paint a color.
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (key === 'p') return { type: 'pick' };
  if (key === 'x') return { type: 'reject' };
  if (key === 'u') return { type: 'clearCull' };
  const digit = parseInt(key, 10);
  if (digit >= 1 && digit <= 5) return { type: 'rate', rating: digit };
  if (digit >= 6 && digit <= 9) return { type: 'color', color: digit - 5 };
  return null;
}
