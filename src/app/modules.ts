import { getState, setModule, type ModuleId } from './state';

export interface Module {
  id: ModuleId;
  root: HTMLElement;
  onShow(): void;
  onHide(): void;
}

const registry = new Map<ModuleId, Module>();

export function registerModule(module: Module): void {
  registry.set(module.id, module);
}

// Test-only: clears the registry so each test starts from a known state
// (the registry is a module singleton that registerModule can only add to).
export function resetModulesForTests(): void {
  registry.clear();
}

// Shows the target module's root, hides the current one's, calls the
// lifecycle hooks, then notifies state subscribers. Unknown ids and
// switching to the already-active module are no-ops.
export function switchModule(id: ModuleId): void {
  const current = registry.get(getState().module);
  const next = registry.get(id);
  if (!next || next === current) return;

  if (current) {
    current.onHide();
    current.root.hidden = true;
  }
  next.root.hidden = false;
  next.onShow();
  setModule(id);
}
