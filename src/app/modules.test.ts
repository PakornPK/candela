import { describe, it, expect, beforeEach } from 'vitest';
import { getState, setModule } from './state';
import { registerModule, resetModulesForTests, switchModule, type Module } from './modules';

// modules.ts only reads root.hidden, so a duck-typed fake stands in for
// real HTMLElements in node (no jsdom dependency).
function fakeRoot() {
  return { hidden: false };
}

function makeModule(id: 'library' | 'develop', events: string[], root: { hidden: boolean }): Module {
  return {
    id,
    root: root as unknown as HTMLElement,
    onShow: () => events.push(`${id}:show`),
    onHide: () => events.push(`${id}:hide`),
  };
}

describe('module registry', () => {
  beforeEach(() => {
    // The registry is a module singleton; registerModule can only add to
    // it, so stale registrations from an earlier test would leak in (e.g.
    // test 1 registering 'develop' would make test 2's "unknown id" check
    // switch instead of no-op). resetModulesForTests clears it.
    resetModulesForTests();
    setModule('library');
  });

  it('switchModule hides the old root, shows the new one, and calls hooks in order', () => {
    const events: string[] = [];
    const libraryRoot = fakeRoot();
    const developRoot = fakeRoot();
    registerModule(makeModule('library', events, libraryRoot));
    registerModule(makeModule('develop', events, developRoot));

    switchModule('develop');
    expect(libraryRoot.hidden).toBe(true);
    expect(developRoot.hidden).toBe(false);
    expect(events).toEqual(['library:hide', 'develop:show']);
    expect(getState().module).toBe('develop');

    switchModule('library');
    expect(developRoot.hidden).toBe(true);
    expect(libraryRoot.hidden).toBe(false);
    expect(events).toEqual(['library:hide', 'develop:show', 'develop:hide', 'library:show']);
    expect(getState().module).toBe('library');
  });

  it('unknown id is a no-op', () => {
    const events: string[] = [];
    registerModule(makeModule('library', events, fakeRoot()));
    // 'develop' is not registered in this test
    switchModule('develop');
    expect(getState().module).toBe('library');
    expect(events).toEqual([]);
  });

  it('switching to the active module is a no-op', () => {
    const events: string[] = [];
    const root = fakeRoot();
    registerModule(makeModule('library', events, root));
    registerModule(makeModule('develop', events, fakeRoot()));
    switchModule('library');
    expect(events).toEqual([]);
    expect(getState().module).toBe('library');
  });
});
