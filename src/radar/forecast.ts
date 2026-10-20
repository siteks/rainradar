import type { MotionField } from '../worker/motion';

/** Forecast fields hold displacement per this many seconds (one radar interval). */
export const FORECAST_REF_SECONDS = 900;

/**
 * The motion to extrapolate with: a weighted mean of the most recent pair fields (newest weighted
 * most), each rescaled to displacement per FORECAST_REF_SECONDS. Averaging a few intervals damps
 * noise in any single estimate. Fields are keyed "t0-t1"; all share the same node lattice.
 */
export function forecastField(fields: Map<string, MotionField>, latest: number, lookback = 2700): MotionField | null {
  const recent = [...fields]
    .map(([key, field]) => {
      const [t0, t1] = key.split('-').map(Number);
      return { t0, t1, field };
    })
    .filter((p) => p.t1 <= latest && latest - p.t1 < lookback && p.t1 > p.t0)
    .sort((a, b) => b.t1 - a.t1)
    .slice(0, 3);
  if (!recent.length) return null;

  const { step, cols, rows } = recent[0].field;
  const u = new Float32Array(cols * rows);
  const v = new Float32Array(cols * rows);
  let total = 0;
  recent.forEach((p, i) => {
    const w = 3 - i;
    const scale = (w * FORECAST_REF_SECONDS) / (p.t1 - p.t0);
    for (let k = 0; k < u.length; k++) {
      u[k] += p.field.u[k] * scale;
      v[k] += p.field.v[k] * scale;
    }
    total += w;
  });
  for (let k = 0; k < u.length; k++) {
    u[k] /= total;
    v[k] /= total;
  }
  return { step, cols, rows, u, v };
}
