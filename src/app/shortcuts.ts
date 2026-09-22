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
  | { type: 'color'; color: number } // 1..4 red/yellow/green/blue (keys 6..9)
  | { type: 'copy' } // Ctrl+Shift+C -- copy current settings
  | { type: 'paste' } // Ctrl+Shift+V -- paste settings to selected
  | { type: 'sync' } // S -- Sync Settings dialog (LrC's loupe key)
  // Target collection / Quick Collection (LrC parity, gap P1-4)
  | { type: 'toggleTargetCollection' } // B -- toggle membership in the target
  | { type: 'addToTargetAndAdvance' } // Shift+B -- add + move to next frame
  | { type: 'convertTargetToCollection' } // Ctrl/Cmd+Alt+B -- save tray as real collection
  | { type: 'openTargetCollection' } // Ctrl/Cmd+B -- jump to the target
  // Remove vs Delete-from-disk (gap P0-4). The context travels with the
  // action so main.ts picks the verb (membership-only vs dialog) without
  // re-deriving which view has focus.
  | { type: 'removeOrDelete'; inCollection: boolean }; // Delete/Backspace, unmodified

// The event fields keyToAction reads. Structural: a real KeyboardEvent
// satisfies it, and so do plain test objects (no DOM types needed).
// `altKey` is optional so pre-existing call sites and test literals that
// never set it keep compiling; the only binding that reads it (Ctrl/Cmd+Alt+B)
// treats undefined as false.
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  target: unknown;
}

// Caller context that isn't on the event itself: which view has focus.
// Optional so main.ts can keep calling keyToAction(e) until it wires the
// collection-awareness in; the safe default is "not in a collection" (the
// two-verb dialog, not a silent membership edit).
export interface ShortcutContext {
  inCollection?: boolean;
}

function isEditable(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName ?? '';
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

export function keyToAction(e: KeyEventLike, context: ShortcutContext = {}): Action | null {
  if (isEditable(e.target)) return null;

  const key = e.key.toLowerCase();
  if (key === 'g') return { type: 'grid' };
  if (key === 'e') return { type: 'loupe' };
  if ((e.ctrlKey || e.metaKey) && key === 'z') return { type: e.shiftKey ? 'redo' : 'undo' };
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'c') return { type: 'copy' };
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'v') return { type: 'paste' };
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowleft') return { type: 'prev' };
  if (!(e.ctrlKey || e.metaKey) && key === 'arrowright') return { type: 'next' };

  // Target collection family (LrC's Quick Collection keys, gap P1-4).
  // 'b' was previously unbound (fell through to null), so none of these
  // shadow an existing binding.
  if (key === 'b') {
    const mod = e.ctrlKey || e.metaKey; // Cmd on macOS, Ctrl elsewhere
    if (mod) {
      if (e.shiftKey) return null; // Ctrl/Cmd+Shift+B is unassigned — stay inert
      return e.altKey
        ? { type: 'convertTargetToCollection' } // Ctrl/Cmd+Alt+B
        : { type: 'openTargetCollection' }; // Ctrl/Cmd+B
    }
    if (e.altKey) return null; // bare Alt+B is unassigned
    if (e.shiftKey) return { type: 'addToTargetAndAdvance' }; // Shift+B
    return { type: 'toggleTargetCollection' }; // B
  }

  // Delete/Backspace (gap P0-4): only unmodified; the action carries the
  // view context so main.ts picks membership-only vs the two-verb dialog
  // without re-deriving it. Deliberate omission: Cmd/Ctrl+Delete stays
  // browser-native.
  if ((key === 'delete' || key === 'backspace') && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    return { type: 'removeOrDelete', inCollection: context.inCollection === true };
  }

  // Culling: single unmodified keys. Number-row and numpad both report the
  // digit in `key`, so 1..5 rate and 6..9 paint a color.
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (key === 's') return { type: 'sync' };
  if (key === 'p') return { type: 'pick' };
  if (key === 'x') return { type: 'reject' };
  if (key === 'u') return { type: 'clearCull' };
  const digit = parseInt(key, 10);
  if (digit >= 1 && digit <= 5) return { type: 'rate', rating: digit };
  if (digit >= 6 && digit <= 9) return { type: 'color', color: digit - 5 };
  return null;
}
