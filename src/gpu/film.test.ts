import { describe, it, expect } from 'vitest';
import { PORTRA_400, FILM_EXPOSURE_SCALE, filmDensity, filmicNegative, filmRenderLinear, srgbToLinear } from './film';

// sRGB OETF -- the CPU twin of the blit encode; filmRenderLinear's output
// unwraps THIS, so screen values below go through it to check the exposure pin.
function srgbEncode(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

const G = PORTRA_400.channels[1];

describe('filmDensity (the H-D curve, filmr SegmentedCurve::map_smooth)', () => {
  it('sits at the curve midpoint at the inflection exposure e0 (D = dMin + range/2)', () => {
    const d = filmDensity(Math.log10(G.e0), G);
    expect(d).toBeCloseTo(G.dMin + (G.dMax - G.dMin) / 2, 5);
  });

  it('has slope = gamma at the inflection (the channel contrast)', () => {
    const h = 1e-4;
    const slope = (filmDensity(Math.log10(G.e0) + h, G) - filmDensity(Math.log10(G.e0) - h, G)) / (2 * h);
    expect(slope).toBeCloseTo(G.gamma, 2);
  });

  it('is monotone, rising from dMin to dMax across the exposure range', () => {
    let prev = -1;
    for (let i = -12; i <= 8; i++) {
      const d = filmDensity(i, G);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeGreaterThanOrEqual(G.dMin - 1e-6);
      expect(d).toBeLessThanOrEqual(G.dMax + 1e-6);
      prev = d;
    }
  });
});

describe('filmicNegative (filmr FilmicCurve::negative)', () => {
  it('maps 0 -> 0 and 1 -> 1', () => {
    expect(filmicNegative(0)).toBeCloseTo(0, 5);
    expect(filmicNegative(1)).toBeCloseTo(1, 5);
  });

  it('is monotone and brighter than pure gamma in highlights (the shoulder rolls, no clip)', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = filmicNegative(i / 100);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    // filmr's own invariant: filmic highlight > simple gamma (shoulder lift).
    expect(filmicNegative(0.8)).toBeGreaterThan(0.8 ** 2.47);
  });
});

describe('filmRenderLinear + FILM_EXPOSURE_SCALE (the Portra 400 composite)', () => {
  // The tone LUT bakes the scanner output gain (stockRender): the full stock
  // render -- H-D at FILM_EXPOSURE_SCALE, then the channel's scan gain.
  function stockRender(lin: number, chIndex: number): number {
    return filmRenderLinear(lin, PORTRA_400.channels[chIndex], FILM_EXPOSURE_SCALE) * PORTRA_400.gain[chIndex];
  }

  it('anchors mid-gray at the camera look brightness (0.39 linear) -- the profile-swap pin', () => {
    // FILM_EXPOSURE_SCALE is chosen so a neutral mid-gray (0.18 linear, the
    // pipeline's exposure-0 convention) lands at 0.39 LINEAR -- the same
    // mid-gray the camera look renders (ACR baseline +1.11 EV). Switching to
    // the film profile is a look, not a re-exposure.
    expect(stockRender(0.18, 1)).toBeCloseTo(0.39, 2);
  });

  it('renders a NEUTRAL mid-gray (the scanner balance kills the raw layer cast)', () => {
    // Without balance the raw H-D curves cast neutral gray ~10% blue (the
    // layer imbalance); the balance offsets realign all three to neutral while
    // keeping the shape differences.
    const r = stockRender(0.18, 0);
    const g = stockRender(0.18, 1);
    const b = stockRender(0.18, 2);
    expect(r).toBeCloseTo(g, 3);
    expect(b).toBeCloseTo(g, 3);
  });

  it('keeps the film color character: warm shadows AND warm highlights (Portra warmth)', () => {
    // Shadows: R less dense (orange mask) -> R brighter than B, warm.
    expect(stockRender(0.02, 0)).toBeGreaterThan(stockRender(0.02, 2));
    // Highlights: the output-gain balance keeps R > G > B (warm) through the
    // top -- the shape differences stay, but the scanner neutralization avoids
    // the slide-film cool cast a logE-shift balance would give.
    expect(stockRender(0.95, 0)).toBeGreaterThan(stockRender(0.95, 2));
    // And the warm is gentle -- not a color smash.
    expect(stockRender(0.95, 0) / stockRender(0.95, 2)).toBeLessThan(1.2);
  });

  it('rolls highlights softly instead of clipping (the Portra shoulder)', () => {
    expect(stockRender(0.95, 1)).toBeLessThan(1.0);
    expect(stockRender(1.0, 1)).toBeGreaterThan(0.85); // near-white stays ~0.9
  });

  it('lifts blacks off true black (the film toe)', () => {
    expect(stockRender(0.002, 1)).toBeGreaterThan(0.0015);
  });

  it('is monotone over the tone op linear domain (per channel)', () => {
    for (let ch = 0; ch < 3; ch++) {
      let prev = -1;
      for (let i = -10; i <= 2; i++) {
        const v = stockRender(2 ** i, ch);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('srgbToLinear', () => {
  it('un-wraps sRGB back to linear (the inverse of the blit encode)', () => {
    for (const v of [0.0, 0.1, 0.3, 0.468, 0.9, 1.0]) {
      expect(srgbToLinear(srgbEncode(v))).toBeCloseTo(v, 5);
    }
  });
});
