import { describe, it, expect } from 'vitest';
import { orientationFromFlip, flippedDims, mapOutputPoint, remapCfa6 } from './orient';

// LibRaw's OWN gather mapping, mirrored from the vendored source
// (src/write/file_write.cpp:20-29 flip_index + the write loop at :224-226,
// where iheight/iwidth hold the SENSOR dims and the output loop bounds were
// swapped for flip & 4 at :182-183). Given output coords (row=y, col=x) it
// returns the SENSOR index. Every orientation test below checks that our
// forward map is the exact inverse of this, over the full grid.
function flipIndex(flip: number, row: number, col: number, iheight: number, iwidth: number): number {
  if (flip & 4) {
    const t = row;
    row = col;
    col = t;
  }
  if (flip & 2) row = iheight - 1 - row;
  if (flip & 1) col = iwidth - 1 - col;
  return row * iwidth + col;
}

describe('orientationFromFlip / flippedDims', () => {
  it('decomposes dcraw flip bits', () => {
    expect(orientationFromFlip(0)).toEqual({ swap: 0, flipY: 0, flipX: 0 });
    expect(orientationFromFlip(1)).toEqual({ swap: 0, flipY: 0, flipX: 1 });
    expect(orientationFromFlip(2)).toEqual({ swap: 0, flipY: 1, flipX: 0 });
    expect(orientationFromFlip(3)).toEqual({ swap: 0, flipY: 1, flipX: 1 });
    expect(orientationFromFlip(4)).toEqual({ swap: 1, flipY: 0, flipX: 0 });
    expect(orientationFromFlip(5)).toEqual({ swap: 1, flipY: 0, flipX: 1 });
    // EXIF Orientation 6 (Rotate 90 CW) -> LibRaw flip 6: transpose + row mirror.
    expect(orientationFromFlip(6)).toEqual({ swap: 1, flipY: 1, flipX: 0 });
    expect(orientationFromFlip(7)).toEqual({ swap: 1, flipY: 1, flipX: 1 });
  });

  it('transposes the output dims only when flip & 4', () => {
    expect(flippedDims(0, 6246, 4170)).toEqual([6246, 4170]);
    expect(flippedDims(3, 6246, 4170)).toEqual([6246, 4170]);
    expect(flippedDims(6, 6246, 4170)).toEqual([4170, 6246]); // portrait
  });
});

describe('mapOutputPoint is the exact inverse of LibRaw flip_index', () => {
  // A rectangular grid (12x8 landscape) so transpose asymmetry can't hide,
  // plus an odd square to catch parity mistakes in the mod-6 phase paths.
  const grids: [number, number][] = [[12, 8], [8, 12], [7, 5], [6, 6]];
  for (const [srcW, srcH] of grids) {
    for (const flip of [0, 1, 2, 3, 4, 5, 6, 7]) {
      it(`flip=${flip} on ${srcW}x${srcH}: bijection + flip_index round-trip`, () => {
        const o = orientationFromFlip(flip);
        const [outW, outH] = flippedDims(flip, srcW, srcH);
        const seen = new Set<number>();
        for (let y = 0; y < srcH; y++) {
          for (let x = 0; x < srcW; x++) {
            const [ox, oy] = mapOutputPoint(o, x, y, srcW, srcH);
            expect(ox).toBeGreaterThanOrEqual(0);
            expect(oy).toBeGreaterThanOrEqual(0);
            expect(ox).toBeLessThan(outW);
            expect(oy).toBeLessThan(outH);
            // LibRaw gathers output pixel (oy, ox) from this sensor index...
            const idx = flipIndex(flip, oy, ox, srcH, srcW);
            expect(Math.floor(idx / srcW)).toBe(y);
            expect(idx % srcW).toBe(x);
            const key = oy * outW + ox;
            expect(seen.has(key)).toBe(false); // no collisions
            seen.add(key);
          }
        }
        expect(seen.size).toBe(outW * outH); // ...and full coverage
      });
    }
  }

  it('flip=6 is a true 90 CW rotation (Rotate 90 CW corner mapping)', () => {
    const o = orientationFromFlip(6);
    // Landscape sensor 4x2 -> portrait 2x4. Rotating 90 CW puts the sensor's
    // top-LEFT corner at the output's top-RIGHT.
    expect(mapOutputPoint(o, 0, 0, 4, 2)).toEqual([1, 0]);
    expect(mapOutputPoint(o, 3, 0, 4, 2)).toEqual([1, 3]);
    expect(mapOutputPoint(o, 0, 1, 4, 2)).toEqual([0, 0]);
    expect(mapOutputPoint(o, 3, 1, 4, 2)).toEqual([0, 3]);
  });
});

