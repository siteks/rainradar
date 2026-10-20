import { AttributionControl, GeolocateControl, Map as MLMap, Marker, setWorkerUrl, type IControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { addPlaceLabels } from './places';
import { RadarLayer } from './radar-layer';

// MapLibre locates its worker relative to its own module, which breaks once bundled.
setWorkerUrl(maplibreWorkerUrl);

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const VIEW_KEY = 'rainradar.view';
const ATTRIBUTION =
  'Radar <a href="https://www.metoffice.gov.uk/" target="_blank" rel="noopener">© Met Office</a> ' +
  '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA</a> · ' +
  'Places <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a>';

/** A map button (under the locate button) that fetches the latest radar; spins while busy. */
class RefreshControl implements IControl {
  private el: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(private readonly onRefresh: () => void) {}

  onAdd(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'refresh-button';
    button.title = 'Fetch latest radar';
    button.setAttribute('aria-label', 'Fetch latest radar');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
    button.addEventListener('click', () => this.onRefresh());
    el.appendChild(button);
    this.el = el;
    this.button = button;
    return el;
  }

  onRemove(): void {
    this.el?.remove();
  }

  setBusy(busy: boolean): void {
    this.button?.classList.toggle('busy', busy);
    this.button?.setAttribute('aria-busy', String(busy));
  }
}

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

/** The map plus the GPU radar layer. Frames and motion fields can be given to `radar` at any time. */
export class RadarMap {
  readonly map: MLMap;
  readonly radar = new RadarLayer();
  private readonly refreshControl: RefreshControl;

  constructor(container: HTMLElement, onRefresh: () => void) {
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

    // The button only recentres the map; our own dot (watchLocation) shows where the phone is.
    const geolocate = new GeolocateControl({
      positionOptions: { enableHighAccuracy: false },
      trackUserLocation: true,
      showUserLocation: false,
      fitBoundsOptions: { maxZoom: 8 },
    });
    this.map.addControl(geolocate, 'top-right');
    this.refreshControl = new RefreshControl(onRefresh);
    this.map.addControl(this.refreshControl, 'top-right');
    // Credits sit at the top, level with the locate button, always expanded but translucent.
    this.map.addControl(new AttributionControl({ compact: false, customAttribution: ATTRIBUTION }), 'top-left');
    this.map.on('moveend', () => saveView(this.map));
    this.watchLocation();

    this.map.on('load', () => {
      // Put rain under the place labels so towns stay readable.
      const firstSymbol = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      this.map.addLayer(this.radar, firstSymbol);
      addPlaceLabels(this.map);
      if (!saved) geolocate.trigger();
    });
  }

  setRefreshing(busy: boolean): void {
    this.refreshControl.setBusy(busy);
  }

  /** A dot at the phone's position whenever location access is allowed. It never moves the map. */
  private watchLocation(): void {
    if (!('geolocation' in navigator)) return;
    const el = document.createElement('div');
    el.className = 'location-dot';
    const marker = new Marker({ element: el });
    let watch: number | null = null;
    let added = false;
    const start = (): void => {
      if (watch !== null) return;
      watch = navigator.geolocation.watchPosition(
        (pos) => {
          marker.setLngLat([pos.coords.longitude, pos.coords.latitude]);
          if (!added) {
            marker.addTo(this.map);
            added = true;
          }
        },
        () => {}, // denied or unavailable: simply no dot
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 30_000 },
      );
    };
    const stop = (): void => {
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      watch = null;
    };
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? start() : stop()));
    if (document.visibilityState === 'visible') start();
  }
}
