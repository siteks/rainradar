/// <reference lib="webworker" />
import { GRID_VERSION } from '../radar/grid';
import type { FrameRef } from '../sources/metoffice';
import { decodeOdim } from './decode';
import type { FromWorker, ToWorker } from './protocol';
import { buildLookup, resample, sourceGridKey } from './reproject';

declare const self: DedicatedWorkerGlobalScope;

// Decoded display-grid frames are cached so a cold start doesn't re-decode HDF5.
const GRID_CACHE = `radar-grids-${GRID_VERSION}`;
const GRID_CACHE_MAX_AGE = 6 * 3600;

let lookup: { key: string; lut: Int32Array } | null = null;
let queue: FrameRef[] = [];
let running = false;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, transfer);
const cacheKey = (time: number): string => `grid/${time}`;

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

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  const cache = await openCache();
  while (queue.length) {
    const ref = queue.shift()!;
    try {
      const data = await loadFrame(ref, cache);
      post({ type: 'frame', time: ref.time, data }, [data.buffer]);
    } catch (e) {
      post({ type: 'error', time: ref.time, message: e instanceof Error ? e.message : String(e) });
    }
  }
  running = false;
  post({ type: 'idle' });
  await pruneCache(cache);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    queue = [...msg.frames].sort((a, b) => b.time - a.time);
    void drain();
  }
};
