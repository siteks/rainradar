import { AttributionControl, GeolocateControl, Map as MLMap, setWorkerUrl, type CanvasSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { GRID, gridCorners } from '../radar/grid';
import { PALETTE } from '../radar/palette';

// MapLibre locates its worker relative to its own module, which breaks once bundled.
setWorkerUrl(maplibreWorkerUrl);

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const VIEW_KEY = 'rainradar.view';
const RADAR_ATTRIBUTION =
  'Radar <a href="https://www.metoffice.gov.uk/" target="_blank" rel="noopener">© Met Office</a> ' +
  '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA</a>';

interface SavedView {
  center: [number, number];
  zoom: number;
}

function loadView(): SavedView | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as SavedView | null;
    return v && Array.isArray(v.center) && typeof v.zoom === 'number' ? v : null;
  } catch {
    return null;
  }
}

function saveView(map: MLMap): void {
  try {
    const c = map.getCenter();
    localStorage.setItem(VIEW_KEY, JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
  } catch {
    // storage unavailable; not important
  }
}

/** The map plus a single radar overlay that shows whichever frame is current. */
export class RadarMap {
  readonly map: MLMap;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private ready: Promise<void>;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID.width;
    this.canvas.height = GRID.height;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(GRID.width, GRID.height);
    this.pixels = new Uint32Array(this.image.data.buffer);

    const saved = loadView();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    this.map = new MLMap({
      container,
      style: dark ? STYLE_DARK : STYLE_LIGHT,
      center: saved?.center ?? [-2.5, 54.4],
      zoom: saved?.zoom ?? 5,
      minZoom: 4,
      maxZoom: 12,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    this.map.touchZoomRotate.disableRotation();

    const geolocate = new GeolocateControl({
      positionOptions: { enableHighAccuracy: false },
      trackUserLocation: true,
      fitBoundsOptions: { maxZoom: 8 },
    });
    this.map.addControl(geolocate, 'top-right');
    // Credits sit at the top, level with the locate button, always expanded but translucent.
    this.map.addControl(new AttributionControl({ compact: false, customAttribution: RADAR_ATTRIBUTION }), 'top-left');
    this.map.on('moveend', () => saveView(this.map));

    this.ready = new Promise((resolve) => {
      this.map.on('load', () => {
        this.addRadarLayer();
        if (!saved) geolocate.trigger();
        resolve();
      });
    });
  }

  private addRadarLayer(): void {
    // Put rain under the place labels so towns stay readable.
    const firstSymbol = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    this.map.addSource('radar', {
      type: 'canvas',
      canvas: this.canvas,
      coordinates: gridCorners(),
      animate: false,
    });
    this.map.addLayer(
      {
        id: 'radar',
        type: 'raster',
        source: 'radar',
        paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
      },
      firstSymbol,
    );
  }

  /** Draw a quantised frame (or clear the overlay when null). */
  async show(frame: Uint8Array | null): Promise<void> {
    const px = this.pixels;
    if (frame) for (let i = 0; i < frame.length; i++) px[i] = PALETTE[frame[i]];
    else px.fill(0);
    this.ctx.putImageData(this.image, 0, 0);

    await this.ready;
    // A paused canvas source only re-uploads its texture while "playing", so play for one render.
    const src = this.map.getSource<CanvasSource>('radar');
    if (!src) return;
    src.play();
    this.map.once('render', () => src.pause());
  }
}
