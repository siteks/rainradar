import { formatClock, formatRelative } from './time';

export interface ControlsCallbacks {
  onSeek(index: number): void;
  onTogglePlay(): void;
}

/** Bottom bar: play/pause, time slider and the current frame's time. */
export class Controls {
  private readonly root: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly clock: HTMLElement;
  private readonly relative: HTMLElement;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private times: number[] = [];

  constructor(parent: HTMLElement, cb: ControlsCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'controls';
    this.root.innerHTML = `
      <div class="banner" hidden></div>
      <div class="row">
        <button class="play" type="button" aria-label="Play">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="icon-play" d="M8 5v14l11-7z"/><path class="icon-pause" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        </button>
        <div class="time" aria-live="polite"><span class="clock">--:--</span><span class="relative"></span></div>
      </div>
      <input class="slider" type="range" min="0" max="0" value="0" step="1" aria-label="Radar time" disabled />
      <div class="status"></div>`;
    parent.appendChild(this.root);

    this.play = this.root.querySelector('.play')!;
    this.slider = this.root.querySelector('.slider')!;
    this.clock = this.root.querySelector('.clock')!;
    this.relative = this.root.querySelector('.relative')!;
    this.status = this.root.querySelector('.status')!;
    this.banner = this.root.querySelector('.banner')!;

    this.play.addEventListener('click', () => cb.onTogglePlay());
    this.slider.addEventListener('input', () => cb.onSeek(Number(this.slider.value)));
  }

  setFrames(times: number[], index: number): void {
    this.times = times;
    this.slider.max = String(Math.max(0, times.length - 1));
    this.slider.disabled = times.length < 2;
    this.play.disabled = times.length < 2;
    this.setIndex(index);
  }

  setIndex(index: number): void {
    this.slider.value = String(index);
    const t = this.times[index];
    this.clock.textContent = t === undefined ? '--:--' : formatClock(t);
    this.relative.textContent = t === undefined ? '' : formatRelative(t, Date.now() / 1000);
  }

  setPlaying(playing: boolean): void {
    this.root.classList.toggle('playing', playing);
    this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setBanner(text: string | null): void {
    this.banner.hidden = !text;
    this.banner.textContent = text ?? '';
  }
}
