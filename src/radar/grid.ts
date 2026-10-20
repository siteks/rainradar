// The display raster: a Web Mercator grid covering the UK radar composite's coverage.
// Every frame (observed, interpolated or forecast) lives on this grid, so the map overlay
// is a plain rectangle in map space and frames can be compared pixel-for-pixel.

const R = 6378137;
const DEG = Math.PI / 180;

export const mercX = (lon: number): number => R * lon * DEG;
export const mercY = (lat: number): number => R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
export const lonFromX = (x: number): number => x / R / DEG;
export const latFromY = (y: number): number => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG;

export interface MercatorGrid {
  /** Top-left corner in EPSG:3857 metres. */
  x0: number;
  y0: number;
  /** Pixel size in EPSG:3857 metres (≈1 km on the ground at UK latitudes). */
  res: number;
  width: number;
  height: number;
}

function makeGrid(west: number, east: number, south: number, north: number, res: number): MercatorGrid {
  const x0 = mercX(west);
  const y0 = mercY(north);
  return {
    x0,
    y0,
    res,
    width: Math.ceil((mercX(east) - x0) / res),
    height: Math.ceil((y0 - mercY(south)) / res),
  };
}

// Radar coverage measured from a real composite was lon -10.5..4.3, lat 46.9..60.5.
export const GRID: MercatorGrid = makeGrid(-11, 4.5, 46.5, 61, 1500);

/** Bump when GRID or the quantisation changes, to invalidate cached frame grids. */
export const GRID_VERSION = 'g1';

/** Corner coordinates in MapLibre's order: top-left, top-right, bottom-right, bottom-left. */
export function gridCorners(g: MercatorGrid = GRID): [[number, number], [number, number], [number, number], [number, number]] {
  const west = lonFromX(g.x0);
  const east = lonFromX(g.x0 + g.width * g.res);
  const north = latFromY(g.y0);
  const south = latFromY(g.y0 - g.height * g.res);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}
