import { describe, expect, it } from 'vitest';
import { extrapolate, uniformField } from '../src/radar/extrapolate';
import { DRY, NODATA, quantise } from '../src/radar/palette';
import { Contingency, FractionsSkill } from '../src/verify/metrics';
import type { Dims, MotionField } from '../src/worker/motion';

const DIMS: Dims = { width: 120, height: 96 };

/** A square of rain (mm/h) on a dry background. */
function square(x0: number, y0: number, size: number, rate = 5, dims = DIMS): Uint8Array {
  const f = new Uint8Array(dims.width * dims.height).fill(DRY);
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) f[y * dims.width + x] = quantise(rate);
  return f;
}

const field = (u: number, v: number): MotionField => ({
  step: 24,
  cols: Math.ceil(DIMS.width / 24),
  rows: Math.ceil(DIMS.height / 24),
  u: new Float32Array(25).fill(u),
  v: new Float32Array(25).fill(v),
});

describe('extrapolate (CPU copy of the shader forecast)', () => {
  it('moves rain along a uniform field by lead/900 of the displacement', () => {
    const out = extrapolate(square(30, 30, 20), field(9, -6), [900, 1800], DIMS);
    const at = (lead: number, x: number, y: number): number => out.get(lead)![y * DIMS.width + x];
    expect(at(900, 30 + 9 + 10, 30 - 6 + 10)).toBe(quantise(5)); // square centre moved by (9, −6)
    expect(at(900, 30 + 2, 30 + 15)).toBe(DRY); // left edge vacated
    expect(at(1800, 30 + 18 + 10, 30 - 12 + 10)).toBe(quantise(5));
  });

  it('marks rain arriving from outside the grid as unknown', () => {
    const out = extrapolate(square(30, 30, 20), field(9, 0), [900], DIMS).get(900)!;
    expect(out[50 * DIMS.width + 3]).toBe(NODATA); // traced back to x < 0
    expect(out[50 * DIMS.width + 60]).not.toBe(NODATA);
  });

  it('uniformField replaces every vector with the median', () => {
    const f = field(0, 0);
    f.u.set([1, 2, 3, 100, 2]);
    expect(new Set(uniformField(f).u)).toEqual(new Set([0]));
  });
});

describe('metrics', () => {
  it('counts the contingency table, skipping no-data pixels', () => {
    const fc = Uint8Array.from([quantise(1), quantise(1), DRY, DRY, NODATA]);
    const ob = Uint8Array.from([quantise(1), DRY, quantise(1), DRY, quantise(1)]);
    const c = new Contingency(0.5);
    c.add(fc, ob);
    expect([c.hits, c.falseAlarms, c.misses, c.correctNegatives]).toEqual([1, 1, 1, 1]);
    expect(c.csi()).toBeCloseTo(1 / 3);
    expect(c.bias()).toBe(1);
  });

  it('FSS is 1 for a perfect forecast, 0 for a far miss, and forgives a near miss at larger scales', () => {
    const obs = square(30, 30, 12);
    const perfect = new FractionsSkill(0.5, 11, DIMS);
    perfect.add(obs, obs);
    expect(perfect.fss()).toBeCloseTo(1);

    const far = new FractionsSkill(0.5, 11, DIMS);
    far.add(square(90, 70, 12), obs);
    expect(far.fss()).toBeCloseTo(0);

    const near = square(36, 30, 12); // 6 px east
    const small = new FractionsSkill(0.5, 3, DIMS);
    const large = new FractionsSkill(0.5, 31, DIMS);
    small.add(near, obs);
    large.add(near, obs);
    expect(large.fss()).toBeGreaterThan(small.fss());
    expect(large.fss()).toBeGreaterThan(large.useful());
  });
});
