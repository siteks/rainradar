import { describe, expect, it } from 'vitest';
import { pairKey, pickFrames, pickTime } from '../src/radar/timeline';

const OBS = [1000, 1900, 2800];

describe('pickFrames', () => {
  it('returns null with no frames and clamps outside the observed range', () => {
    expect(pickFrames(1500, [], new Set())).toBeNull();
    expect(pickFrames(500, OBS, new Set())).toEqual({ a: 1000, b: 1000, alpha: 0 });
    expect(pickFrames(9999, OBS, new Set())).toEqual({ a: 2800, b: 2800, alpha: 0 });
  });

  it('blends along the motion between consecutive frames when the field exists', () => {
    const fields = new Set([pairKey(1000, 1900)]);
    expect(pickFrames(1300, OBS, fields)).toEqual({ a: 1000, b: 1900, alpha: 1 / 3 });
    expect(pickTime(pickFrames(1300, OBS, fields)!)).toBeCloseTo(1300);
    expect(pickFrames(1900, OBS, fields)).toEqual({ a: 1900, b: 1900, alpha: 0 });
  });

  it('falls back to the nearest observed frame until the motion is ready', () => {
    expect(pickFrames(1300, OBS, new Set())).toEqual({ a: 1000, b: 1000, alpha: 0 });
    expect(pickFrames(1700, OBS, new Set())).toEqual({ a: 1900, b: 1900, alpha: 0 });
  });
});
