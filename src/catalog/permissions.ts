// Works for both FileSystemFileHandle and FileSystemDirectoryHandle.
// requestPermission() requires an active user gesture (e.g. this being
// called from a click handler) -- calling it outside one will reject or
// silently stay at 'prompt' depending on the browser.
export async function ensureReadPermission(handle: FileSystemHandle): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}
