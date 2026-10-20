import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  Map as MLMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import rows from './places.json';

// Our own place labels for the zoomed-out views, ranked by population. The basemap ranks places
// by Natural Earth "scalerank" (a hand-tuned atlas ranking), which e.g. omits Bristol at zoom 6
// while showing Bath, and lets Bath win label collisions at every zoom. From PLACES_MAX_ZOOM in,
// the basemap's own labels take over. Data: scripts/fetch-places.mjs (OSM + GeoNames).
export const PLACES_MAX_ZOOM = 8;

/** Larger places appear at lower zooms; tiers are stacked so larger places also win collisions. */
const TIERS = [
  { minPop: 250_000, minzoom: 0, bold: true },
  { minPop: 80_000, minzoom: 5.8, bold: false },
  { minPop: 30_000, minzoom: 6.6, bold: false },
  { minPop: 0, minzoom: 7.2, bold: false },
];

// Rough outline of Great Britain, Ireland and the Isle of Man, staying clear of France and Norway.
// Basemap place labels inside it are hidden below PLACES_MAX_ZOOM (ours replace them).
const UK_IE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-11, 51.2],
      [-7, 49.7],
      [-5, 49.85],
      [-1, 50.45],
      [1, 50.8],
      [1.5, 51.05],
      [2, 51.5],
      [2.2, 53],
      [-1, 57.6],
      [-0.3, 61],
      [-2, 61],
      [-9, 58.5],
      [-11, 54.5],
      [-11, 51.2],
    ],
  ],
};

type Row = [name: string, lon: number, lat: number, pop: number];

function placesGeoJSON(): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: (rows as Row[]).map(([name, lon, lat, pop]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name, pop },
    })),
  };
}

/** A small dot with a halo, drawn here so it works with any basemap sprite. */
function addDot(map: MLMap, fill: string, halo: string): void {
  const ratio = 2;
  const size = 8 * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 2.6 * ratio, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.strokeStyle = halo;
  ctx.lineWidth = 1.4 * ratio;
  ctx.stroke();
  ctx.fill();
  map.addImage('place-dot', ctx.getImageData(0, 0, size, size), { pixelRatio: ratio });
}

const isPlaceLabel = (l: LayerSpecification): l is SymbolLayerSpecification =>
  l.type === 'symbol' && l['source-layer'] === 'place' && !/country|state/.test(l.id);

export function addPlaceLabels(map: MLMap): void {
  const layers = map.getStyle().layers;
  const basemapPlaces = layers.filter(isPlaceLabel);
  const ref = basemapPlaces.find((l) => l.id.includes('city')) ?? basemapPlaces[0];
  const font = (ref?.layout?.['text-font'] as string[] | undefined) ?? ['Noto Sans Regular'];
  const boldFont = font.map((f) => f.replace('Regular', 'Bold'));
  const paint = ref?.paint ?? {};
  const textColor = typeof paint['text-color'] === 'string' ? paint['text-color'] : '#000';
  const haloColor = typeof paint['text-halo-color'] === 'string' ? paint['text-halo-color'] : '#fff';

  // Hide the basemap's town/city labels over the UK and Ireland below PLACES_MAX_ZOOM, but keep them
  // elsewhere (France, Norway...) by splitting each layer into an outside-only low-zoom copy.
  const outside: FilterSpecification = ['!', ['within', UK_IE]];
  for (const l of basemapPlaces) {
    const min = l.minzoom ?? 0;
    const max = l.maxzoom ?? 24;
    if (min >= PLACES_MAX_ZOOM) continue;
    map.addLayer(
      {
        ...l,
        id: `${l.id}-outside-uk`,
        maxzoom: Math.min(max, PLACES_MAX_ZOOM),
        filter: l.filter ? (['all', l.filter, outside] as FilterSpecification) : outside,
      },
      l.id,
    );
    if (max > PLACES_MAX_ZOOM) map.setLayerZoomRange(l.id, PLACES_MAX_ZOOM, max);
    else map.setLayoutProperty(l.id, 'visibility', 'none');
  }

  addDot(map, textColor, haloColor);
  map.addSource('places', { type: 'geojson', data: placesGeoJSON() });

  // Text grows with population (≈9px for 15k → ≈13px for London) and with zoom.
  const base: ExpressionSpecification = ['+', 8.5, ['*', 1.5, ['log10', ['/', ['get', 'pop'], 15000]]]];
  const textSize: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 4, base, 8, ['*', base, 1.3]];

  // Keep country names above (and ahead of) ours; add small tiers first so larger ones stack on top.
  const before = layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'place' && /country/.test(l.id))?.id;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const tier = TIERS[i];
    const filter: FilterSpecification =
      i === 0
        ? ['>=', ['get', 'pop'], tier.minPop]
        : ['all', ['>=', ['get', 'pop'], tier.minPop], ['<', ['get', 'pop'], TIERS[i - 1].minPop]];
    map.addLayer(
      {
        id: `places-${i}`,
        type: 'symbol',
        source: 'places',
        minzoom: tier.minzoom,
        maxzoom: PLACES_MAX_ZOOM,
        filter,
        layout: {
          'symbol-sort-key': ['-', ['get', 'pop']],
          'icon-image': 'place-dot',
          'text-field': ['get', 'name'],
          'text-font': tier.bold ? boldFont : font,
          'text-size': textSize,
          'text-variable-anchor': ['bottom', 'top', 'right', 'left'],
          'text-radial-offset': 0.5,
          'text-justify': 'auto',
          'text-padding': 3,
        },
        paint: {
          'text-color': paint['text-color'] ?? textColor,
          'text-halo-color': paint['text-halo-color'] ?? haloColor,
          'text-halo-width': paint['text-halo-width'] ?? 1,
          'text-halo-blur': paint['text-halo-blur'] ?? 1,
        },
      },
      before,
    );
  }
}
