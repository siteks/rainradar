// Archives a slice of the Met Office UKV model (via Open-Meteo's spatial open data) for verifying
// forecasts later. Open-Meteo keeps these files for only 7 days; the radar we verify against has a
// 2-year archive on AWS, so only the model needs saving.
//
// For each UTC day: runs at 00, 03, … 21Z; for each run the first 10 hourly valid times; per valid
// time: precipitation (lossless, uint16 tenths of mm over the preceding hour) and 700 hPa wind as
// u/v components (int8, 0.5 m/s, every 4th grid point ≈ 8 km). About 13 MB per day.
//
// Output: <out>/ukv-YYYY-MM-DD.bin.gz = gzip( uint32 LE header length | header JSON | payload ).
// The header describes the grid and lists every array with its byte offset into the payload.
// A day is written once complete (all 8 runs), or when it's about to expire from Open-Meteo.
//
// Usage: node scripts/archive-model.mjs --out DIR [--exclude-file names.txt] [--days 6]
//   --exclude-file: asset names already archived (one per line), e.g. from the GitHub release.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LruBlockCache, OmDataType, OmHttpBackend } from '@openmeteo/file-reader';

const MODEL = 'ukmo_uk_deterministic_2km';
const BASE = `https://openmeteo.s3.amazonaws.com/data_spatial/${MODEL}`;
const LIST = 'https://openmeteo.s3.amazonaws.com/?list-type=2&delimiter=/&prefix=';
const RUN_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const LEADS = 10; // valid times per run: lead 0..9 h
const WIND_STEP = 4;
const WIND_SCALE = 0.5; // m/s per int8 unit
const CONCURRENCY = 4;
// Without a block cache the reader issues one range request per 32×32 chunk (~30 s per file);
// 1 MB blocks bring that to ~3 s. Shared by all files (keys include the URL).
const cache = new LruBlockCache(1 << 20, 128);
const FINAL_AGE_DAYS = 5; // archive incomplete days from this age on (Open-Meteo deletes at 7)

