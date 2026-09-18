// Works for both FileSystemFileHandle and FileSystemDirectoryHandle.
// requestPermission() requires an active user gesture (e.g. this being
// called from a click handler) -- calling it outside one will reject or
// silently stay at 'prompt' depending on the browser.
// True when read is already granted. Some handles (and any handle whose
// permission state is being re-evaluated) REJECT queryPermission outright
// instead of returning 'denied' -- an expected 'no' in a non-granted state,
// not an app error, and an uncaught one printed a TypeError rejection on the
// first photo click after a reload (review 2026-09-18, QA-D8).
export async function queryReadPermission(handle: FileSystemHandle): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

export async function ensureReadPermission(handle: FileSystemHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    // Outside a user gesture (e.g. the Develop-onShow path after a reload),
    // Chromium REJECTS requestPermission with NotAllowedError instead of
    // returning 'prompt' -- an expected 'no', not an app error. Letting it
    // escape logged an unhandled rejection on the first photo click after
    // reload. A false here is retried by the next real gesture.
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
