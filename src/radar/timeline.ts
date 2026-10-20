/**
 * What to draw for a moment in time: frame A, frame B and how far between them (0 = A), or, past
 * the latest frame, that frame extrapolated `lead` seconds along the forecast motion.
 */
export interface FramePick {
  a: number;
  b: number;
  alpha: number;
  /** Seconds beyond frame A to extrapolate (0 unless this is a forecast). */
  lead: number;
}

export const pairKey = (t0: number, t1: number): string => `${t0}-${t1}`;

const at = (t: number): FramePick => ({ a: t, b: t, alpha: 0, lead: 0 });

/**
 * Pick the observed frames around `time`. Between two consecutive frames that have a motion field,
 * blend along it; otherwise use the nearest observed frame. After the latest frame, extrapolate up
 * to `forecastUntil` if given. `observed` must be sorted ascending.
 */
export function pickFrames(
  time: number,
  observed: number[],
  fields: { has(key: string): boolean },
  forecastUntil: number | null = null,
): FramePick | null {
  if (!observed.length) return null;
  if (time <= observed[0]) return at(observed[0]);
  const last = observed[observed.length - 1];
  if (time >= last) {
    if (forecastUntil === null || time === last) return at(last);
    return { ...at(last), lead: Math.min(time, forecastUntil) - last };
  }

  let i = 0;
  while (observed[i + 1] < time) i++;
  const t0 = observed[i];
  const t1 = observed[i + 1];
  if (time === t1) return at(t1);
  if (time === t0) return at(t0);
  if (fields.has(pairKey(t0, t1))) return { a: t0, b: t1, alpha: (time - t0) / (t1 - t0), lead: 0 };
  return at(time - t0 <= t1 - time ? t0 : t1);
}

/** The time a pick actually shows. */
export const pickTime = (p: FramePick): number => p.a + (p.b - p.a) * p.alpha + p.lead;
