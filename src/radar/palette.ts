// Rain rates are stored as one byte per pixel on a log scale:
//   0 = no data (outside radar coverage), 1 = dry, 2..255 = rain.
// The same encoding is used for observed, interpolated and forecast frames.

export const NODATA = 0;
export const DRY = 1;

const MIN_RATE = 0.05; // mm/h, encoded as 2
const STEPS_PER_DOUBLING = 20; // 255 ≈ 320 mm/h

export function quantise(rate: number): number {
  if (!(rate >= 0)) return NODATA; // negative sentinel or NaN
  if (rate < MIN_RATE) return DRY;
  return Math.min(255, 2 + Math.round(STEPS_PER_DOUBLING * Math.log2(rate / MIN_RATE)));
}

export function dequantise(q: number): number {
  if (q < 2) return 0;
  return MIN_RATE * 2 ** ((q - 2) / STEPS_PER_DOUBLING);
}

type RGBA = [number, number, number, number];

// Colour stops in mm/h. Below the first stop is transparent.
const STOPS: [number, RGBA][] = [
  [0.1, [150, 195, 255, 110]],
  [0.5, [80, 145, 250, 170]],
  [1, [35, 95, 235, 200]],
  [2, [20, 165, 70, 210]],
  [4, [250, 215, 30, 220]],
  [8, [250, 135, 20, 230]],
  [16, [225, 30, 30, 235]],
  [32, [195, 30, 200, 240]],
  [64, [255, 235, 255, 245]],
];
const NODATA_RGBA: RGBA = [120, 120, 120, 26];

function colourFor(rate: number): RGBA {
  if (rate < STOPS[0][0]) return [0, 0, 0, 0];
  for (let i = 1; i < STOPS.length; i++) {
    const [r1, c1] = STOPS[i];
    if (rate < r1) {
      const [r0, c0] = STOPS[i - 1];
      const t = Math.log(rate / r0) / Math.log(r1 / r0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * t)) as RGBA;
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const pack = ([r, g, b, a]: RGBA): number => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** 256-entry lookup from quantised value to a little-endian RGBA pixel (for a Uint32Array view of ImageData). */
export const PALETTE: Uint32Array = (() => {
  const lut = new Uint32Array(256);
  lut[NODATA] = pack(NODATA_RGBA);
  lut[DRY] = 0;
  for (let q = 2; q < 256; q++) lut[q] = pack(colourFor(dequantise(q)));
  return lut;
})();
