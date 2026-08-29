import { describe, it, expect } from 'vitest';
import {
  FRAME_BORDER,
  PRINT_KEYLINE,
  frameStyleId,
  imageSource,
  isNeutralFrame,
  isPrintKeyline,
  packFrame,
} from './frame';

describe('frame', () => {
  it('is neutral at none; packs the style id as 1 f32', () => {
    expect(isNeutralFrame('none')).toBe(true);
    expect(isNeutralFrame('135')).toBe(false);
    expect(Array.from(packFrame('none'))).toEqual([3, 0, 0, 1, 1, 0, 0, 0]);
    expect(Array.from(packFrame('135'))).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
    expect(Array.from(packFrame('120'))).toEqual([1, 0, 0, 1, 1, 0, 0, 0]);
    expect(Array.from(packFrame('print'))).toEqual([2, 0, 0, 1, 1, 0, 0, 0]);
    // A crop region makes the frame wrap the image inside the crop.
    expect(Array.from(packFrame('135', [0.25, 0.125, 0.5, 0.5]))).toEqual([0, 0.25, 0.125, 0.5, 0.5, 0, 0, 0]);
  });

  it('print has the widest border; none has none', () => {
    expect(FRAME_BORDER.none).toBe(0);
    expect(FRAME_BORDER.print).toBeGreaterThan(FRAME_BORDER['135']);
    expect(FRAME_BORDER['135']).toBeGreaterThan(0);
    expect(PRINT_KEYLINE).toBeGreaterThan(0);
    expect(PRINT_KEYLINE).toBeLessThan(FRAME_BORDER.print);
  });

  it('imageSource maps the inner rect to the full source', () => {
    const b = FRAME_BORDER['135'];
    expect(imageSource(b, b)).toBe(0);
    expect(imageSource(1 - b, b)).toBeCloseTo(1, 6);
    expect(imageSource(0.5, b)).toBeCloseTo(0.5, 6);
    // Far outside clamps rather than sampling past the source.
    expect(imageSource(0, b)).toBe(0);
    expect(imageSource(1, b)).toBe(1);
  });

  it('isPrintKeyline accurately detects the thin black keyline band around the image', () => {
    const b = FRAME_BORDER.print; // 0.10
    const kl = PRINT_KEYLINE;     // 0.005

    // Inside the image area: should be false (rendered as photo)
    expect(isPrintKeyline(0.5, 0.5, b, kl)).toBe(false);
    expect(isPrintKeyline(0.101, 0.5, b, kl)).toBe(false);
    expect(isPrintKeyline(0.5, 0.899, b, kl)).toBe(false);

    // Right on the keyline bordering the image (all 4 sides): should be true
    expect(isPrintKeyline(0.098, 0.5, b, kl)).toBe(true); // left keyline
    expect(isPrintKeyline(0.902, 0.5, b, kl)).toBe(true); // right keyline
    expect(isPrintKeyline(0.5, 0.098, b, kl)).toBe(true); // top keyline
    expect(isPrintKeyline(0.5, 0.902, b, kl)).toBe(true); // bottom keyline

    // Keyline corners: should be true
    expect(isPrintKeyline(0.098, 0.098, b, kl)).toBe(true); // top-left corner
    expect(isPrintKeyline(0.902, 0.098, b, kl)).toBe(true); // top-right corner
    expect(isPrintKeyline(0.098, 0.902, b, kl)).toBe(true); // bottom-left corner
    expect(isPrintKeyline(0.902, 0.902, b, kl)).toBe(true); // bottom-right corner

    // Outer white paper matte (beyond keyline): should be false (rendered as matte paper)
    expect(isPrintKeyline(0.05, 0.5, b, kl)).toBe(false);
    expect(isPrintKeyline(0.95, 0.5, b, kl)).toBe(false);
    expect(isPrintKeyline(0.5, 0.05, b, kl)).toBe(false);
    expect(isPrintKeyline(0.5, 0.95, b, kl)).toBe(false);
    expect(isPrintKeyline(0.05, 0.05, b, kl)).toBe(false);
  });

  it('style ids are stable for the shader', () => {
    expect(frameStyleId('135')).toBe(0);
    expect(frameStyleId('120')).toBe(1);
    expect(frameStyleId('print')).toBe(2);
    expect(frameStyleId('none')).toBe(3);
  });
});

