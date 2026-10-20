// CPU version of the radar shader's forecast mode (see radar-layer.ts), for verification: each pixel
// is traced back through a frozen motion field in 5-min semi-Lagrangian steps and the latest frame
// is sampled there (bilinear in log-rain space, ignoring no-data texels).

import { sampleField, type Dims, type MotionField } from '../worker/motion';
import { FORECAST_REF_SECONDS } from './forecast';
import { DRY, NODATA } from './palette';

export const STEP_SECONDS = 300;

/** Bilinear quantised value at a continuous grid position (pixel centres at +0.5), as in the shader. */
function sampleQ(frame: Uint8Array, dims: Dims, px: number, py: number): number {
  const fx = px - 0.5;
  const fy = py - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let q = 0;
  let w = 0;
  for (let k = 0; k < 4; k++) {
    const cx = x0 + (k & 1);
    const cy = y0 + (k >> 1);
    if (cx < 0 || cy < 0 || cx >= dims.width || cy >= dims.height) continue;
    const v = frame[cy * dims.width + cx];
    if (v === NODATA) continue;
    const wt = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
    q += v * wt;
    w += wt;
  }
  if (w < 0.5) return NODATA;
  const value = q / w;
  return value < 1.5 ? DRY : Math.min(255, Math.round(value));
}

/**
 * Forecasts of `frame` at each lead (seconds, multiples of STEP_SECONDS) along a frozen field holding
 * displacement per FORECAST_REF_SECONDS. With whole steps the per-step scale is constant, so one
 * backward trajectory per pixel serves every lead.
 */
export function extrapolate(frame: Uint8Array, field: MotionField, leads: number[], dims: Dims): Map<number, Uint8Array> {
  const scale = STEP_SECONDS / FORECAST_REF_SECONDS;
  const steps = new Map<number, Uint8Array>();
  for (const lead of leads) {
    if (lead % STEP_SECONDS !== 0 || lead <= 0) throw new Error(`lead ${lead} is not a positive multiple of ${STEP_SECONDS}`);
    steps.set(lead / STEP_SECONDS, new Uint8Array(dims.width * dims.height));
  }
  const maxSteps = Math.max(...steps.keys());
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      let px = x + 0.5;
      let py = y + 0.5;
      for (let k = 1; k <= maxSteps; k++) {
        const [u, v] = sampleField(field, px, py);
        px -= scale * u;
        py -= scale * v;
        const out = steps.get(k);
        if (out) out[y * dims.width + x] = sampleQ(frame, dims, px, py);
      }
    }
  }
  return new Map([...steps].map(([k, out]) => [k * STEP_SECONDS, out]));
}

/** The same field replaced by one vector everywhere (per-component median): the straight-line baseline. */
export function uniformField(field: MotionField): MotionField {
  const median = (a: Float32Array): number => {
    const s = Float32Array.from(a).sort();
    return s[s.length >> 1];
  };
  const u = new Float32Array(field.u.length).fill(median(field.u));
  const v = new Float32Array(field.v.length).fill(median(field.v));
  return { ...field, u, v };
}
