import { describe, expect, it } from 'vitest';
import { formatOffset } from '../src/ui/time';

describe('formatOffset', () => {
  const now = 1_800_000_045; // 45 s into a minute
  const slot = Math.floor(now / 60) * 60;

  it('reads "Now" for the current minute however far into it we are', () => {
    expect(formatOffset(slot, now)).toBe('Now');
    expect(formatOffset(slot, slot + 59)).toBe('Now');
  });

  it('signs past and future, switching to hours from 60 min', () => {
    expect(formatOffset(slot - 25 * 60, now)).toBe('−25 min');
    expect(formatOffset(slot + 40 * 60, now)).toBe('+40 min');
    expect(formatOffset(slot + 65 * 60, now)).toBe('+1 h 05');
    expect(formatOffset(slot - 120 * 60, now)).toBe('−2 h 00');
  });
});
