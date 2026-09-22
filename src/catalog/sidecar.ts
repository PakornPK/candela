// Pure decision logic for the Develop Export panel's source toggle
// (Edited render vs Camera JPEG). Lives outside main.ts so the rules are
// unit-testable without a DOM (main.ts is all wiring and GPU state).

export type SidecarMode = 'edited' | 'camera';

// 'FUJI_BW.raf' + 'camera' -> 'FUJI_BW-camera.jpg'. Camera-mode exports
// are JPEGs, so the extension is fixed; the mode doubles as the filename
// suffix.
export function sidecarFileName(sourceName: string, mode: SidecarMode): string {
  return `${sourceName.replace(/\.[^.]+$/, '')}-${mode}.jpg`;
}

// Why an export is impossible right now (null = enabled). Two rules the
// single Export button + source toggle needs (the old UI had one button
// per mode, so the RAW rule lived as hiding the camera row entirely --
// with one toggle the camera side can't hide, so Camera-on-JPEG must
// disable Export instead; a hidden active toggle state is unreachable
// UI). The edited render needs the loupe's decoded pixels -- an unopened
// selection has none (same gate Export has always had).
export function sidecarSaveBlocker(
  mode: SidecarMode,
  isRaw: boolean,
  developReady: boolean,
): string | null {
  if (mode === 'camera' && !isRaw) return 'Embedded JPEG only exists in RAW files';
  if (mode === 'edited' && !developReady) {
    return 'Nothing to render yet — open the photo in Develop first (press E), then save.';
  }
  return null;
}
