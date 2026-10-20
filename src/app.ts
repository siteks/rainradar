import { RadarMap } from './map/map';
import { listRecentFrames, type FrameRef } from './sources/metoffice';
import { Controls } from './ui/controls';
import { formatClock } from './ui/time';
import type { FromWorker, ToWorker } from './worker/protocol';
import RadarWorker from './worker/radar.worker?worker';

const HISTORY_SECONDS = 3 * 3600;
const REFRESH_MS = 5 * 60 * 1000;
const STALE_SECONDS = 40 * 60;

export class App {
  private readonly map: RadarMap;
  private readonly controls: Controls;
  private readonly worker: Worker;
  private readonly frames = new Map<number, Uint8Array>();
  private times: number[] = [];
  private index = 0;
  private followLatest = true;
  private pending = new Set<number>();
  private lastRefresh = 0;
  private offline = false;

  constructor(root: HTMLElement) {
    const mapEl = document.createElement('div');
    mapEl.className = 'map';
    root.appendChild(mapEl);
    this.map = new RadarMap(mapEl);
    this.controls = new Controls(root, { onSeek: (i) => this.seek(i) });

    this.worker = new RadarWorker();
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastRefresh > REFRESH_MS / 2) void this.refresh();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, REFRESH_MS);
    window.addEventListener('keydown', (e) => this.onKey(e));

    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    let refs: FrameRef[];
    try {
      refs = await listRecentFrames(new Date(), HISTORY_SECONDS);
      this.offline = false;
    } catch {
      this.offline = true;
      this.updateStatus();
      return;
    }

    // Drop frames that have aged out of the window.
    const keep = new Set(refs.map((r) => r.time));
    for (const t of this.frames.keys()) if (!keep.has(t)) this.frames.delete(t);

    const missing = refs.filter((r) => !this.frames.has(r.time));
    this.pending = new Set(missing.map((r) => r.time));
    if (missing.length) this.worker.postMessage({ type: 'load', frames: missing } satisfies ToWorker);
    this.rebuild();
  }

  private onWorker(msg: FromWorker): void {
    switch (msg.type) {
      case 'frame':
        this.pending.delete(msg.time);
        this.frames.set(msg.time, msg.data);
        this.rebuild();
        break;
      case 'error':
        console.warn('[radar] frame failed', msg.time, msg.message);
        this.pending.delete(msg.time);
        this.updateStatus();
        break;
      case 'idle':
        this.pending.clear();
        this.updateStatus();
        break;
    }
  }

  /** Recompute the slider after the set of loaded frames changes, keeping the selected time if possible. */
  private rebuild(): void {
    const current = this.times[this.index];
    this.times = [...this.frames.keys()].sort((a, b) => a - b);
    let index = this.times.length - 1;
    if (!this.followLatest && current !== undefined) {
      const i = this.times.indexOf(current);
      if (i >= 0) index = i;
    }
    this.controls.setFrames(this.times, Math.max(0, index));
    this.seek(Math.max(0, index));
    this.updateStatus();
  }

  private seek(index: number): void {
    this.index = index;
    this.followLatest = index === this.times.length - 1;
    this.controls.setIndex(index);
    void this.map.show(this.frames.get(this.times[index]) ?? null);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft' && this.index > 0) this.seek(this.index - 1);
    else if (e.key === 'ArrowRight' && this.index < this.times.length - 1) this.seek(this.index + 1);
  }

  private updateStatus(): void {
    const newest = this.times[this.times.length - 1];
    const age = newest === undefined ? Infinity : Date.now() / 1000 - newest;

    if (this.offline && newest === undefined) this.controls.setBanner("Can't reach the Met Office radar feed");
    else if (this.offline) this.controls.setBanner(`Offline — showing radar from ${formatClock(newest!)}`);
    else if (age > STALE_SECONDS) this.controls.setBanner(`Latest radar is ${Math.round(age / 60)} min old`);
    else this.controls.setBanner(null);

    // Only say something while loading; the slider already shows the latest time.
    if (this.pending.size) this.controls.setStatus(`Loading ${this.frames.size}/${this.frames.size + this.pending.size}`);
    else this.controls.setStatus(newest === undefined && !this.offline ? 'Loading…' : '');
  }
}
