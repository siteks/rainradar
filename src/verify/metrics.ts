// Forecast verification scores, accumulated over many cases. Frames use the palette.ts byte encoding;
// pixels where either forecast or observation has no data are left out.

import type { Dims } from '../worker/motion';
import { NODATA, quantise } from '../radar/palette';

/** Accumulates a 2×2 contingency table: rain = value ≥ threshold. */
export class Contingency {
  hits = 0;
  misses = 0;
  falseAlarms = 0;
  correctNegatives = 0;
  private readonly q: number;

  constructor(readonly thresholdMmH: number) {
    this.q = quantise(thresholdMmH);
  }

  add(forecast: Uint8Array, observed: Uint8Array): void {
    for (let i = 0; i < observed.length; i++) {
      const f = forecast[i];
      const o = observed[i];
      if (f === NODATA || o === NODATA) continue;
      const fr = f >= this.q;
      const or = o >= this.q;
      if (fr && or) this.hits++;
      else if (or) this.misses++;
      else if (fr) this.falseAlarms++;
      else this.correctNegatives++;
    }
  }

  /** Critical success index: hits / (hits + misses + false alarms). NaN with no rain anywhere. */
  csi(): number {
    return this.hits / (this.hits + this.misses + this.falseAlarms);
  }

  /** Frequency bias: forecast rain area / observed rain area (1 = right amount). */
  bias(): number {
    return (this.hits + this.falseAlarms) / (this.hits + this.misses);
  }
}

/** Summed-area table of a 0/1 indicator, (w+1)×(h+1). */
function integral(indicator: (i: number) => number, dims: Dims): Float64Array {
  const { width: w, height: h } = dims;
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += indicator(y * w + x);
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

function boxSum(s: Float64Array, dims: Dims, x: number, y: number, half: number): number {
  const w1 = dims.width + 1;
  const x0 = Math.max(0, x - half);
  const y0 = Math.max(0, y - half);
  const x1 = Math.min(dims.width, x + half + 1);
  const y1 = Math.min(dims.height, y + half + 1);
  return s[y1 * w1 + x1] - s[y0 * w1 + x1] - s[y1 * w1 + x0] + s[y0 * w1 + x0];
}

/**
 * Fractions skill score at one threshold and neighbourhood size (pixels, odd). Fractions are the
 * share of valid pixels in each window that have rain; FSS = 1 − Σ(Pf − Po)² / Σ(Pf² + Po²) over
 * valid pixels. 1 is perfect; above ≈ 0.5 + f₀/2 (f₀ = observed rain fraction) counts as useful.
 */
export class FractionsSkill {
  private num = 0;
  private den = 0;
  private rain = 0;
  private valid = 0;
  private readonly q: number;

  constructor(
    readonly thresholdMmH: number,
    readonly window: number,
    private readonly dims: Dims,
  ) {
    this.q = quantise(thresholdMmH);
  }

  add(forecast: Uint8Array, observed: Uint8Array): void {
    const ok = (i: number): boolean => forecast[i] !== NODATA && observed[i] !== NODATA;
    const validS = integral((i) => (ok(i) ? 1 : 0), this.dims);
    const fS = integral((i) => (ok(i) && forecast[i] >= this.q ? 1 : 0), this.dims);
    const oS = integral((i) => (ok(i) && observed[i] >= this.q ? 1 : 0), this.dims);
    const half = this.window >> 1;
    const { width, height } = this.dims;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!ok(i)) continue;
        const n = boxSum(validS, this.dims, x, y, half);
        const pf = boxSum(fS, this.dims, x, y, half) / n;
        const po = boxSum(oS, this.dims, x, y, half) / n;
        this.num += (pf - po) ** 2;
        this.den += pf * pf + po * po;
        this.valid++;
        if (observed[i] >= this.q) this.rain++;
      }
    }
  }

  fss(): number {
    return 1 - this.num / this.den;
  }

  /** FSS a forecast needs to count as useful at this scale: 0.5 + f₀/2. */
  useful(): number {
    return 0.5 + this.rain / this.valid / 2;
  }
}
