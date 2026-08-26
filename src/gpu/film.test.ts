import { describe, it, expect } from 'vitest';
import { PORTRA_400, FILM_EXPOSURE_SCALE, FILM_MID_GRAY_TARGET, FILM_STOCKS, filmDensity, filmExposureScale, filmicNegative, filmRenderLinear, isFilmStockId, neutralGain, srgbToLinear } from './film';

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

describe('filmExposureScale (per-stock mid-gray anchor)', () => {
  it('reproduces Portra 400\'s original FILM_EXPOSURE_SCALE', () => {
    // The solver must land back on the analytically-fitted Portra anchor
    // (0.39 mid-gray was fit to 2dp; the binary search converges to ~0.3 of
    // scale, i.e. mid-gray within 1e-4 -- well inside the output tolerance).
    expect(Math.abs(filmExposureScale(PORTRA_400) - FILM_EXPOSURE_SCALE)).toBeLessThan(0.5);
  });

  it('renders the SAME mid-gray (0.39) for every stock -- stock switch is a look, not a re-exposure', () => {
    // filmr's exposure_offset is not comparable across presets (Portra e0=625,
    // others 0.03-0.6) and gammas differ (slides ~1.3 vs negatives ~0.6). The
    // per-stock scale compensates: a Fuji slide or a fast negative must NOT
    // blow out at the exposure-0 mid-gray the camera look renders.
    for (const stock of Object.values(FILM_STOCKS)) {
      const scale = filmExposureScale(stock);
      const out = filmRenderLinear(0.18, stock.channels[1], scale);
      expect(out).toBeCloseTo(FILM_MID_GRAY_TARGET, 3);
      expect(scale).toBeGreaterThan(1e-3);
      expect(scale).toBeLessThan(1e6);
    }
  });
});

describe('neutralGain (the scanner balance)', () => {
  it('renders a NEUTRAL mid-gray for every stock', () => {
    for (const stock of Object.values(FILM_STOCKS)) {
      const gain = neutralGain(stock);
      const scale = filmExposureScale(stock);
      const r = filmRenderLinear(0.18, stock.channels[0], scale) * gain[0];
      const g = filmRenderLinear(0.18, stock.channels[1], scale) * gain[1];
      const b = filmRenderLinear(0.18, stock.channels[2], scale) * gain[2];
      expect(r).toBeCloseTo(g, 6);
      expect(b).toBeCloseTo(g, 6);
    }
  });

  it('gains are positive and sane', () => {
    for (const stock of Object.values(FILM_STOCKS)) {
      for (const v of neutralGain(stock)) {
        expect(v).toBeGreaterThan(0.2);
        expect(v).toBeLessThan(5);
      }
    }
  });
});

describe('FILM_STOCKS registry', () => {
  it('covers every ProfileKind film id and isFilmStockId agrees', () => {
    const ids = ['portra400', 'portra160', 'portra800', 'gold200', 'ektar100', 'superia400', 'ektachrome100', 'provia100f', 'velvia50', 'cinestill800t'] as const;
    expect(Object.keys(FILM_STOCKS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(isFilmStockId(id)).toBe(true);
      expect(FILM_STOCKS[id].id).toBe(id);
      expect(FILM_STOCKS[id].name.length).toBeGreaterThan(0);
    }
    expect(isFilmStockId('camera')).toBe(false);
    expect(isFilmStockId('neutral')).toBe(false);
    expect(isFilmStockId('film')).toBe(false); // the old single-film value is gone
    expect(isFilmStockId(undefined)).toBe(false);
  });

  it('stocks are visually distinct -- a slide departs from a negative off mid-gray', () => {
    // Both anchor mid-gray at 0.39 (above), but the punchy slide curve (gamma
    // ~1.3, dMax 3.5) diverges in the shadows and highlights vs a soft negative.
    const render = (id: keyof typeof FILM_STOCKS, lin: number, ch: number) => {
      const stock = FILM_STOCKS[id];
      const gain = neutralGain(stock);
      return filmRenderLinear(lin, stock.channels[ch], filmExposureScale(stock)) * gain[ch];
    };
    const slideSh = render('ektachrome100', 0.02, 1);
    const portraSh = render('portra400', 0.02, 1);
    const slideHi = render('ektachrome100', 0.9, 1);
    const portraHi = render('portra400', 0.9, 1);
    expect(slideSh).not.toBeCloseTo(portraSh, 3);
    expect(slideHi).not.toBeCloseTo(portraHi, 3);
    // And Cinestill (equal gammas, tungsten neg) differs from Portra too.
    expect(render('cinestill800t', 0.9, 0)).not.toBeCloseTo(render('portra400', 0.9, 0), 3);
  });
});
