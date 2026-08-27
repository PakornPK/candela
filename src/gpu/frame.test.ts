import { describe, it, expect } from 'vitest';
import {
  FRAME_BORDER,
  FRAME_HOLE,
  frameStyleId,
  imageSource,
  inSprocketHole,
  isNeutralFrame,
  packFrame,
} from './frame';

describe('frame', () => {
  it('is neutral at none; packs the style id as 1 f32', () => {
    expect(isNeutralFrame('none')).toBe(true);
    expect(isNeutralFrame('135')).toBe(false);
    expect(Array.from(packFrame('none'))).toEqual([3, 0, 0, 0]);
    expect(Array.from(packFrame('135'))).toEqual([0, 0, 0, 0]);
    expect(Array.from(packFrame('120'))).toEqual([1, 0, 0, 0]);
    expect(Array.from(packFrame('print'))).toEqual([2, 0, 0, 0]);
  });

  it('print has the widest border; none has none', () => {
    expect(FRAME_BORDER.none).toBe(0);
    expect(FRAME_BORDER.print).toBeGreaterThan(FRAME_BORDER['135']);
    expect(FRAME_BORDER['135']).toBeGreaterThan(0);
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

  it('only 135 punches sprocket holes, in the top/bottom rebate bands', () => {
    expect(FRAME_HOLE['120']).toBe(0);
    expect(FRAME_HOLE.print).toBe(0);
    const b = FRAME_BORDER['135'];
    // A pixel centered in the top rebate band, within a hole cell.
    expect(inSprocketHole(0.03, b / 2, '135')).toBe(true);
    // Same row but in the gap between holes (phase >= 0.6 of the 0.055 cell).
    expect(inSprocketHole(0.05, b / 2, '135')).toBe(false);
    // The far band and the image interior are not holes.
    expect(inSprocketHole(0.03, 0.5, '135')).toBe(false);
    expect(inSprocketHole(0.03, 1 - b / 2, '135')).toBe(true); // bottom band yes
    // 120/print have no holes anywhere.
    expect(inSprocketHole(0.03, b / 2, '120')).toBe(false);
    expect(inSprocketHole(0.03, b / 2, 'print')).toBe(false);
  });

  it('style ids are stable for the shader', () => {
    expect(frameStyleId('135')).toBe(0);
    expect(frameStyleId('120')).toBe(1);
    expect(frameStyleId('print')).toBe(2);
    expect(frameStyleId('none')).toBe(3);
  });
});
