/// <reference lib="webworker" />
import { GRID, GRID_VERSION } from '../radar/grid';
import type { FrameRef } from '../sources/metoffice';
import { decodeOdim } from './decode';
import { estimateMotion } from './motion';
import type { FromWorker, ToWorker } from './protocol';
import { buildLookup, resample, sourceGridKey } from './reproject';

declare const self: DedicatedWorkerGlobalScope;

// Decoded display-grid frames are cached so a cold start doesn't re-decode HDF5.
const GRID_CACHE = `radar-grids-${GRID_VERSION}`;
const GRID_CACHE_MAX_AGE = 6 * 3600;
const MAX_GAP_SECONDS = 1800; // estimate motion across at most one missing 15-min frame

let lookup: { key: string; lut: Int32Array } | null = null;
let refs: FrameRef[] = [];
/** The worker's own copies of observed frames, needed for interpolation. */
const observed = new Map<number, Uint8Array>();
/** Pairs ("t0-t1") whose motion has been sent. */
const estimated = new Set<string>();
let running = false;
let rerun = false;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, transfer);
const cacheKey = (time: number): string => `grid/${time}`;
const yieldToEvents = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(GRID_CACHE);
  } catch {
    return null; // e.g. storage blocked
  }
}

async function loadFrame(ref: FrameRef, cache: Cache | null): Promise<Uint8Array> {
  const hit = await cache?.match(cacheKey(ref.time));
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(ref.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const frame = decodeOdim(await res.arrayBuffer());

  const key = sourceGridKey(frame.grid);
  if (lookup?.key !== key) lookup = { key, lut: buildLookup(frame.grid) };
  const data = resample(frame.values, lookup.lut);

  await cache?.put(cacheKey(ref.time), new Response(data.slice().buffer)).catch(() => {});
  return data;
}

async function pruneCache(cache: Cache | null): Promise<void> {
  if (!cache) return;
  const cutoff = Date.now() / 1000 - GRID_CACHE_MAX_AGE;
  for (const req of await cache.keys()) {
    const time = Number(req.url.split('/').pop());
    if (!(time >= cutoff)) await cache.delete(req);
  }
}

async function loadObserved(cache: Cache | null): Promise<void> {
  for (const ref of [...refs].sort((a, b) => b.time - a.time)) {
    if (observed.has(ref.time)) continue;
    try {
      const data = await loadFrame(ref, cache);
      observed.set(ref.time, data);
      const copy = data.slice();
      post({ type: 'frame', time: ref.time, data: copy }, [copy.buffer]);
    } catch (e) {
      post({ type: 'error', time: ref.time, message: e instanceof Error ? e.message : String(e) });
    }
    if (rerun) return; // the window changed; start again
  }
  post({ type: 'idle' });
}

/** Motion between consecutive observed frames, newest pair first. */
async function estimate(): Promise<void> {
  const times = [...observed.keys()].sort((a, b) => b - a);
  for (let i = 0; i + 1 < times.length; i++) {
    const t1 = times[i];
    const t0 = times[i + 1];
    const gap = t1 - t0;
    const key = `${t0}-${t1}`;
    if (gap > MAX_GAP_SECONDS || estimated.has(key)) continue;

    const field = estimateMotion(observed.get(t0)!, observed.get(t1)!, GRID);
    post({ type: 'motion', t0, t1, field }, [field.u.buffer, field.v.buffer]);
    estimated.add(key);
    await yieldToEvents();
    if (rerun) return;
  }
}

async function drain(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  const cache = await openCache();
  do {
    rerun = false;
    await loadObserved(cache);
    if (!rerun) await estimate();
  } while (rerun);
  running = false;
  await pruneCache(cache);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    refs = msg.frames;
    const wanted = new Set(refs.map((r) => r.time));
    for (const t of observed.keys()) if (!wanted.has(t)) observed.delete(t);
    for (const key of estimated) {
      const [t0, t1] = key.split('-').map(Number);
      if (!observed.has(t0) || !observed.has(t1)) estimated.delete(key);
    }
    void drain();
  }
};
