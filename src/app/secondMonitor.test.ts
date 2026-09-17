import { describe, it, expect } from 'vitest';
import { controlsWindowPlacement } from './secondMonitor';

describe('controls window placement', () => {
  const screen = { screenX: 0, screenY: 25, outerWidth: 1440, availHeight: 900, width: 420, height: 860 };

  it('opens beside the main window when a second display is attached', () => {
    expect(controlsWindowPlacement({ ...screen, extended: true })).toEqual({ left: 1440, top: 25 });
  });

  it('centres over the main window on a single display instead of off its edge', () => {
    expect(controlsWindowPlacement({ ...screen, extended: false })).toEqual({ left: 510, top: 25 });
  });

  it('clamps to the screen even when the window would not fit', () => {
    expect(controlsWindowPlacement({ ...screen, screenX: -1440, extended: true }).left).toBe(0);
    expect(controlsWindowPlacement({ ...screen, screenY: 700, availHeight: 900, extended: false }).top).toBe(40);
  });
});