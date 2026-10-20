import type { Timeline } from '../app';
import { formatAge, formatClock, formatOffset } from './time';

/** The latest radar counts as out of date (shown orange) beyond this; normally it's 5–20 min old. */
const STALE_SECONDS = 30 * 60;

export interface ControlsCallbacks {
  onSeek(index: number): void;
}

/**
 * A slim translucent strip at the bottom: the selected moment's clock time above a time slider,
 * plus a one-line status box near the top (visible while a thumb covers the strip): latest radar
 * age (orange when stale) │ offset of the selected moment from now │ "forecast" when extrapolated.
 * The track spans the whole timeline (now ± 2 h): observed frames are highlighted, forecast more
 * faintly, and a tick marks the current time. Forecast moments get a quiet
 * "forecast" tag in the top pill.
 */
export class Controls {
  private readonly track: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly clock: HTMLElement;
  private readonly statusBox: HTMLElement;
  private readonly boxAge: HTMLElement;
  private readonly boxOffset: HTMLElement;
  private readonly boxKind: HTMLElement;
  private latest: number | null = null;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private times: number[] = [];

  constructor(parent: HTMLElement, cb: ControlsCallbacks) {
    const root = document.createElement('div');
    root.className = 'controls';
    root.innerHTML = `
      <div class="banner" hidden></div>
      <div class="row" aria-live="polite">
        <span class="clock">--:--</span><span class="status"></span>
      </div>
      <div class="track">
        <input class="slider" type="range" min="0" max="0" value="0" step="1" aria-label="Radar time" disabled />
        <div class="now-tick" aria-hidden="true"></div>
      </div>`;
    parent.appendChild(root);

    this.statusBox = document.createElement('div');
    this.statusBox.className = 'status-box';
    this.statusBox.innerHTML = '<span class="age"></span><span class="mins"></span><span class="kind">forecast</span>';
    this.statusBox.hidden = true;
    parent.appendChild(this.statusBox);

    this.track = root.querySelector('.track')!;
    this.slider = root.querySelector('.slider')!;
    this.clock = root.querySelector('.clock')!;
    this.boxAge = this.statusBox.querySelector('.age')!;
    this.boxOffset = this.statusBox.querySelector('.mins')!;
    this.boxKind = this.statusBox.querySelector('.kind')!;
    this.status = root.querySelector('.status')!;
    this.banner = root.querySelector('.banner')!;

    this.slider.addEventListener('input', () => cb.onSeek(Number(this.slider.value)));
  }

  setTimeline(t: Timeline, index: number): void {
    this.times = t.times;
    this.latest = t.latest;
    const last = Math.max(1, t.times.length - 1);
    this.slider.max = String(last);
    this.slider.disabled = !t.available || t.available[0] === t.available[1];
    const [a0, a1] = t.available ?? [0, 0];
    const f0 = t.forecastFrom ?? a1;
    this.track.style.setProperty('--a0', String(a0 / last));
    this.track.style.setProperty('--f0', String(f0 / last));
    this.track.style.setProperty('--a1', String(a1 / last));
    this.track.style.setProperty('--now', String(Math.min(1, t.now / last)));
    this.setIndex(index, t.forecastFrom !== null && index > t.forecastFrom);
  }

  setIndex(index: number, forecast = false): void {
    this.slider.value = String(index);
    const t = this.times[index];
    this.clock.textContent = t === undefined ? '--:--' : formatClock(t);
    const now = Date.now() / 1000;
    this.statusBox.hidden = t === undefined;
    this.boxOffset.textContent = t === undefined ? '' : formatOffset(t, now);
    this.boxKind.hidden = !forecast;
    this.boxAge.hidden = this.latest === null;
    if (this.latest !== null) {
      this.boxAge.textContent = formatAge(this.latest, now);
      this.boxAge.classList.toggle('stale', now - this.latest > STALE_SECONDS);
    }
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setBanner(text: string | null): void {
    this.banner.hidden = !text;
    this.banner.textContent = text ?? '';
  }
}
