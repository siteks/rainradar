// Motion between two radar frames, and motion-compensated in-between frames.
//
// Motion is estimated by block matching on block-averaged copies of the frames: an exhaustive
// search on 12 km cells finds the rough displacement, local searches on 6 km and 3 km cells refine
// it, and a parabola through the final costs gives sub-cell precision. Vectors sit on a regular lattice of nodes and are
// cleaned with a median filter and confidence-weighted smoothing, which also fills dry areas.
//
// Frames are the display-grid bytes from palette.ts (0 = no data, 1 = dry, 2..255 = log rain rate),
// so matching and blending both work in log-rain space.

import { DRY, NODATA } from '../radar/palette';

export interface Dims {
  width: number;
  height: number;
}

export interface MotionField {
  /** Node spacing in display-grid pixels; node (i, j) sits at ((i + 0.5)·step, (j + 0.5)·step). */
  step: number;
  cols: number;
  rows: number;
  /** Displacement from frame A to frame B, in display-grid pixels: B(p + d) ≈ A(p). */
  u: Float32Array;
  v: Float32Array;
}

const STEP = 24; // ≈36 km between vectors
const BLOCK = 48; // ≈72 km matching window
const LEVELS = [8, 4, 2]; // grid px per cell, coarse to fine
const COARSE_RADIUS = 4; // cells at the coarsest level: ±32 px ≈ ±48 km per frame interval
const MIN_VALID = 0.5; // fraction of a block that must have data
const MIN_VARIANCE = 4; // block needs rain structure to be matched

/** Block-average a frame into cells of f×f pixels. Dry = 0, rain = q − 1; NaN where mostly no data. */
function downsample(q: Uint8Array, dims: Dims, f: number): { data: Float32Array; w: number; h: number } {
  const w = Math.ceil(dims.width / f);
  const h = Math.ceil(dims.height / f);
  const sum = new Float32Array(w * h);
  const n = new Uint16Array(w * h);
  const total = new Uint16Array(w * h);
  for (let y = 0; y < dims.height; y++) {
    const row = Math.floor(y / f) * w;
    for (let x = 0; x < dims.width; x++) {
      const c = row + Math.floor(x / f);
      const v = q[y * dims.width + x];
      total[c]++;
      if (v === NODATA) continue;
      sum[c] += v === DRY ? 0 : v - 1;
      n[c]++;
    }
  }
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = n[i] >= total[i] / 2 ? sum[i] / n[i] : NaN;
  return { data, w, h };
}

/** Mean squared difference between a block of A and the same block of B shifted by (dx, dy). */
function blockCost(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  half: number,
  dx: number,
  dy: number,
): number {
  let sum = 0;
  let n = 0;
  let total = 0;
  for (let y = cy - half; y < cy + half; y++) {
    if (y < 0 || y >= h) continue;
    const by = y + dy;
    for (let x = cx - half; x < cx + half; x++) {
      if (x < 0 || x >= w) continue;
      total++;
      const bx = x + dx;
      if (by < 0 || by >= h || bx < 0 || bx >= w) continue;
      const va = a[y * w + x];
      const vb = b[by * w + bx];
      if (va !== va || vb !== vb) continue; // NaN
      const d = va - vb;
      sum += d * d;
      n++;
    }
  }
  return n >= total * MIN_VALID && n > 0 ? sum / n : Infinity;
}

function blockVariance(a: Float32Array, w: number, h: number, cx: number, cy: number, half: number): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = Math.max(0, cy - half); y < Math.min(h, cy + half); y++) {
    for (let x = Math.max(0, cx - half); x < Math.min(w, cx + half); x++) {
      const v = a[y * w + x];
      if (v !== v) continue;
      s += v;
      s2 += v * v;
      n++;
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/** Sub-cell offset of a minimum from three costs at −1, 0, +1. */
function parabola(cm: number, c0: number, cp: number): number {
  const denom = cm - 2 * c0 + cp;
  if (!isFinite(denom) || denom <= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * denom)));
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  return s[s.length >> 1];
}

type Level = { data: Float32Array; w: number; h: number; f: number };

/**
 * Local search around (dx, dy) at one level: step to the best 3×3 neighbour until the centre is
 * best (at most a few steps), then fit a parabola. Returns the displacement in cells, or null.
 */
