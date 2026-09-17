// Edit state backup system (Phase 4.3)
// Periodically saves all edit states to prevent data loss

import type { EditState } from './types';

const BACKUP_INTERVAL = 30000; // 30 seconds
const BACKUP_KEY = 'candela-edit-backup';

interface BackupData {
  timestamp: number;
  edits: Map<number, EditState>;
}

let backupTimer: ReturnType<typeof setInterval> | null = null;
let currentEdits: Map<number, EditState> = new Map();

export function startBackupSystem(): void {
  if (backupTimer !== null) return;
  
  // Load existing backup on startup
  loadBackup();
  
  // Start periodic backup
  backupTimer = setInterval(() => {
    saveBackup();
  }, BACKUP_INTERVAL);
}

export function stopBackupSystem(): void {
  if (backupTimer !== null) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}

export function trackEdit(fileId: number, editState: EditState): void {
  currentEdits.set(fileId, editState);
}

export function untrackEdit(fileId: number): void {
  currentEdits.delete(fileId);
}

function saveBackup(): void {
  if (currentEdits.size === 0) return;
  
  try {
    const data: BackupData = {
      timestamp: Date.now(),
      edits: currentEdits,
    };
    localStorage.setItem(BACKUP_KEY, JSON.stringify(data));
    console.log('[backup] saved', currentEdits.size, 'edit states');
  } catch (err) {
    console.error('[backup] failed to save:', err);
  }
}

function loadBackup(): void {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return;
    
    const data: BackupData = JSON.parse(raw);
    const age = Date.now() - data.timestamp;
    
    // Only restore if backup is less than 1 hour old
    if (age > 3600000) {
      console.log('[backup] backup too old, ignoring');
      localStorage.removeItem(BACKUP_KEY);
      return;
    }
    
    // Convert edits back to Map
    currentEdits = new Map(Object.entries(data.edits).map(([k, v]) => [Number(k), v as EditState]));
    console.log('[backup] restored', currentEdits.size, 'edit states from', new Date(data.timestamp).toLocaleString());
  } catch (err) {
    console.error('[backup] failed to load:', err);
    localStorage.removeItem(BACKUP_KEY);
  }
}

export function getBackupEdits(): Map<number, EditState> {
  return currentEdits;
}

export function clearBackup(): void {
  currentEdits.clear();
  localStorage.removeItem(BACKUP_KEY);
}
