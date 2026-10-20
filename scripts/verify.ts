// Replays past radar and scores forecast methods against what actually fell.
//
// At each issue time T, every method forecasts from radar up to T exactly as the app would, and the
// forecasts at T + lead are compared with the observed frame at that time:
//   persistence   — frame T unchanged (the do-nothing baseline)
//   straight line — one motion vector for the whole map (the old RainToday approach)
//   flow field    — the app's forecast: dense motion, averaged over the last 3 intervals, frozen,
//                   with semi-Lagrangian steps (CPU copy of the shader)
// Scores are accumulated over all cases: CSI and frequency bias at rain thresholds, and the
// fractions skill score (FSS) at neighbourhood sizes. Radar frames come from the Met Office AWS
// archive (2 years) and are cached under data/verify-cache.
//
// Run: npm run verify -- --from 2026-10-14 --to 2026-10-19 [--every 60] [--leads 15,30,45,60,90,120]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extrapolate, uniformField } from '../src/radar/extrapolate';
import { forecastField } from '../src/radar/forecast';
import { GRID, GRID_VERSION } from '../src/radar/grid';
import { pairKey } from '../src/radar/timeline';
import { BUCKET } from '../src/sources/metoffice';
import { Contingency, FractionsSkill } from '../src/verify/metrics';
import { decodeOdim } from '../src/worker/decode';
import { estimateMotion, type MotionField } from '../src/worker/motion';
import { buildLookup, resample, sourceGridKey } from '../src/worker/reproject';

const FRAME_SECONDS = 900;
const THRESHOLDS = [0.5, 2]; // mm/h
const FSS_WINDOWS = [{ px: 11, label: '15km' }, { px: 31, label: '45km' }]; // 1.5 km pixels
const METHODS = ['persistence', 'straight line', 'flow field'] as const;
type Method = (typeof METHODS)[number];

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const from = Date.parse(`${arg('--from', '')}T00:00:00Z`) / 1000;
const to = Date.parse(`${arg('--to', '')}T23:59:59Z`) / 1000;
if (!(from <= to)) throw new Error('Give --from and --to as YYYY-MM-DD');
const every = Number(arg('--every', '60')) * 60;
const leads = arg('--leads', '15,30,45,60,90,120').split(',').map((m) => Number(m) * 60);
const cacheDir = join('data', `verify-cache-${GRID_VERSION}`);
mkdirSync(cacheDir, { recursive: true });

// ---- radar frames (display grid bytes), cached on disk ------------------------------------------
const pad = (n: number): string => String(n).padStart(2, '0');
function frameUrl(t: number): string {
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear();
  const stamp = `${y}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${BUCKET}/radar/${y}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${stamp}_ODIM_ng_radar_rainrate_composite_1km_UK.h5`;
}

let lookup: { key: string; lut: Int32Array } | null = null;
const frames = new Map<number, Uint8Array | null>();

async function loadFrame(t: number): Promise<Uint8Array | null> {
  if (frames.has(t)) return frames.get(t)!;
  const path = join(cacheDir, `${t}.u8.gz`);
  let data: Uint8Array | null = null;
  if (existsSync(path)) data = new Uint8Array(gunzipSync(readFileSync(path)));
  else {
    for (let attempt = 1; attempt <= 3 && data === null; attempt++) {
      try {
        const res = await fetch(frameUrl(t));
        if (res.status === 404 || res.status === 403) break; // frame missing from the archive
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const decoded = decodeOdim(await res.arrayBuffer());
        const key = sourceGridKey(decoded.grid);
        if (lookup?.key !== key) lookup = { key, lut: buildLookup(decoded.grid) };
        data = resample(decoded.values, lookup.lut);
        writeFileSync(path, gzipSync(data));
      } catch (e) {
        if (attempt === 3) console.warn(`  frame ${new Date(t * 1000).toISOString()}: ${(e as Error).message}`);
      }
    }
  }
  frames.set(t, data);
  return data;
}

// ---- motion fields per consecutive pair, cached in memory ---------------------------------------
const fields = new Map<string, MotionField>();
async function pairField(t0: number, t1: number): Promise<MotionField | null> {
  const key = pairKey(t0, t1);
  if (fields.has(key)) return fields.get(key)!;
  const [a, b] = [await loadFrame(t0), await loadFrame(t1)];
  if (!a || !b) return null;
  const f = estimateMotion(a, b, GRID);
  fields.set(key, f);
  return f;
}

