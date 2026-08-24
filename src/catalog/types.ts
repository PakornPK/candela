export interface FolderRecord {
  id: number;
  handle: FileSystemDirectoryHandle;
  name: string;
  addedAt: number;
}

export interface FileRecord {
  id: number;
  folderId: number;
  path: string; // relative to the folder root, e.g. "day1/img001.cr3"
  name: string;
  handle: FileSystemFileHandle;
  size: number;
  lastModified: number;
}

export type Op =
  | { kind: 'exposure'; ev: number }
  | { kind: 'whiteBalance'; kelvin: number };
  // future op kinds (crop, curve, ...) extend this union.

export function isExposureOp(op: Op): op is { kind: 'exposure'; ev: number } {
  return op.kind === 'exposure';
}

export function isWhiteBalanceOp(op: Op): op is { kind: 'whiteBalance'; kelvin: number } {
  return op.kind === 'whiteBalance';
}

export interface EditState {
  history: Op[][]; // one snapshot per commit, oldest first
  cursor: number;  // current state = history[cursor]
}
