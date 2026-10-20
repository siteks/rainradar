import { RadarMap } from './map/map';
import { forecastField } from './radar/forecast';
import { pairKey, pickFrames, pickTime, type FramePick } from './radar/timeline';
import { listRecentFrames, type FrameRef } from './sources/metoffice';
import { Controls } from './ui/controls';
import { formatClock } from './ui/time';
import type { MotionField } from './worker/motion';
import type { FromWorker, ToWorker } from './worker/protocol';
import RadarWorker from './worker/radar.worker?worker';

// The slider spans now ± 2 h in 1-min steps with "now" in the middle. In-between moments are drawn
// on the GPU from frames + motion fields; the future extrapolates the latest frame along a frozen
// average of recent motion (the radar-only forecast).
const SLOT_SECONDS = 60;
const PAST_SECONDS = 2 * 3600;
const FUTURE_SECONDS = 2 * 3600;
const REFRESH_MS = 5 * 60 * 1000;
const STALE_SECONDS = 40 * 60;

export interface Timeline {
  /** Slot times (UTC epoch seconds), every SLOT_SECONDS. */
  times: number[];
  /** Index range of slots that can be shown (inclusive), or null if none. */
  available: [number, number] | null;
  /** Slots after this index are forecast (the latest observed frame's slot), or null if none. */
  forecastFrom: number | null;
  /** Fractional slot index of the current wall-clock time. */
  now: number;
}

export class App {
  private readonly map: RadarMap;
  private readonly controls: Controls;
  private readonly worker: Worker;
  /** Observed frame times we hold (sorted), and motion for consecutive pairs ("t0-t1"). */
  private observed: number[] = [];
  private readonly fields = new Map<string, MotionField>();
  private hasForecast = false;
  private refs: FrameRef[] = [];
  private timeline: Timeline = { times: [], available: null, forecastFrom: null, now: 0 };
  private selected: number | null = null; // selected time, on a slot
  /** Keep the selection on "now" as the clock moves (until the user picks another time). */
  private followNow = true;
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
      // One extra frame before the window so the earliest minutes can be interpolated.
      this.refs = await listRecentFrames(new Date(), PAST_SECONDS + 900);
      this.offline = false;
    } catch {
      this.offline = true;
      this.updateStatus();
      return;
    }
    this.loading = this.refs.some((r) => !this.observed.includes(r.time));
    this.worker.postMessage({ type: 'load', frames: this.refs } satisfies ToWorker);
    this.prune();
    this.rebuild();
  }

  private onWorker(msg: FromWorker): void {
    switch (msg.type) {
      case 'frame':
        this.map.radar.setFrame(msg.time, msg.data);
        if (!this.observed.includes(msg.time)) this.observed = [...this.observed, msg.time].sort((a, b) => a - b);
        this.rebuild();
        break;
      case 'motion':
        this.map.radar.setField(msg.t0, msg.t1, msg.field);
        this.fields.set(pairKey(msg.t0, msg.t1), msg.field);
        this.updateForecast();
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

  /** Forget frames that are no longer listed (aged out), here and on the GPU. */
  private prune(): void {
    const listed = new Set(this.refs.map((r) => r.time));
    this.observed = this.observed.filter((t) => listed.has(t));
    for (const k of this.fields.keys()) {
      const [t0, t1] = k.split('-').map(Number);
      if (!listed.has(t0) || !listed.has(t1)) this.fields.delete(k);
    }
    this.map.radar.retain(new Set(this.observed), this.fields);
    this.updateForecast();
  }

  private updateForecast(): void {
    const latest = this.observed[this.observed.length - 1];
    const field = latest === undefined ? null : forecastField(this.fields, latest);
    this.map.radar.setForecastField(field);
    this.hasForecast = field !== null;
  }

  /** Recompute the timeline (it moves with the clock) and keep the selection where it was. */
  private rebuild(): void {
    const now = Date.now() / 1000;
    const start = Math.floor((now - PAST_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
    const count = Math.round((PAST_SECONDS + FUTURE_SECONDS) / SLOT_SECONDS) + 1;
    const times = Array.from({ length: count }, (_, i) => start + i * SLOT_SECONDS);
    const slot = (t: number): number => Math.round((t - start) / SLOT_SECONDS);

    const inWindow = this.observed.filter((t) => t >= start);
    const lastObserved = inWindow.length ? slot(inWindow[inWindow.length - 1]) : null;
    this.timeline = {
      times,
      available: inWindow.length ? [slot(inWindow[0]), this.hasForecast ? count - 1 : lastObserved!] : null,
      forecastFrom: this.hasForecast ? lastObserved : null,
      now: (now - start) / SLOT_SECONDS,
    };

    const nowSlot = Math.floor(now / SLOT_SECONDS) * SLOT_SECONDS;
    if (this.followNow || this.selected === null || this.selected < start) this.selected = nowSlot;
    this.controls.setTimeline(this.timeline, this.selected === null ? Math.floor(this.timeline.now) : slot(this.selected));
    this.show();
    this.updateStatus();
  }

  /** Slider moved: any minute between observed frames can be shown once its motion is ready. */
  private seekSlot(index: number): void {
    const { times, available } = this.timeline;
    if (!available) return;
    const i = Math.min(Math.max(index, available[0]), available[1]);
    this.selected = times[i];
    this.followNow = this.selected === Math.floor(Date.now() / 1000 / SLOT_SECONDS) * SLOT_SECONDS;
    this.show();
  }

  private show(): void {
    const end = this.timeline.times[this.timeline.times.length - 1] ?? null;
    const pick: FramePick | null =
      this.selected === null ? null : pickFrames(this.selected, this.observed, this.fields, this.hasForecast ? end : null);
    this.map.radar.show(pick);
    if (!pick || !this.timeline.times.length) return;
    // If motion isn't ready yet the nearest observed frame is shown; label and place the thumb there.
    const shown = pickTime(pick);
    this.controls.setIndex(Math.round((shown - this.timeline.times[0]) / SLOT_SECONDS), pick.lead > 0);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || this.selected === null || !this.timeline.times.length) return;
    const i = Math.round((this.selected - this.timeline.times[0]) / SLOT_SECONDS);
    const step = e.shiftKey ? 15 : 1;
    if (e.key === 'ArrowLeft') this.seekSlot(i - step);
    else if (e.key === 'ArrowRight') this.seekSlot(i + step);
  }

  private updateStatus(): void {
    const newest = this.observed[this.observed.length - 1];
    const age = newest === undefined ? Infinity : Date.now() / 1000 - newest;

    if (this.offline && newest === undefined) this.controls.setBanner("Can't reach the Met Office radar feed");
    else if (this.offline) this.controls.setBanner(`Offline — showing radar from ${formatClock(newest)}`);
    else if (age > STALE_SECONDS) this.controls.setBanner(`Latest radar is ${Math.round(age / 60)} min old`);
    else this.controls.setBanner(null);

    // Only say something while loading; the slider already shows the latest time.
    const start = this.timeline.times[0] ?? 0;
    const listed = this.refs.filter((r) => r.time >= start);
    const got = listed.filter((r) => this.observed.includes(r.time)).length;
    if (this.loading && listed.length) this.controls.setStatus(`Loading ${got}/${listed.length}`);
    else this.controls.setStatus(newest === undefined && !this.offline ? 'Loading…' : '');
  }
}
