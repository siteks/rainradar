import type { Timeline } from '../app';
import { formatClock, formatRelative } from './time';

export interface ControlsCallbacks {
  onSeek(index: number): void;
}

/**
 * A slim translucent strip at the bottom: the selected frame's time above a time slider.
 * The track spans the whole timeline (now ± 2 h); the part with frames is highlighted and a tick
 * marks the current time.
 */
export class Controls {
  private readonly track: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly clock: HTMLElement;
  private readonly relative: HTMLElement;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private times: number[] = [];

  constructor(parent: HTMLElement, cb: ControlsCallbacks) {
    const root = document.createElement('div');
    root.className = 'controls';
    root.innerHTML = `
      <div class="banner" hidden></div>
      <div class="row" aria-live="polite">
        <span class="clock">--:--</span><span class="relative"></span><span class="status"></span>
      </div>
      <div class="track">
        <input class="slider" type="range" min="0" max="0" value="0" step="1" aria-label="Radar time" disabled />
        <div class="now-tick" aria-hidden="true"></div>
      </div>`;
    parent.appendChild(root);

    this.track = root.querySelector('.track')!;
    this.slider = root.querySelector('.slider')!;
    this.clock = root.querySelector('.clock')!;
    this.relative = root.querySelector('.relative')!;
    this.status = root.querySelector('.status')!;
    this.banner = root.querySelector('.banner')!;

    this.slider.addEventListener('input', () => cb.onSeek(Number(this.slider.value)));
  }

  setTimeline(t: Timeline, index: number): void {
    this.times = t.times;
    const last = Math.max(1, t.times.length - 1);
    this.slider.max = String(last);
    this.slider.disabled = !t.available || t.available[0] === t.available[1];
    const [a0, a1] = t.available ?? [0, 0];
    this.track.style.setProperty('--a0', String(a0 / last));
    this.track.style.setProperty('--a1', String(a1 / last));
    this.track.style.setProperty('--now', String(Math.min(1, t.now / last)));
    this.setIndex(index);
  }

  setIndex(index: number): void {
    this.slider.value = String(index);
    const t = this.times[index];
    this.clock.textContent = t === undefined ? '--:--' : formatClock(t);
    this.relative.textContent = t === undefined ? '' : formatRelative(t, Date.now() / 1000);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setBanner(text: string | null): void {
    this.banner.hidden = !text;
    this.banner.textContent = text ?? '';
  }
}
