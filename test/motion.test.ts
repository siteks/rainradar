import { describe, expect, it } from 'vitest';
import { DRY, NODATA, quantise } from '../src/radar/palette';
import { estimateMotion, morph, type Dims } from '../src/worker/motion';

const DIMS: Dims = { width: 480, height: 480 };

/** Deterministic field of Gaussian rain cells, sampled at an offset (sub-pixel allowed). */
function rainField(dims: Dims, shiftX = 0, shiftY = 0, seed = 7): Uint8Array {
  let s = seed;
  const rand = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const cells = Array.from({ length: 120 }, () => ({
    x: rand() * dims.width,
    y: rand() * dims.height,
    r: 6 + rand() * 18,
    peak: 0.5 + rand() * 20,
  }));
  const out = new Uint8Array(dims.width * dims.height);
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      let rate = 0;
      for (const c of cells) {
        const d2 = (x - shiftX - c.x) ** 2 + (y - shiftY - c.y) ** 2;
        if (d2 < 9 * c.r * c.r) rate += c.peak * Math.exp(-d2 / (2 * c.r * c.r));
      }
      out[y * dims.width + x] = quantise(rate);
    }
  }
  return out;
}

function interiorNodes(f: ReturnType<typeof estimateMotion>): number[] {
  const ks: number[] = [];
  for (let j = 2; j < f.rows - 2; j++) for (let i = 2; i < f.cols - 2; i++) ks.push(j * f.cols + i);
  return ks;
}

/** Fraction of pixels whose rain/no-rain state differs (ignoring a border). */
function mismatch(a: Uint8Array, b: Uint8Array, dims: Dims, border = 40): number {
  let diff = 0;
  let n = 0;
  for (let y = border; y < dims.height - border; y++) {
    for (let x = border; x < dims.width - border; x++) {
      const k = y * dims.width + x;
      n++;
      if (Math.abs(a[k] - b[k]) > 6) diff++;
    }
  }
  return diff / n;
}

describe('motion estimation', () => {
  it('recovers a uniform translation to within a pixel', () => {
    const a = rainField(DIMS);
    const b = rainField(DIMS, 13, -9);
    const f = estimateMotion(a, b, DIMS);
    for (const k of interiorNodes(f)) {
      expect(Math.abs(f.u[k] - 13)).toBeLessThan(1);
      expect(Math.abs(f.v[k] + 9)).toBeLessThan(1);
    }
  });

  it('gets sub-pixel shifts approximately right', () => {
    const a = rainField(DIMS);
    const b = rainField(DIMS, 6.5, 3.5);
    const f = estimateMotion(a, b, DIMS);
    const ks = interiorNodes(f);
    const mu = ks.reduce((s, k) => s + f.u[k], 0) / ks.length;
    const mv = ks.reduce((s, k) => s + f.v[k], 0) / ks.length;
    expect(Math.abs(mu - 6.5)).toBeLessThan(0.6);
    expect(Math.abs(mv - 3.5)).toBeLessThan(0.6);
  });

  it('returns zero motion for identical frames and copes with an all-dry frame', () => {
    const a = rainField(DIMS);
    const still = estimateMotion(a, a, DIMS);
    expect(Math.max(...still.u.map(Math.abs), ...still.v.map(Math.abs))).toBeLessThan(0.5);

    const dry = new Uint8Array(DIMS.width * DIMS.height).fill(DRY);
    const none = estimateMotion(dry, dry, DIMS);
    expect(none.u.every((x) => x === 0) && none.v.every((x) => x === 0)).toBe(true);
  });
});

describe('morph', () => {
  it('places rain part-way along the motion instead of cross-fading', () => {
    const a = rainField(DIMS);
    const b = rainField(DIMS, 18, 12);
    const f = estimateMotion(a, b, DIMS);
    const third = morph(a, b, f, 1 / 3, DIMS);
    const truth = rainField(DIMS, 6, 4);
    // Motion-compensated frame matches the true intermediate far better than either endpoint does.
    expect(mismatch(third, truth, DIMS)).toBeLessThan(0.05);
    expect(mismatch(a, truth, DIMS)).toBeGreaterThan(0.1);
  });

  it('reproduces the endpoints at alpha 0 and 1, and keeps no-data where both inputs lack it', () => {
    const a = rainField(DIMS);
    const b = rainField(DIMS, 10, 0);
    const f = estimateMotion(a, b, DIMS);
    expect(mismatch(morph(a, b, f, 0, DIMS), a, DIMS)).toBe(0);
    expect(mismatch(morph(a, b, f, 1, DIMS), b, DIMS)).toBe(0);

    const blank = new Uint8Array(DIMS.width * DIMS.height); // all NODATA
    expect(morph(blank, blank, f, 0.5, DIMS).every((q) => q === NODATA)).toBe(true);
  });
});
