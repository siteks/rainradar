import { describe, expect, it } from 'vitest';
import { formatAge, formatOffset } from '../src/ui/time';

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

describe('formatAge', () => {
  it('shows minutes, then hours, never negative', () => {
    expect(formatAge(1000, 1000 + 14 * 60 + 30)).toBe('radar 14 min old');
    expect(formatAge(1000, 1000 + 65 * 60)).toBe('radar 1 h 05 old');
    expect(formatAge(1000, 900)).toBe('radar 0 min old');
  });
});
