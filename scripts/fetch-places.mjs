// Builds src/map/places.json: towns and cities in Great Britain, Ireland and the Isle of Man with
// population, for our own population-ranked place labels. (The basemap ranks places by Natural
// Earth "scalerank", which e.g. puts Bath above Bristol and Lerwick above Sheffield.)
//
// Places and positions: OpenStreetMap place=city|town nodes via Overpass (ODbL).
// Population: the OSM `population` tag; where missing, GeoNames cities15000 (CC BY 4.0) matched by
// name within 5 km. GeoNames alone was not usable: it misplaces some towns (e.g. Loughton, Essex
// sits on a Shropshire hamlet) and credits villages with district totals.
//
// Run: node scripts/fetch-places.mjs   (needs `unzip` on PATH)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIN_POP = 15000;
const OUT = new URL('../src/map/places.json', import.meta.url);
const UA = 'rainradar-places/0.1 (https://github.com/siteks/rainradar)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_QUERY = `[out:json][timeout:180];
(area["ISO3166-1"="GB"][admin_level=2];area["ISO3166-1"="IE"][admin_level=2];area["ISO3166-1"="IM"][admin_level=2];)->.a;
node["place"~"^(city|town)$"](area.a);
out qt;`;
const GEONAMES_ZIP = 'https://download.geonames.org/export/dump/cities15000.zip';
// Within these cities, drop every other place (boroughs and suburbs mapped as separate towns).
const ABSORB = [
  { name: 'London', lon: -0.1276, lat: 51.5072, km: 20 },
  { name: 'Dublin', lon: -6.2603, lat: 53.3498, km: 10 },
];
const RENAME = { 'Newcastle upon Tyne': 'Newcastle', 'Kingston upon Hull': 'Hull' };

const km = (a, b) => {
  const dx = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, (a.lat - b.lat) * 110.57);
};
const norm = (s) => s.toLowerCase().replace(/^saint /, 'st ').replace(/[^a-z]/g, '');
const parsePop = (v) => {
  const n = parseInt(String(v ?? '').split(';')[0].replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOsm() {
  let wait = 15_000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
      });
      if (res.ok) return (await res.json()).elements;
      console.warn(`Overpass ${url}: HTTP ${res.status}, retrying in ${wait / 1000}s`);
    } catch (e) {
      console.warn(`Overpass ${url}: ${e.message}, retrying in ${wait / 1000}s`);
    }
    await sleep(wait);
    wait *= 2;
  }
  throw new Error('Overpass unavailable');
}

async function fetchGeoNames() {
  const dir = mkdtempSync(join(tmpdir(), 'geonames-'));
  try {
    const zip = join(dir, 'cities15000.zip');
    const res = await fetch(GEONAMES_ZIP, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`GeoNames download failed: ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const text = execFileSync('unzip', ['-p', zip, 'cities15000.txt'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    return text
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((f) => f.length >= 15 && ['GB', 'IE', 'IM'].includes(f[8]))
      .map((f) => ({ names: [f[1], f[2], ...f[3].split(',')].filter(Boolean).map(norm), lon: +f[5], lat: +f[4], pop: +f[14] }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [osm, geonames] = await Promise.all([fetchOsm(), fetchGeoNames()]);

// OSM places that carry their own population; a GeoNames entry that matches one of these (by any of
// its names, e.g. "Stoke" for Stoke-on-Trent) already belongs to it and mustn't be lent to a neighbour.
const osmWithPop = osm
  .filter((e) => e.tags?.name && parsePop(e.tags.population))
  .map((e) => ({ key: norm(e.tags['name:en'] ?? e.tags.name), lon: e.lon, lat: e.lat }));
const claimed = (g) => osmWithPop.some((o) => g.names.includes(o.key) && km(o, g) < 10);

let fromOsm = 0;
let fromGeoNames = 0;
const places = [];
for (const e of osm) {
  const t = e.tags ?? {};
  const rawName = t['name:en'] ?? t.name;
  if (!rawName) continue;
  const p = { name: RENAME[rawName] ?? rawName, lon: e.lon, lat: e.lat, pop: parsePop(t.population) };
  if (ABSORB.some((c) => c.name !== rawName && km(p, c) < c.km)) continue;
  if (p.pop) fromOsm++;
  else {
    const key = norm(rawName);
    const g = geonames.find((g) => g.names.includes(key) && km(g, p) < 5 && !claimed(g));
    if (!g) continue; // not in GeoNames' ≥15k list, so presumably small
    p.pop = g.pop;
    fromGeoNames++;
  }
  if (p.pop >= MIN_POP) places.push(p);
}
places.sort((a, b) => b.pop - a.pop);

// Compact rows: [name, lon, lat, population]
const rows = places.map((p) => JSON.stringify([p.name, +p.lon.toFixed(3), +p.lat.toFixed(3), p.pop]));
writeFileSync(OUT, `[\n${rows.join(',\n')}\n]\n`);
console.log(`${osm.length} OSM towns/cities; population from OSM ${fromOsm}, from GeoNames ${fromGeoNames}`);
console.log(`${places.length} places ≥ ${MIN_POP} written to ${OUT.pathname}`);
console.log(places.slice(0, 30).map((p) => `${p.name} ${p.pop}`).join(' · '));
