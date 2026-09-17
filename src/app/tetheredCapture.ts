// Tethered capture: a camera writing into a folder is the only "tether" a page
// with no camera SDK can see. Poll the folder and import frames that appear
// after watching started -- files already there when watching begins are
// snapshotted, so pointing at a folder full of an old shoot imports nothing.
import { importSingleFile, isSupportedFile } from '../catalog/import';

const POLL_INTERVAL_MS = 2000;

export class TetheredCapture {
  private seen = new Set<string>();
  private timer: number | null = null;

  constructor(
    private readonly db: IDBDatabase,
    private readonly dirHandle: FileSystemDirectoryHandle,
    private readonly onImported: (name: string) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  get folderName(): string {
    return this.dirHandle.name;
  }

  async start(): Promise<void> {
    if (this.timer !== null) return;
    this.seen = new Set(await this.listNames());
    this.timer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private async listNames(): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of this.dirHandle.values()) {
      if (entry.kind === 'file') names.push(entry.name);
    }
    return names;
  }

  private async poll(): Promise<void> {
    try {
      for await (const entry of this.dirHandle.values()) {
        if (entry.kind !== 'file' || this.seen.has(entry.name)) continue;
        this.seen.add(entry.name);
        if (!isSupportedFile(entry.name)) continue;
        await importSingleFile(this.db, this.dirHandle, entry);
        this.onImported(entry.name);
      }
    } catch (err) {
      this.onError(err);
    }
  }
}