// Grid of ukmo_uk_deterministic_2km as defined by Open-Meteo (weather-map-layer domain list).
// Rows run south → north (row 0 is the southern edge; checked with temperature_2m).
const GRID = {
  proj4: '+proj=laea +lat_0=54.9 +lon_0=-2.5 +x_0=0 +y_0=0 +R=6371229 +units=m +no_defs',
  cols: 1042,
  rows: 970,
  x0: -1158000, // projected x of the first grid point (column 0)
  y0: -1036000, // projected y of the first grid point (row 0, south)
  dx: 2000,
  dy: 2000,
  rowOrder: 'south-to-north',
};

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = arg('--out', 'data/model-archive');
const excludeFile = arg('--exclude-file', null);
const days = Number(arg('--days', '6'));
const exclude = new Set(excludeFile ? readFileSync(excludeFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dayPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const isoHour = (d) => `${ymd(d)}T${pad(d.getUTCHours())}:00Z`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry transient failures (S3 occasionally drops long-lived connections) with backoff. */
async function withRetry(label, fn, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries) throw e;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${label}: ${e.cause?.code ?? e.message}; retry ${attempt}/${tries - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function listPrefixes(prefix) {
  const res = await withRetry(`list ${prefix}`, () => fetch(LIST + encodeURIComponent(prefix)));
  if (!res.ok) throw new Error(`S3 list ${prefix}: ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix);
}

async function listKeys(prefix) {
  const res = await withRetry(`list ${prefix}`, () => fetch(LIST.replace('&delimiter=/', '') + encodeURIComponent(prefix)));
  if (!res.ok) throw new Error(`S3 list ${prefix}: ${res.status}`);
  return [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

/** Run reference times available for a day, restricted to RUN_HOURS, each with its valid-time keys. */
async function runsForDay(day) {
  const prefix = `data_spatial/${MODEL}/${dayPath(day)}/`;
  const runs = [];
  for (const p of await listPrefixes(prefix)) {
    const m = /\/(\d{2})00Z\/$/.exec(p);
    if (!m || !RUN_HOURS.includes(Number(m[1]))) continue;
    const ref = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1])));
    const keys = (await listKeys(p)).filter((k) => k.endsWith('.om')).sort().slice(0, LEADS);
    runs.push({ ref, keys });
  }
  return runs.sort((a, b) => a.ref - b.ref);
}

/** A whole field, or null if this valid time doesn't have it (e.g. precipitation at lead 0). */
async function readVar(root, name) {
  const r = await root.getChildByName(name);
  if (!r) return null;
  const dims = r.getDimensions();
  if (dims[0] !== GRID.rows || dims[1] !== GRID.cols) throw new Error(`${name}: unexpected dims ${dims}`);
  return r.read({ type: OmDataType.FloatArray, ranges: dims.map((d) => ({ start: 0, end: d })) });
}

/** One valid time: precipitation (uint16 tenths of mm) and 700 hPa wind u/v (int8, WIND_SCALE m/s). */
async function readValidTime(key) {
  const backend = new OmHttpBackend({ url: `https://openmeteo.s3.amazonaws.com/${key}`, retries: 3 });
  const [precip, speed, dir] = await backend.withReader(cache, async (root) => [
    await readVar(root, 'precipitation'),
    await readVar(root, 'wind_speed_700hPa'),
    await readVar(root, 'wind_direction_700hPa'),
  ]);
  const n = GRID.rows * GRID.cols;
  const p = precip
    ? Uint16Array.from(precip, (v) => (Number.isNaN(v) ? 65535 : Math.min(65534, Math.round(Math.max(0, v) * 10))))
    : new Uint16Array(n).fill(65535);
  const wr = Math.ceil(GRID.rows / WIND_STEP);
  const wc = Math.ceil(GRID.cols / WIND_STEP);
  const u = new Int8Array(wr * wc);
  const v = new Int8Array(wr * wc);
  const half = WIND_STEP >> 1;
  for (let y = 0; y < wr; y++) {
    for (let x = 0; x < wc; x++) {
      const k = Math.min(GRID.rows - 1, y * WIND_STEP + half) * GRID.cols + Math.min(GRID.cols - 1, x * WIND_STEP + half);
      const s = speed ? speed[k] : NaN;
      const d = dir ? (dir[k] * Math.PI) / 180 : NaN; // direction the wind blows FROM
      const clamp = (n) => (Number.isNaN(n) ? -128 : Math.max(-127, Math.min(127, Math.round(n / WIND_SCALE))));
      u[y * wc + x] = clamp(-s * Math.sin(d));
      v[y * wc + x] = clamp(-s * Math.cos(d));
    }
  }
  return { p, u, v, windRows: wr, windCols: wc };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function archiveDay(day, runs) {
  const chunks = [];
  let offset = 0;
  const add = (arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    chunks.push(bytes);
    const entry = { offset, length: bytes.length };
    offset += bytes.length;
    return entry;
  };
  const header = {
    format: 'rainradar-model-archive',
    version: 1,
    model: MODEL,
    source: 'Met Office UKV via Open-Meteo spatial open data. Met Office data © Crown copyright, CC BY-SA 4.0; Open-Meteo CC BY 4.0.',
    day: ymd(day),
    grid: GRID,
    precipitation: { type: 'uint16', scale: 0.1, units: 'mm (accumulated over the preceding hour)', missing: 65535 },
    wind700: { type: 'int8', scale: WIND_SCALE, units: 'm/s', components: 'u eastward, v northward', missing: -128, step: WIND_STEP, offset: WIND_STEP >> 1 },
    runs: [],
  };

  for (const run of runs) {
    const fields = await mapLimit(run.keys, CONCURRENCY, async (key) => {
      const m = /(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.om$/.exec(key);
      const data = await withRetry(key.split('/').pop(), () => readValidTime(key));
      return { valid_time: `${m[1]}T${m[2]}:${m[3]}Z`, data };
    });
    const entry = { reference_time: isoHour(run.ref), fields: [] };
    for (const f of fields) {
      header.windRows ??= f.data.windRows;
      header.windCols ??= f.data.windCols;
      entry.fields.push({ valid_time: f.valid_time, precipitation: add(f.data.p), wind_u_700hPa: add(f.data.u), wind_v_700hPa: add(f.data.v) });
    }
    header.runs.push(entry);
    console.log(`  ${entry.reference_time}: ${entry.fields.length} valid times`);
  }

  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return gzipSync(Buffer.concat([len, json, ...chunks]), { level: 9 });
}

mkdirSync(outDir, { recursive: true });
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
// Days are independent: one failing doesn't stop the others (it's retried on the next scheduled run).
let failures = 0;
for (let back = days; back >= 1; back--) {
  const day = new Date(today.getTime() - back * 86400_000);
  const name = `ukv-${ymd(day)}.bin.gz`;
  if (exclude.has(name)) continue;
  try {
    await archiveOne(day, name, back);
  } catch (e) {
    failures++;
    console.error(`${name}: FAILED (${e.cause?.code ?? e.message}); will retry next run`);
  }
}
if (failures) process.exit(1);

async function archiveOne(day, name, back) {
  const runs = await runsForDay(day);
  const complete = runs.length === RUN_HOURS.length && runs.every((r) => r.keys.length === LEADS);
  if (!complete && back < FINAL_AGE_DAYS) {
    console.log(`${name}: ${runs.length}/${RUN_HOURS.length} runs so far, waiting`);
    return;
  }
  if (!runs.length) {
    console.log(`${name}: no runs available`);
    return;
  }
  console.log(`${name}: archiving ${runs.length} runs${complete ? '' : ' (incomplete, expiring soon)'}`);
  const t = performance.now();
  const gz = await archiveDay(day, runs);
  writeFileSync(join(outDir, name), gz);
  console.log(`${name}: ${(gz.length / 1e6).toFixed(1)} MB in ${Math.round((performance.now() - t) / 1000)} s`);
}
