import proj4 from 'proj4';
import { GRID, latFromY, lonFromX, type MercatorGrid } from '../radar/grid';
import { NODATA, quantise } from '../radar/palette';
import type { SourceGrid } from './decode';

const KNOT_STEP = 8;

/**
 * For every display-grid pixel, the index of the nearest source pixel (or -1 if outside).
 * proj4 runs only on a coarse lattice of knots; pixels in between are interpolated bilinearly,
 * which is far below a pixel of error at this scale.
 */
export function buildLookup(src: SourceGrid, grid: MercatorGrid = GRID): Int32Array {
  const fwd = proj4('EPSG:4326', src.projdef);
  const kw = Math.ceil(grid.width / KNOT_STEP) + 1;
  const kh = Math.ceil(grid.height / KNOT_STEP) + 1;
  const kc = new Float64Array(kw * kh);
  const kr = new Float64Array(kw * kh);

  for (let j = 0; j < kh; j++) {
    const lat = latFromY(grid.y0 - (j * KNOT_STEP + 0.5) * grid.res);
    for (let i = 0; i < kw; i++) {
      const lon = lonFromX(grid.x0 + (i * KNOT_STEP + 0.5) * grid.res);
      const [sx, sy] = fwd.forward([lon, lat]);
      kc[j * kw + i] = (sx - src.x0) / src.xscale;
      kr[j * kw + i] = (src.y0 - sy) / src.yscale;
    }
  }

  const lut = new Int32Array(grid.width * grid.height);
  for (let y = 0; y < grid.height; y++) {
    const j = Math.floor(y / KNOT_STEP);
    const ty = (y - j * KNOT_STEP) / KNOT_STEP;
    for (let x = 0; x < grid.width; x++) {
      const i = Math.floor(x / KNOT_STEP);
      const tx = (x - i * KNOT_STEP) / KNOT_STEP;
      const a = j * kw + i;
      const b = a + kw;
      const col = (kc[a] * (1 - tx) + kc[a + 1] * tx) * (1 - ty) + (kc[b] * (1 - tx) + kc[b + 1] * tx) * ty;
      const row = (kr[a] * (1 - tx) + kr[a + 1] * tx) * (1 - ty) + (kr[b] * (1 - tx) + kr[b + 1] * tx) * ty;
      const c = Math.floor(col);
      const r = Math.floor(row);
      lut[y * grid.width + x] = c >= 0 && c < src.cols && r >= 0 && r < src.rows ? r * src.cols + c : -1;
    }
  }
  return lut;
}

/** Resample source rain rates onto the display grid as quantised bytes. */
export function resample(values: Float32Array, lut: Int32Array): Uint8Array {
  const out = new Uint8Array(lut.length);
  for (let i = 0; i < lut.length; i++) {
    const j = lut[i];
    out[i] = j < 0 ? NODATA : quantise(values[j]);
  }
  return out;
}

export function sourceGridKey(g: SourceGrid): string {
  return [g.projdef, g.x0, g.y0, g.xscale, g.yscale, g.cols, g.rows].join('|');
}
