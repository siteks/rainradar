import { describe, expect, it } from 'vitest';
import { forecastField, FORECAST_REF_SECONDS } from '../src/radar/forecast';
import { pairKey, pickFrames, pickTime } from '../src/radar/timeline';
import type { MotionField } from '../src/worker/motion';

const OBS = [1000, 1900, 2800];

describe('pickFrames', () => {
  it('returns null with no frames and clamps outside the observed range', () => {
    expect(pickFrames(1500, [], new Set())).toBeNull();
    expect(pickFrames(500, OBS, new Set())).toEqual({ a: 1000, b: 1000, alpha: 0, lead: 0 });
    expect(pickFrames(9999, OBS, new Set())).toEqual({ a: 2800, b: 2800, alpha: 0, lead: 0 });
  });

  it('blends along the motion between consecutive frames when the field exists', () => {
    const fields = new Set([pairKey(1000, 1900)]);
    expect(pickFrames(1300, OBS, fields)).toEqual({ a: 1000, b: 1900, alpha: 1 / 3, lead: 0 });
    expect(pickTime(pickFrames(1300, OBS, fields)!)).toBeCloseTo(1300);
    expect(pickFrames(1900, OBS, fields)).toEqual({ a: 1900, b: 1900, alpha: 0, lead: 0 });
  });

  it('falls back to the nearest observed frame until the motion is ready', () => {
    expect(pickFrames(1300, OBS, new Set())).toEqual({ a: 1000, b: 1000, alpha: 0, lead: 0 });
    expect(pickFrames(1700, OBS, new Set())).toEqual({ a: 1900, b: 1900, alpha: 0, lead: 0 });
  });

  it('extrapolates past the latest frame only when a forecast is available, up to its end', () => {
    expect(pickFrames(3400, OBS, new Set(), null)).toEqual({ a: 2800, b: 2800, alpha: 0, lead: 0 });
    expect(pickFrames(3400, OBS, new Set(), 9000)).toEqual({ a: 2800, b: 2800, alpha: 0, lead: 600 });
    expect(pickFrames(99999, OBS, new Set(), 9000)!.lead).toBe(6200);
    expect(pickTime(pickFrames(3400, OBS, new Set(), 9000)!)).toBe(3400);
  });
});

describe('forecastField', () => {
  const field = (u: number, v: number): MotionField => ({ step: 24, cols: 2, rows: 1, u: new Float32Array([u, u]), v: new Float32Array([v, v]) });

  it('is null without recent fields', () => {
    expect(forecastField(new Map(), 5000)).toBeNull();
    expect(forecastField(new Map([[pairKey(0, 900), field(1, 1)]]), 9000)).toBeNull();
  });

  it('rescales each pair to the reference interval and weights the newest most', () => {
    const fields = new Map([
      [pairKey(0, 900), field(3, 0)], // 3 px / 900 s, weight 2
      [pairKey(900, 2700), field(12, 6)], // 12 px / 1800 s → 6 px / 900 s, weight 3
    ]);
    const f = forecastField(fields, 2700)!;
    expect(FORECAST_REF_SECONDS).toBe(900);
    expect(f.u[0]).toBeCloseTo((3 * 6 + 2 * 3) / 5);
    expect(f.v[0]).toBeCloseTo((3 * 3 + 2 * 0) / 5);
  });
});
