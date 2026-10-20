import { formatClock, formatRelative } from './time';

export interface ControlsCallbacks {
  onSeek(index: number): void;
}

/** A slim translucent strip at the bottom: the current frame's time above a time slider. */
export class Controls {
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
      <input class="slider" type="range" min="0" max="0" value="0" step="1" aria-label="Radar time" disabled />`;
    parent.appendChild(root);

    this.slider = root.querySelector('.slider')!;
    this.clock = root.querySelector('.clock')!;
    this.relative = root.querySelector('.relative')!;
    this.status = root.querySelector('.status')!;
    this.banner = root.querySelector('.banner')!;

    this.slider.addEventListener('input', () => cb.onSeek(Number(this.slider.value)));
  }

  setFrames(times: number[], index: number): void {
    this.times = times;
    this.slider.max = String(Math.max(0, times.length - 1));
    this.slider.disabled = times.length < 2;
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
