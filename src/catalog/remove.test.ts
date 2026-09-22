import { describe, it, expect } from 'vitest';
import {
  confirmMessage,
  deleteKeyVerb,
  deleteFilesFromDisk,
  type FileHandleLike,
  type RemoveVerb,
} from './remove';

// The decision/copy layer is where the data-loss trust boundary lives (P0-4);
// the IDB call itself needs a real IndexedDB and is exercised by main.ts —
// same split as every other catalog module (no fake-indexeddb dependency).

describe('deleteKeyVerb (LrC delete-key semantics)', () => {
  it('inside a collection removes MEMBERSHIP only — no verb, no dialog', () => {
    expect(deleteKeyVerb({ inCollection: true })).toBe('remove-membership');
  });

  it('outside a collection defaults to the safe verb (never delete-from-disk)', () => {
    expect(deleteKeyVerb({ inCollection: false })).toBe('remove-from-catalog');
  });

  it('the default is never the destructive verb regardless of context', () => {
    for (const inCollection of [true, false]) {
      expect(deleteKeyVerb({ inCollection })).not.toBe('delete-from-disk');
    }
  });
});

describe('confirmMessage', () => {
  const verbs: RemoveVerb[] = ['remove-from-catalog', 'delete-from-disk'];

  it('the two verbs never produce the same title, body, or label', () => {
    const a = confirmMessage('remove-from-catalog', 3, 'IMG_4032.CR3');
    const b = confirmMessage('delete-from-disk', 3, 'IMG_4032.CR3');
    expect(a.title).not.toBe(b.title);
    expect(a.body).not.toBe(b.body);
    expect(a.confirmLabel).not.toBe(b.confirmLabel);
  });

  it('only delete-from-disk is flagged destructive', () => {
    expect(confirmMessage('delete-from-disk', 1, 'a.cr3').destructive).toBe(true);
    expect(confirmMessage('remove-from-catalog', 1, 'a.cr3').destructive).toBe(false);
  });

  it('delete-from-disk body names the count, an example file, the trash, and catalog edits leaving', () => {
    const c = confirmMessage('delete-from-disk', 300, 'DSC_0871.ARW');
    expect(c.body).toContain('300');
    expect(c.body).toContain('DSC_0871.ARW');
    expect(c.body.toLowerCase()).toContain('trash');
    // states the edits leave the catalog too — the full blast radius
    expect(c.body.toLowerCase()).toContain('catalog');
    expect(c.confirmLabel.toLowerCase()).toContain('delete');
  });

  it('remove-from-catalog body says files stay on disk and edits leave the catalog', () => {
    const c = confirmMessage('remove-from-catalog', 12, 'x.cr3');
    expect(c.body).toContain('12');
    expect(c.body.toLowerCase()).toContain('stay on disk');
    expect(c.body.toLowerCase()).toContain('catalog');
    // the safe verb must never mention deleting or the trash
    expect(c.body.toLowerCase()).not.toContain('trash');
    expect(c.body.toLowerCase()).not.toContain('delete');
  });

  it('singular and plural agree', () => {
    expect(confirmMessage('delete-from-disk', 1, 'a.cr3').body).toMatch(/1 file /);
    expect(confirmMessage('delete-from-disk', 2, 'a.cr3').body).toMatch(/2 files /);
    expect(confirmMessage('remove-from-catalog', 1, 'a.cr3').title).toContain('1 photo');
    expect(confirmMessage('remove-from-catalog', 4, 'a.cr3').title).toContain('4 photos');
  });

  it('covers every verb in the union (exhaustiveness guard)', () => {
    for (const v of verbs) {
      const c = confirmMessage(v, 1, 'a.cr3');
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
      expect(c.confirmLabel.length).toBeGreaterThan(0);
    }
  });
});

function handle(overrides: Partial<FileHandleLike> & { name?: string } = {}): FileHandleLike {
  return { name: overrides.name ?? 'a.cr3', kind: 'file', remove: async () => {}, ...overrides };
}

describe('deleteFilesFromDisk', () => {
  it('deletes every file handle and reports the count', async () => {
    let calls = 0;
    const hs = [handle({ name: 'a' }), handle({ name: 'b' })];
    for (const h of hs) h.remove = async () => void calls++;
    const report = await deleteFilesFromDisk(hs);
    expect(report).toEqual({ deleted: 2, failed: [] });
    expect(calls).toBe(2);
  });

  it('a failing file does not abort the batch — the failure is reported with its reason', async () => {
    const locked = handle({
      name: 'locked.cr3',
      remove: () => Promise.reject(new Error('NoModificationAllowedError: file is locked')),
    });
    const ok = handle({ name: 'ok.cr3' });
    const report = await deleteFilesFromDisk([locked, ok, handle({ name: 'gone.cr3', remove: () => Promise.reject(new Error('NotFoundError')) })]);
    expect(report.deleted).toBe(1);
    expect(report.failed.map((f) => f.name)).toEqual(['locked.cr3', 'gone.cr3']);
    expect(report.failed[0].reason).toContain('locked');
    expect(report.failed[1].reason).toContain('NotFoundError');
  });

  it('refuses a directory handle with a reason — never recurses', async () => {
    let touched = 0;
    const dir = handle({ name: 'shoot-2026', kind: 'directory' as const, remove: async () => void touched++ });
    const report = await deleteFilesFromDisk([dir]);
    expect(report.deleted).toBe(0);
    expect(touched).toBe(0); // remove() was never called on it
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe('shoot-2026');
    expect(report.failed[0].reason.toLowerCase()).toContain('folder');
  });

  it('reports a missing remove() (browser without FSAA delete) as a failure, not a throw', async () => {
    const stale = handle({ name: 'legacy.cr3' });
    delete stale.remove;
    const report = await deleteFilesFromDisk([stale]);
    expect(report.deleted).toBe(0);
    expect(report.failed[0].reason).toContain('remove()');
  });

  it('an empty batch is a clean no-op', async () => {
    expect(await deleteFilesFromDisk([])).toEqual({ deleted: 0, failed: [] });
  });
});
