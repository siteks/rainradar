import { AttributionControl, GeolocateControl, Map as MLMap, Marker, setWorkerUrl } from 'maplibre-gl';
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

  constructor(container: HTMLElement) {
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