// ---- scores --------------------------------------------------------------------------------------
interface Scores {
  csi: Contingency[];
  fss: FractionsSkill[];
}
const scores = new Map<string, Scores>(); // `${method}|${lead}`
const scoresFor = (method: Method, lead: number): Scores => {
  const key = `${method}|${lead}`;
  let s = scores.get(key);
  if (!s) {
    s = {
      csi: THRESHOLDS.map((t) => new Contingency(t)),
      fss: FSS_WINDOWS.map((w) => new FractionsSkill(THRESHOLDS[0], w.px, GRID)),
    };
    scores.set(key, s);
  }
  return s;
};

// ---- replay ---------------------------------------------------------------------------------------
const issueTimes: number[] = [];
for (let t = Math.ceil(from / every) * every; t <= to; t += every) issueTimes.push(t);
console.log(`${issueTimes.length} issue times, leads ${leads.map((l) => l / 60).join('/')} min`);

let used = 0;
const started = performance.now();
for (const [n, t] of issueTimes.entries()) {
  const latest = await loadFrame(t);
  if (!latest) continue;
  const pairs = new Map<string, MotionField>();
  for (let k = 0; k < 3; k++) {
    const t1 = t - k * FRAME_SECONDS;
    const f = await pairField(t1 - FRAME_SECONDS, t1);
    if (f) pairs.set(pairKey(t1 - FRAME_SECONDS, t1), f);
  }
  const field = forecastField(pairs, t);
  if (!field) continue;

  const forecasts: Record<Method, Map<number, Uint8Array>> = {
    persistence: new Map(leads.map((l) => [l, latest])),
    'straight line': extrapolate(latest, uniformField(field), leads, GRID),
    'flow field': extrapolate(latest, field, leads, GRID),
  };
  for (const lead of leads) {
    const observed = await loadFrame(t + lead);
    if (!observed) continue;
    for (const method of METHODS) {
      const s = scoresFor(method, lead);
      const fc = forecasts[method].get(lead)!;
      for (const c of s.csi) c.add(fc, observed);
      for (const f of s.fss) f.add(fc, observed);
    }
  }
  used++;
  // Keep memory bounded: frames older than the earliest still-needed input can go.
  for (const ft of frames.keys()) if (ft < t - 4 * FRAME_SECONDS) frames.delete(ft);
  for (const k of fields.keys()) if (Number(k.split('-')[1]) < t - 3 * FRAME_SECONDS) fields.delete(k);
  const elapsed = (performance.now() - started) / 1000;
  process.stdout.write(`\r  ${n + 1}/${issueTimes.length} ${new Date(t * 1000).toISOString().slice(0, 16)}  ${elapsed.toFixed(0)} s   `);
}
console.log(`\n${used} cases scored\n`);

// ---- report ---------------------------------------------------------------------------------------
const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '  – ');
function table(title: string, value: (s: Scores) => number, note = ''): void {
  console.log(`${title}${note ? `  (${note})` : ''}`);
  console.log(`  lead    ${METHODS.map((m) => m.padStart(14)).join('')}`);
  for (const lead of leads) {
    const row = METHODS.map((m) => fmt(value(scoresFor(m, lead))).padStart(14)).join('');
    console.log(`  ${String(lead / 60).padStart(3)} min${row}`);
  }
  console.log();
}
THRESHOLDS.forEach((t, i) => table(`CSI ≥ ${t} mm/h`, (s) => s.csi[i].csi(), '1 = perfect'));
THRESHOLDS.forEach((t, i) => table(`Frequency bias ≥ ${t} mm/h`, (s) => s.csi[i].bias(), '1 = right rain area'));
FSS_WINDOWS.forEach((w, i) => {
  const useful = scoresFor('persistence', leads[0]).fss[i].useful();
  table(`FSS ≥ ${THRESHOLDS[0]} mm/h at ${w.label}`, (s) => s.fss[i].fss(), `useful above ≈ ${useful.toFixed(2)}`);
});

const results = {
  from: new Date(from * 1000).toISOString(),
  to: new Date(to * 1000).toISOString(),
  every,
  cases: used,
  leads,
  methods: METHODS.map((m) => ({
    method: m,
    byLead: leads.map((lead) => {
      const s = scoresFor(m, lead);
      return {
        lead,
        csi: Object.fromEntries(THRESHOLDS.map((t, i) => [t, s.csi[i].csi()])),
        bias: Object.fromEntries(THRESHOLDS.map((t, i) => [t, s.csi[i].bias()])),
        fss: Object.fromEntries(FSS_WINDOWS.map((w, i) => [w.label, s.fss[i].fss()])),
      };
    }),
  })),
};
mkdirSync(join('data', 'verify'), { recursive: true });
const out = join('data', 'verify', `${arg('--from', '')}_${arg('--to', '')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`results written to ${out}`);
