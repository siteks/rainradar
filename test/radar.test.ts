import { describe, expect, it } from 'vitest';
import { GRID, gridCorners, lonFromX, latFromY, mercX, mercY } from '../src/radar/grid';
import { DRY, NODATA, PALETTE, dequantise, quantise } from '../src/radar/palette';
import { buildLookup } from '../src/worker/reproject';
import type { SourceGrid } from '../src/worker/decode';

// Grid metadata as read from a real composite on 2026-10-20.
const METOFFICE: SourceGrid = {
  projdef: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.999601 +x_0=400000 +y_0=-100000 +ellps=airy +units=m',
  x0: -405000,
  y0: 1550000,
  xscale: 1000,
  yscale: 1000,
  cols: 1725,
  rows: 2175,
};

describe('quantisation', () => {
  it('keeps sentinels and round-trips rain rates within a few percent', () => {
    expect(quantise(-1)).toBe(NODATA);
    expect(quantise(NaN)).toBe(NODATA);
    expect(quantise(0)).toBe(DRY);
    for (const r of [0.1, 0.7, 3, 12, 60]) expect(dequantise(quantise(r)) / r).toBeCloseTo(1, 1);
    expect(quantise(10_000)).toBe(255);
  });

  it('draws dry pixels transparent and heavy rain opaque', () => {
    expect(PALETTE[DRY] >>> 24).toBe(0);
    expect(PALETTE[quantise(0.01)] >>> 24).toBe(0);
    expect(PALETTE[quantise(20)] >>> 24).toBeGreaterThan(200);
  });
});

describe('display grid', () => {
  it('mercator helpers invert each other', () => {
    expect(lonFromX(mercX(-3.2))).toBeCloseTo(-3.2, 9);
    expect(latFromY(mercY(55.9))).toBeCloseTo(55.9, 9);
  });

  it('covers the UK radar area', () => {
    const [[w, n], , [e, s]] = gridCorners();
    expect(w).toBeLessThan(-10.5);
    expect(e).toBeGreaterThan(4.3);
    expect(s).toBeLessThan(46.9);
    expect(n).toBeGreaterThan(60.5);
  });
});

describe('reprojection lookup', () => {
  const lut = buildLookup(METOFFICE);
  const pixelAt = (lon: number, lat: number): number =>
    Math.floor((GRID.y0 - mercY(lat)) / GRID.res) * GRID.width + Math.floor((mercX(lon) - GRID.x0) / GRID.res);

  it('maps London to the same source pixel proj4 gives directly', () => {
    // Computed independently with proj4 against the real file: London → col 935, row 1370.
    const j = lut[pixelAt(-0.1276, 51.5072)];
    expect(Math.abs((j % METOFFICE.cols) - 935)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.floor(j / METOFFICE.cols) - 1370)).toBeLessThanOrEqual(1);
  });

  it('marks pixels outside the source grid', () => {
    expect(lut.length).toBe(GRID.width * GRID.height);
    expect(lut.every((j) => j >= -1 && j < METOFFICE.cols * METOFFICE.rows)).toBe(true);
  });
});
