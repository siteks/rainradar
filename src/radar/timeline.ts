/** What to draw for a moment in time: frame A, frame B and how far between them (0 = A). */
export interface FramePick {
  a: number;
  b: number;
  alpha: number;
}

export const pairKey = (t0: number, t1: number): string => `${t0}-${t1}`;

/**
 * Pick the observed frames around `time`. Between two consecutive frames that have a motion field,
 * blend along it; otherwise (outside the observed range, or the field isn't ready) use the nearest
 * observed frame. `observed` must be sorted ascending.
 */
export function pickFrames(time: number, observed: number[], fields: Set<string>): FramePick | null {
  if (!observed.length) return null;
  if (time <= observed[0]) return { a: observed[0], b: observed[0], alpha: 0 };
  const last = observed[observed.length - 1];
  if (time >= last) return { a: last, b: last, alpha: 0 };

  let i = 0;
  while (observed[i + 1] < time) i++;
  const t0 = observed[i];
  const t1 = observed[i + 1];
  if (time === t1) return { a: t1, b: t1, alpha: 0 };
  if (time === t0) return { a: t0, b: t0, alpha: 0 };
  if (fields.has(pairKey(t0, t1))) return { a: t0, b: t1, alpha: (time - t0) / (t1 - t0) };
  const nearest = time - t0 <= t1 - time ? t0 : t1;
  return { a: nearest, b: nearest, alpha: 0 };
}

/** The time a pick actually shows (its frames' blend point). */
export const pickTime = (p: FramePick): number => p.a + (p.b - p.a) * p.alpha;
