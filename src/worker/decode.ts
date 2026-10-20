import * as hdf5 from 'jsfive';
import proj4 from 'proj4';

/** A source raster in its native projection (the Met Office composite is a 1 km transverse Mercator grid). */
export interface SourceGrid {
  projdef: string;
  /** Projected coordinates of the top-left corner of the top-left pixel. */
  x0: number;
  y0: number;
  xscale: number;
  yscale: number;
  cols: number;
  rows: number;
}

export interface DecodedFrame {
  /** Rain rate in mm/h; -1 = no data. Row-major, row 0 at the top. */
  values: Float32Array;
  grid: SourceGrid;
  /** Validity time, UTC epoch seconds. */
  time: number;
}

// HDF5 fixed-length strings come back NUL-padded.
const str = (v: unknown): string => String(v).replace(/\0+$/, '');
const num = (v: unknown): number => Number(v);

/** Decode an ODIM_H5 Cartesian composite (`/dataset1/data1`). */
export function decodeOdim(buffer: ArrayBuffer): DecodedFrame {
  const file = new hdf5.File(buffer);
  const where = file.get('where').attrs;
  const what = file.get('what').attrs;
  const dataWhat = file.get('dataset1/data1/what').attrs;
  const ds = file.get('dataset1/data1/data');

  const projdef = str(where.projdef);
  const cols = num(where.xsize);
  const rows = num(where.ysize);
  const [ulx, uly] = proj4('EPSG:4326', projdef, [num(where.UL_lon), num(where.UL_lat)]);

  const gain = num(dataWhat.gain);
  const offset = num(dataWhat.offset);
  const nodata = num(dataWhat.nodata);
  const undetect = num(dataWhat.undetect);

  // jsfive returns a plain Array; convert to compact floats with the sentinels normalised.
  const raw = ds.value;
  const values = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    values[i] = v === nodata ? -1 : v === undetect ? 0 : v * gain + offset;
  }

  const date = str(what.date);
  const time = str(what.time);
  const epoch =
    Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6)) / 1000;

  return {
    values,
    time: epoch,
    grid: {
      projdef,
      x0: Math.round(ulx),
      y0: Math.round(uly),
      xscale: num(where.xscale),
      yscale: num(where.yscale),
      cols,
      rows,
    },
  };
}
