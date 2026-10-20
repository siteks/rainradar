import { RadarMap } from './map/map';
import { listRecentFrames, type FrameRef } from './sources/metoffice';
import { Controls } from './ui/controls';
import { formatClock } from './ui/time';
import type { FrameKind, FromWorker, ToWorker } from './worker/protocol';
import RadarWorker from './worker/radar.worker?worker';

const SLOT_SECONDS = 300;
// The slider spans now ± 2 h with "now" in the middle; the future half fills in once forecasts exist.
const PAST_SECONDS = 2 * 3600;
const FUTURE_SECONDS = 2 * 3600;
const REFRESH_MS = 5 * 60 * 1000;
const STALE_SECONDS = 40 * 60;

interface Frame {
  kind: FrameKind;
  data: Uint8Array;
}

export interface Timeline {
  /** Slot times (UTC epoch seconds), every SLOT_SECONDS. */
  times: number[];
  /** Index range of slots that have frames (inclusive), or null if none. */
  available: [number, number] | null;
  /** Fractional slot index of the current wall-clock time. */
  now: number;
}

export class App {
  private readonly map: RadarMap;
  private readonly controls: Controls;
  private readonly worker: Worker;
  private readonly frames = new Map<number, Frame>();
  private refs: FrameRef[] = [];
  private timeline: Timeline = { times: [], available: null, now: 0 };
  private selected: number | null = null; // selected frame time
  private followLatest = true;
  private loading = true;
  private lastRefresh = 0;
  private offline = false;

  constructor(root: HTMLElement) {
    const mapEl = document.createElement('div');
    mapEl.className = 'map';
    root.appendChild(mapEl);
    this.map = new RadarMap(mapEl);
    this.controls = new Controls(root, { onSeek: (i) => this.seekSlot(i) });

    this.worker = new RadarWorker();
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastRefresh > REFRESH_MS / 2) void this.refresh();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, REFRESH_MS);
    // Keep "now" and the relative labels moving between refreshes.
    setInterval(() => this.rebuild(), 60 * 1000);
    window.addEventListener('keydown', (e) => this.onKey(e));

    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    try {
      // One extra frame before the window so the earliest 5-min slots can be interpolated.
      this.refs = await listRecentFrames(new Date(), PAST_SECONDS + 900);
      this.offline = false;
    } catch {
      this.offline = true;
      this.updateStatus();
      return;
    }
    this.loading = this.refs.some((r) => this.frames.get(r.time)?.kind !== 'observed');
    this.worker.postMessage({ type: 'load', frames: this.refs } satisfies ToWorker);
    this.rebuild();
  }

  private onWorker(msg: FromWorker): void {
    switch (msg.type) {
      case 'frame':
        // Never let an in-between frame replace a real observation.
        if (msg.kind !== 'observed' && this.frames.get(msg.time)?.kind === 'observed') return;
        this.frames.set(msg.time, { kind: msg.kind, data: msg.data });
        this.rebuild();
        break;
      case 'error':
        console.warn('[radar] frame failed', msg.time, msg.message);
        break;
      case 'idle':
        this.loading = false;
        this.updateStatus();
        break;
    }
  }

  /** Recompute the timeline (it moves with the clock) and keep the selection where it was. */
  private rebuild(): void {
    const now = Date.now() / 1000;
    const start = Math.floor((now - PAST_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
    const count = Math.round((PAST_SECONDS + FUTURE_SECONDS) / SLOT_SECONDS) + 1;
    const times = Array.from({ length: count }, (_, i) => start + i * SLOT_SECONDS);

    for (const t of this.frames.keys()) if (t < start) this.frames.delete(t);
    const have = times.map((t, i) => (this.frames.has(t) ? i : -1)).filter((i) => i >= 0);
    this.timeline = {
      times,
      available: have.length ? [have[0], have[have.length - 1]] : null,
      now: (now - start) / SLOT_SECONDS,
    };

    if (this.followLatest || this.selected === null || !this.frames.has(this.selected)) this.selected = this.latestTime();
    this.controls.setTimeline(this.timeline, this.slotOf(this.selected));
    this.show();
    this.updateStatus();
  }

  private latestTime(): number | null {
    const a = this.timeline.available;
    return a ? this.timeline.times[a[1]] : null;
  }

  private slotOf(time: number | null): number {
    if (time === null) return Math.floor(this.timeline.now);
    return Math.round((time - this.timeline.times[0]) / SLOT_SECONDS);
  }

  /** Slider moved: snap to the nearest slot that has a frame (the future clamps to the latest). */
  private seekSlot(index: number): void {
    const { times, available } = this.timeline;
    if (!available) return;
    let i = Math.min(Math.max(index, available[0]), available[1]);
    for (let d = 0; d < times.length; d++) {
      if (this.frames.has(times[i - d])) {
        i -= d;
        break;
      }
      if (this.frames.has(times[i + d])) {
        i += d;
        break;
      }
    }
    this.selected = times[i];
    this.followLatest = this.selected === this.latestTime();
    this.controls.setIndex(i);
    this.show();
  }

  private show(): void {
    void this.map.show(this.selected === null ? null : (this.frames.get(this.selected)?.data ?? null));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return; // the slider handles its own arrow keys
    const i = this.slotOf(this.selected);
    if (e.key === 'ArrowLeft') this.seekSlot(i - 1);
    else if (e.key === 'ArrowRight') this.seekSlot(i + 1);
  }

  private updateStatus(): void {
    const newest = this.latestObserved();
    const age = newest === undefined ? Infinity : Date.now() / 1000 - newest;

    if (this.offline && newest === undefined) this.controls.setBanner("Can't reach the Met Office radar feed");
    else if (this.offline) this.controls.setBanner(`Offline — showing radar from ${formatClock(newest!)}`);
    else if (age > STALE_SECONDS) this.controls.setBanner(`Latest radar is ${Math.round(age / 60)} min old`);
    else this.controls.setBanner(null);

    // Only say something while loading; the slider already shows the latest time.
    const inWindow = this.refs.filter((r) => r.time >= (this.timeline.times[0] ?? 0));
    const got = inWindow.filter((r) => this.frames.get(r.time)?.kind === 'observed').length;
    if (this.loading && inWindow.length) this.controls.setStatus(`Loading ${got}/${inWindow.length}`);
    else this.controls.setStatus(newest === undefined && !this.offline ? 'Loading…' : '');
  }

  private latestObserved(): number | undefined {
    let best: number | undefined;
    for (const [t, f] of this.frames) if (f.kind === 'observed' && (best === undefined || t > best)) best = t;
    return best;
  }
}