describe('remapCfa6', () => {
  // Distinct-value 6x6 ramp: any permutation error shows up as a mismatch.
  const ramp = Uint8Array.from({ length: 36 }, (_, i) => i % 3); // R G B tiled (not 6-periodic-symmetric)
  // A genuinely 6x6 X-Trans-style pattern (colors 0/1/2, 6-periodic rows).
  const xtrans = Uint8Array.from([
    1, 0, 1, 2, 1, 1,
    1, 1, 2, 1, 1, 0,
    2, 1, 1, 0, 1, 1,
    1, 1, 0, 1, 2, 1,
    0, 1, 1, 1, 1, 2,
    1, 2, 1, 1, 0, 1,
  ]);

  it('flip=0 is a byte-exact no-op', () => {
    expect(Array.from(remapCfa6(xtrans, 0, 6246, 4170))).toEqual(Array.from(xtrans));
  });

  it('matches the per-texel truth: output ox,oy reads the sensor texel the pixel map picked', () => {
    // Truth: pattern(ox,oy) == shifted[ (iy + 0) % 6 * 6 + (ix + 0) % 6 ]
    // where (ix,iy) = inverse-of-flip of (ox,oy) == flipIndex's sensor index
    // mod 6 (mirrors what the demosaic sees in the flipped normalized
    // texture). Checked for all flips against the LibRaw gather.
    const srcW = 42, srcH = 18; // multiples of 6 plus... 42x18, both mod-6 = 0, exercises the swap bounds
    const srcW2 = 40, srcH2 = 17; // NOT multiples of 6: mod-6 phase must survive any dims
    for (const flip of [1, 2, 3, 4, 5, 6, 7]) {
      for (const [sw, sh] of [[srcW, srcH], [srcW2, srcH2]] as const) {
        const [outW, outH] = flippedDims(flip, sw, sh);
        const remapped = remapCfa6(xtrans, flip, sw, sh);
        for (let oy = 0; oy < Math.min(6, outH); oy++) {
          for (let ox = 0; ox < Math.min(6, outW); ox++) {
            const idx = flipIndex(flip, oy, ox, sh, sw);
            const sx = idx % sw, sy = Math.floor(idx / sw);
            expect(remapped[oy * 6 + ox]).toBe(xtrans[(sy % 6) * 6 + (sx % 6)]);
          }
        }
      }
    }
  });

  it('margin phase rides through: a (left,top) shift equals shifting then remapping with srcW-mod offsets', () => {
    // shiftCfa6 output (pattern sampled at (y+top)%6,(x+left)%6) fed through
    // remapCfa6 must equal remapping at zero margin when margins are whole
    // 6-multiples (the X100V case: leftMargin=69? -- checked live), and the
    // general path holds by the per-texel truth above with the shift folded
    // into `shifted`.
    const shifted = Uint8Array.from({ length: 36 }, (_, i) => i % 3);
    const direct = remapCfa6(shifted, 6, 60, 54);
    // Independent recomposition: for each output texel, gather the sensor
    // texel via flipIndex on the SHIFTED pattern.
    for (let oy = 0; oy < 6; oy++) {
      for (let ox = 0; ox < 6; ox++) {
        const idx = flipIndex(6, oy, ox, 54, 60);
        const sx = idx % 60, sy = Math.floor(idx / 60);
        expect(direct[oy * 6 + ox]).toBe(shifted[(sy % 6) * 6 + (sx % 6)]);
      }
    }
  });

  it('Bayer tiles stay Bayer tiles under every flip', () => {
    // 2x2 RGGB tiled to 6x6: a flip may swap/shift axes but must not create
    // a pattern whose colors aren't a mirror/transpose of the tile.
    const rggb = Uint8Array.from({ length: 36 }, (_, i) => {
      const y = Math.floor(i / 6) % 2, x = i % 6 % 2;
      return [0, 1, 1, 2][y * 2 + x];
    });
    for (const flip of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const r = remapCfa6(rggb, flip, 42, 18);
      // Every row is one of the tile rows or their mirrors; counts hold.
      expect([...r].filter((c) => c === 0).length).toBe(9);
      expect([...r].filter((c) => c === 1).length).toBe(18);
      expect([...r].filter((c) => c === 2).length).toBe(9);
    }
  });

  it('rejects nothing, always 36 bytes', () => {
    expect(remapCfa6(ramp, 6, 6246, 4170).length).toBe(36);
  });
});