function refine(a: Level, b: Level, cx: number, cy: number, half: number, dx: number, dy: number, fit: boolean): [number, number] | null {
  const costs = new Float64Array(9);
  for (let iter = 0; iter < 4; iter++) {
    let best = Infinity;
    let bi = 4;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const c = blockCost(a.data, b.data, a.w, a.h, cx, cy, half, dx + ox, dy + oy);
        const idx = (oy + 1) * 3 + ox + 1;
        costs[idx] = c;
        if (c < best || (c === best && idx === 4)) {
          best = c;
          bi = idx;
        }
      }
    }
    if (!isFinite(best)) return null;
    if (bi === 4) break;
    dx += (bi % 3) - 1;
    dy += Math.floor(bi / 3) - 1;
  }
  if (!fit) return [dx, dy];
  return [dx + parabola(costs[3], costs[4], costs[5]), dy + parabola(costs[1], costs[4], costs[7])];
}

export function estimateMotion(a: Uint8Array, b: Uint8Array, dims: Dims): MotionField {
  const cols = Math.ceil(dims.width / STEP);
  const rows = Math.ceil(dims.height / STEP);
  const u = new Float32Array(cols * rows);
  const v = new Float32Array(cols * rows);
  const conf = new Float32Array(cols * rows);

  const pyramid = LEVELS.map((f) => ({ a: { ...downsample(a, dims, f), f }, b: { ...downsample(b, dims, f), f } }));
  const top = pyramid[0];
  const finest = pyramid[pyramid.length - 1];

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const px = (i + 0.5) * STEP;
      const py = (j + 0.5) * STEP;

      // Structure at the finest level decides whether this node is matchable at all.
      const fF = finest.a.f;
      const variance = blockVariance(finest.a.data, finest.a.w, finest.a.h, Math.floor(px / fF), Math.floor(py / fF), BLOCK / fF / 2);
      if (variance < MIN_VARIANCE) continue;

      // Exhaustive search at the coarsest level.
      const f0 = top.a.f;
      const cx = Math.floor(px / f0);
      const cy = Math.floor(py / f0);
      const half0 = BLOCK / f0 / 2;
      let best = Infinity;
      let dx = 0;
      let dy = 0;
      for (let oy = -COARSE_RADIUS; oy <= COARSE_RADIUS; oy++) {
        for (let ox = -COARSE_RADIUS; ox <= COARSE_RADIUS; ox++) {
          const c = blockCost(top.a.data, top.b.data, top.a.w, top.a.h, cx, cy, half0, ox, oy);
          if (c < best || (c === best && ox * ox + oy * oy < dx * dx + dy * dy)) {
            best = c;
            dx = ox;
            dy = oy;
          }
        }
      }
      if (!isFinite(best)) continue;

      // Refine level by level; the last level adds a sub-cell parabola.
      let disp: [number, number] | null = [dx, dy];
      for (let l = 1; l < pyramid.length && disp; l++) {
        const { a: la, b: lb } = pyramid[l];
        const scale = pyramid[l - 1].a.f / la.f;
        disp = refine(la, lb, Math.floor(px / la.f), Math.floor(py / la.f), BLOCK / la.f / 2,
          Math.round(disp[0] * scale), Math.round(disp[1] * scale), l === pyramid.length - 1);
      }
      if (!disp) continue;
      u[k] = disp[0] * finest.a.f;
      v[k] = disp[1] * finest.a.f;
      conf[k] = Math.min(1, variance / 100);
    }
  }

  return smoothField({ step: STEP, cols, rows, u, v }, conf);
}

