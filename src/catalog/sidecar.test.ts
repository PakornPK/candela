import { describe, expect, it } from 'vitest';
import { sidecarFileName, sidecarSaveBlocker } from './sidecar';

describe('sidecarFileName', () => {
  it('strips the source extension and appends mode + .jpg', () => {
    expect(sidecarFileName('FUJI_BW.raf', 'camera')).toBe('FUJI_BW-camera.jpg');
    expect(sidecarFileName('IMG_0001.CR3', 'edited')).toBe('IMG_0001-edited.jpg');
    expect(sidecarFileName('no dots here', 'edited')).toBe('no dots here-edited.jpg');
  });

  it('keeps the last dot only as the extension boundary', () => {
    expect(sidecarFileName('v1.2.final.jpg', 'camera')).toBe('v1.2.final-camera.jpg');
  });
});

describe('sidecarSaveBlocker', () => {
  it('blocks Camera mode on non-RAW files with the exact tooltip copy', () => {
    expect(sidecarSaveBlocker('camera', false, true)).toBe(
      'Embedded JPEG only exists in RAW files',
    );
  });

  it('allows Camera mode on RAW regardless of develop state (pure extract)', () => {
    expect(sidecarSaveBlocker('camera', true, false)).toBeNull();
    expect(sidecarSaveBlocker('camera', true, true)).toBeNull();
  });

  it('blocks Edited mode until the loupe holds a decoded image', () => {
    expect(sidecarSaveBlocker('edited', true, false)).toContain('Develop');
    expect(sidecarSaveBlocker('edited', true, true)).toBeNull();
    expect(sidecarSaveBlocker('edited', false, true)).toBeNull();
  });
});