/** Median-filter outliers, then fill and smooth with confidence-weighted 3×3 averaging. */
function smoothField(field: MotionField, conf: Float32Array): MotionField {
  const { cols, rows } = field;
  const u = new Float32Array(field.u);
  const v = new Float32Array(field.v);

  // 3×3 median over confident neighbours.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!conf[k]) continue;
      const us: number[] = [];
      const vs: number[] = [];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= cols || jj >= rows || !conf[jj * cols + ii]) continue;
          us.push(field.u[jj * cols + ii]);
          vs.push(field.v[jj * cols + ii]);
        }
      }
      if (us.length >= 3) {
        u[k] = median(us);
        v[k] = median(vs);
      }
    }
  }

  // Global fallback for areas with no rain anywhere nearby.
  const confident = [...conf.keys()].filter((k) => conf[k] > 0);
  const gu = confident.length ? median(confident.map((k) => u[k])) : 0;
  const gv = confident.length ? median(confident.map((k) => v[k])) : 0;

  // Normalised convolution: repeated 3×3 box passes over (w·u, w·v, w).
  let wu = Float32Array.from(u, (x, k) => x * conf[k]);
  let wv = Float32Array.from(v, (x, k) => x * conf[k]);
  let w = new Float32Array(conf);
  const PASSES = 4;
  for (let p = 0; p < PASSES; p++) {
    const nu = new Float32Array(wu.length);
    const nv = new Float32Array(wv.length);
    const nw = new Float32Array(w.length);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let su = 0;
        let sv = 0;
        let sw = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = Math.min(cols - 1, Math.max(0, i + di));
            const jj = Math.min(rows - 1, Math.max(0, j + dj));
            const kk = jj * cols + ii;
            su += wu[kk];
            sv += wv[kk];
            sw += w[kk];
          }
        }
        const k = j * cols + i;
        nu[k] = su / 9;
        nv[k] = sv / 9;
        nw[k] = sw / 9;
      }
    }
    wu = nu;
    wv = nv;
    w = nw;
  }

  // Blend towards the global vector where support is thin.
  const outU = new Float32Array(u.length);
  const outV = new Float32Array(v.length);
  const SUPPORT = 0.05;
  for (let k = 0; k < u.length; k++) {
    const t = Math.min(1, w[k] / SUPPORT);
    const lu = w[k] > 0 ? wu[k] / w[k] : gu;
    const lv = w[k] > 0 ? wv[k] / w[k] : gv;
    outU[k] = lu * t + gu * (1 - t);
    outV[k] = lv * t + gv * (1 - t);
  }
  return { ...field, u: outU, v: outV };
}

/** Displacement at a pixel, bilinearly interpolated between nodes. */
function sampleField(f: MotionField, x: number, y: number): [number, number] {
  const gx = Math.min(f.cols - 1, Math.max(0, x / f.step - 0.5));
  const gy = Math.min(f.rows - 1, Math.max(0, y / f.step - 0.5));
  const i = Math.min(f.cols - 2, Math.floor(gx));
  const j = Math.min(f.rows - 2, Math.floor(gy));
  const tx = gx - i;
  const ty = gy - j;
  const k = j * f.cols + i;
  const lerp = (a: Float32Array): number =>
    (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + f.cols] * (1 - tx) + a[k + f.cols + 1] * tx) * ty;
  return [lerp(f.u), lerp(f.v)];
}

/**
 * The frame a fraction `alpha` (0..1) of the way from A to B: each pixel samples A back along
 * the motion and B forward along it, and blends the two in log-rain space.
 */
export function morph(a: Uint8Array, b: Uint8Array, field: MotionField, alpha: number, dims: Dims): Uint8Array {
  const { width, height } = dims;
  const out = new Uint8Array(width * height);
  // Evaluate the field on a coarse lattice once per row block rather than per pixel.
  const ROW_STEP = 4;
  const du = new Float32Array(width);
  const dv = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    if (y % ROW_STEP === 0) {
      for (let x = 0; x < width; x++) {
        const [fu, fv] = sampleField(field, x, y + ROW_STEP / 2);
        du[x] = fu;
        dv[x] = fv;
      }
    }
    for (let x = 0; x < width; x++) {
      const ax = Math.round(x - alpha * du[x]);
      const ay = Math.round(y - alpha * dv[x]);
      const bx = Math.round(x + (1 - alpha) * du[x]);
      const by = Math.round(y + (1 - alpha) * dv[x]);
      const qa = ax >= 0 && ax < width && ay >= 0 && ay < height ? a[ay * width + ax] : NODATA;
      const qb = bx >= 0 && bx < width && by >= 0 && by < height ? b[by * width + bx] : NODATA;
      let q: number;
      if (qa === NODATA) q = qb;
      else if (qb === NODATA) q = qa;
      else q = Math.round(qa * (1 - alpha) + qb * alpha);
      out[y * width + x] = q === NODATA ? NODATA : Math.max(DRY, q);
    }
  }
  return out;
}
