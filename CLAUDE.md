# RainRadar — PWA rain radar for the UK/Ireland

## Goal

Replace the discontinued Android **RainToday** app (MeteoGroup, now DTN). It showed a rain radar
overlaid on a map, with a time slider that scrubs back through recent radar frames and forward through
a short forecast (nowcast). The replacement is a **Progressive Web App**, installed to the Android home
screen from Chrome. It is for personal use, and coverage needs to be **UK / Ireland**.

Must-haves:
- A full-screen map with the radar overlay. Pinch to zoom and pan, plus a "my location" dot.
- A time slider. Past frames (≈2–3 h) → "now" → forecast frames (≈2 h).
- **No play button.** Keep the UI minimal: a slim, translucent slider strip at the bottom, and credits
  shown translucent at the top-left, level with the locate button. This is the user's stated preference.
- Forecast frames must **look like the radar frames** and flow continuously across "now", as RainToday
  did and Yahoo Weather doesn't. The forecast quality is the main point of the project. See "Forecast
  strategy".
- A clear timestamp label. Past frames and forecast frames must look visibly different.
- Fast cold start and a usable app shell offline (show the last cached frames with a stale banner).

Nice-to-haves (later): a "rain in the next 2 h at my location" graph, and rain alerts (these need push
notifications and a server, so they are out of scope for v1).

## Status

Milestones:
- **M1 — past radar + slider + PWA: done** (2026-10-20). Verified in desktop Chrome against live data.
  - Not yet tested on a phone.
  - Repo: https://github.com/siteks/rainradar (remote `origin`). Pages URL: https://siteks.github.io/rainradar/
- **M2 — in-between frames + now-centred timeline: done** (2026-10-20). Began with precomputed 5-min
  frames; the same day it moved to GPU rendering with continuous time (1-min slider). Verified in
  desktop Chrome; the 5-min version felt smooth on the user's phone.
  Phone performance is still unmeasured.
- **M3a — radar-only forecast: done** (2026-10-20). Each future minute extrapolates the latest frame
  along a frozen motion field (method (c) below), out to the end of the timeline (now + 2 h). The
  field is a 3:2:1-weighted mean of the last three pair fields (`src/radar/forecast.ts`). The shader
  traces each pixel back in ≤5-min semi-Lagrangian steps. There's no growth or decay yet.
  - Also added: a location dot (`RadarMap.watchLocation`). It uses `watchPosition` while the page is
    visible and shows only when permission is granted. The locate button only recentres the map
    (`showUserLocation: false`). The dot is untested in a browser (needs a real permission grant).
- **M3b — model motion forecast** (see "Forecast strategy"), plus verification/replay mode.
- **M4 — polish:** a "rain at my location" graph, settings, and maybe the MOGREPS chance-of-rain layer.

The research notes below date from **2026-10-20**. Re-verify anything marked *(verify)* before relying on it.

## Commands

- `npm run dev` — Vite dev server. The service worker is not active in dev.
- `npm run dev:phone` — the same, reachable over the LAN. A phone on `http://<lan-ip>` gets no service
  worker or install, because that needs HTTPS. Use Chrome `chrome://inspect` port forwarding to test
  PWA behaviour on a phone.
- `npm test` — vitest: listing parsing, quantisation, and reprojection against the real grid metadata.
- `npm run build` — typecheck + production build into `dist/`. `npm run preview` serves it, with the
  service worker.
- `node scripts/make-icons.mjs` — regenerates `public/icons/` (drawn in code; there's no image tooling).
- `node scripts/fetch-places.mjs` — regenerates `src/map/places.json` (the place labels). It needs network
  access and `unzip`. Overpass is often busy; the script retries with backoff.
- Deploy: push to `main`. `.github/workflows/deploy.yml` builds and publishes to GitHub Pages. In the
  repo, set Settings → Pages → Source to "GitHub Actions". `base: './'` means any repo name works.

## Feasibility summary

**Feasible, with free data and no backend.** RainViewer was the free source that most hobby radar apps
used. It **removed forecast (nowcast) frames on 2026-01-01**, so the forecast is built here:
- **Past:** the Met Office 1 km radar, read straight from AWS open data.
- **Forecast:** the observed radar is moved forward along motion predicted by the Met Office UKV 2 km
  model. The model is read from Open-Meteo's open data with HTTP range requests.

See "Data sources" and "Forecast strategy".

Verified on 2026-10-20 by a spike in a scratch folder:
- The Met Office's free UK 1 km radar composite is live on AWS open data, and the bucket has **CORS `*`**.
  The browser can fetch the files directly, so **no backend is needed** for past frames.
- `jsfive` (a pure-JS HDF5 reader) decoded one frame in Node in about 250 ms. The frame is a
  1725×2175 float32 grid with deflate compression.
- `proj4` reprojects the grid correctly. The grid's upper-left corner is exactly at projected coordinates
  (-405000, 1550000) m.
- RainViewer tiles also still work with CORS `*`. They return past frames only, and the 2 h of history
  is held in `/public/weather-maps.json`.
- Open-Meteo's `data_spatial` bucket allows CORS `*`, answers Range requests with 206, and has UKV runs
  every hour (each published about 4 h after its run time).
- `@openmeteo/weather-map-layer` 0.3.0 can draw the UKV grid.

## Data sources

### 1. Met Office UK radar composite — AWS open data (PRIMARY for past frames)
- Bucket: `s3://met-office-radar-obs-data` (eu-west-2). It needs no AWS account and can be read over plain HTTPS:
  - List files: `https://met-office-radar-obs-data.s3.eu-west-2.amazonaws.com/?list-type=2&prefix=radar/YYYY/MM/DD/`
  - Key pattern: `radar/YYYY/MM/DD/YYYYMMDDHHmm_ODIM_ng_radar_rainrate_composite_1km_UK.h5`
- A new frame arrives **every 15 min** (:00/:15/:30/:45) and is published about 5 min after its
  validity time. Each file is ≈850 KB. The archive keeps a rolling 2 years.
- Licence: **CC BY-SA 4.0, © Crown copyright, Met Office.** The UI must show this attribution.
- Format: ODIM_H5 v2.2.
  - Data path: `/dataset1/data1/data`, a float32 array of `[2175 rows, 1725 cols]` with values in **mm/h**.
    Chunked, with DEFLATE level 6.
  - `nodata = -1` (outside radar range, ≈70% of the grid). `undetect = 0` (dry). `gain = 1`, `offset = 0`.
  - `/where/projdef = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.999601 +x_0=400000 +y_0=-100000 +ellps=airy +units=m"`.
    This is close to OSGB but **not** EPSG:27700, because the false northing differs. Always use the
    `projdef` string from the file rather than hard-coding a projection.
  - `xscale = yscale = 1000` m. Row 0 is the top row (`origin = UPPER LEFT`). UL corner =
    (-405000, 1550000) in projected metres. The bounds in lat/lon are roughly 43.7–62.9°N and
    18°W–16°E. Only cells within reach of the UK radars hold data.
  - `/what/date` + `/what/time` give the validity time.
- Coverage: GB, Northern Ireland, Jersey, and the eastern part of the Republic of Ireland. The western
  Republic of Ireland is weak or missing because Met Éireann radars are not in this composite. *(verify
  visually)*

### 2. RainViewer public API (FALLBACK / quick MVP)
- `https://api.rainviewer.com/public/weather-maps.json` lists `radar.past[]`: 13 frames at 10-min steps (2 h).
  `radar.nowcast[]` is **empty** and has been since 2026-01-01.
- Tile URL: `{host}{path}/256/{z}/{x}/{y}/{color}/{smooth}_{snow}.png`. Use colour scheme 2 (Universal Blue) only.
- **Max zoom 7.** Request z≤7 and let the map library overzoom. At UK latitudes z7 is ≈0.75 km/px, so
  overzooming is acceptable. Rate limit: 100 requests/IP/min. Personal or educational use only.
- Global coverage, 10-min steps, no decoding needed. It makes a good fallback when the Met Office feed is late.

### 3. Weather model (NWP) data — used for motion and alignment, not displayed directly

**Open-Meteo spatial open data** on AWS, verified 2026-10-20.
- Bucket: `https://openmeteo.s3.amazonaws.com/data_spatial/<model>/`. It allows CORS `*`, supports HTTP
  Range requests, and needs no key.
- Files: `<model>/YYYY/MM/DD/HHMMZ/<valid-time>.om`, one file per valid time holding all variables
  (≈96 MB for UKV). The browser reads **only the byte ranges it needs** for one variable and the visible
  area. **Never download a whole file.**
- `<model>/latest.json` gives `reference_time`, `valid_times[]`, `variables[]` and `crs_wkt`. Files are
  kept for 7 days.
- Licence: CC BY 4.0 from Open-Meteo. Met Office-derived data carries **CC BY-SA**, as for the radar.
- Rendering library: **`@openmeteo/weather-map-layer`** (GPL-2.0, v0.3.0, *"not yet production-ready"*).
  - It registers a MapLibre `om://` protocol and also has Leaflet/OpenLayers adapters. It handles the
    UKV Lambert Azimuthal Equal-Area grid.
  - Example: `om://https://openmeteo.s3.amazonaws.com/data_spatial/ukmo_uk_deterministic_2km/latest.json?variable=precipitation&time_step=valid_times_5`.
  - Do **not** use `data-spatial.open-meteo.com`. It only accepts a localhost or `*.open-meteo.com` referer.
  - It runs better when the page is cross-origin isolated (COOP/COEP headers). GitHub Pages can't set
    those headers, but the `coi-serviceworker` shim can, and it is optional.

Models useful for the UK. Run times were checked on 2026-10-20:

| Model (`<model>`) | Grid | Runs | Horizon | Lag after run time | Precip variables |
|---|---|---|---|---|---|
| `ukmo_uk_deterministic_2km` (Met Office UKV) | 2 km, LAEA | hourly | ~54 h, hourly steps | **~4–5 h** | `precipitation` (mm over the preceding hour), `rain` |
| `ukmo_uk_ensemble_2km` (MOGREPS-UK) | 2 km | hourly | ~5 days | ~4 h | `precipitation_probability` (%) |
| `dmi_harmonie_arome_europe` | ~2 km | 3-hourly | ~60 h | ~3 h | `precipitation` |
| `knmi_harmonie_arome_europe` | ~5.5 km | 3-hourly | ~60 h | ~2.5 h | `precipitation`, `rain` |
| `ukmo_global_deterministic_10km` | 10 km | 6-hourly | 7 days | ~6 h | — (fallback) |

**The lag is the key constraint.** The newest model run is already 3–5 hours old when it is published.
It usually has the right structure and motion (fronts, bands, the swirl around a low), but its rain is
often in slightly the wrong place right now. So the app uses the model for *motion*, after aligning it
with the radar, and the radar for *what the rain looks like*.

Other forecast-map routes:
- **Met Office UKV on AWS** (`s3://met-office-atmospheric-model-data`, NetCDF, CC BY-SA). This is the same
  model with 16 extra 12 h "nowcast" runs per day, but it lags 3–6 h too. It is NetCDF, not
  range-readable tiles, so it would need a server. Open-Meteo already repackages it, so skip this.
- **Rainbow.ai Tiles API.** AI nowcast tiles 0–4 h ahead (global; the free tier is 30k tiles/month,
  ≈150 views). It needs a token-hiding proxy such as a Cloudflare Worker, so it isn't purely static.
  - Tile URL: `https://api.rainbow.ai/tiles/v1/precip/{snapshot}/{forecast_secs}/{z}/{x}/{y}?token=…`.
  - Worth a side-by-side comparison later. *(verify the tile forecast horizon and max zoom)*
- **Open-Meteo point API** (`api.open-meteo.com`, `minutely_15`). Use it for a "rain at my location" graph only.
- Ruled out:
  - Met Office DataPoint radar was retired in 2025.
  - DataHub "Map Images" covers long lead times only.
  - OpenWeatherMap's forecast map layers are paid.
  - Tomorrow.io's free plan allows 25 calls/hour, and each tile counts as a call.
  - MapTiler Weather is 28 km, too coarse for rain.
  - Self-hosted LibreWXR is too heavy.

### 4. Forecast strategy — move the *observed* radar along the *model's* motion (the interesting part)
**Horizon: about 2 h.** Two lessons from other apps shape this:
- **RainToday** looked right but moved rain in straight lines. UK rain mostly swirls around depressions,
  so straight-line extrapolation goes wrong within an hour.
- **A frozen dense flow field is better than it sounds** (a point from a review of this design). One
  vector for the whole screen fails on a low. A dense field already contains the rotation: rain north
  of the low moves west while rain south of it moves east. Semi-Lagrangian steps follow the local vector
  at each step, so paths curve. What it misses is that the field itself evolves: a band wrapping round
  a low gets the right curved track but not the tightening of the spiral. That error is small at 1 h,
  noticeable at 2 h, and beyond that is the model's job. So the model's value here is mainly the
  **time evolution of the motion field**. Expect method (c) below to be a strong baseline.
- **Yahoo Weather** jumps visually when the slider crosses into the future, because it switches from
  radar imagery to model imagery.

The aim is to keep the radar's look and take the motion from the model.

**Every forecast frame is the latest radar frame, warped forward along a motion field that changes with
time and space.** It never switches to model imagery, so frame +0 is exactly the last radar frame.

1. **Align the model with reality** (spatially and in time). The newest UKV run is ~4–5 h old.
   - Compare the model precipitation over roughly the last 1–2 h of its run with the radar for the same times.
   - Find the shift (start with one global vector, later a coarse vector field) and the time lag that
     best match the model's rain to the radar's rain. Use cross-correlation on smoothed (~10 km)
     log-rate fields.
   - Also record a match score. If the model has the situation wrong, its motion shouldn't be trusted.
2. **Get the model's predicted motion** for now → +2 h.
   - Primary: optical flow between consecutive model precipitation frames. That follows how the *pattern*
     moves, including bands wrapping around a low and the low itself moving.
   - The model gives hourly frames. Run flow on hourly pairs, smooth heavily, and interpolate the
     vectors in time to 5–15-min steps.
   - Backup/regulariser: UKV `wind_speed_700hPa` + `wind_direction_700hPa`, also available spatially.
     Rain cells roughly follow the steering-level wind, but **frontal bands don't** (the wind blows along
     the front while the band moves across it). So prefer pattern flow, and use wind only where
     model rain is too sparse for flow.
   - Apply the step-1 alignment to the motion field, so the vectors are in the right place.
3. **Check against observed motion.**
   - Calculate the radar's own optical flow from the last 3–4 radar frames.
   - At +0, use mostly the observed motion. Ramp towards the model's motion over the first ~30–60 min.
     How fast depends on the step-1 match score and on how well the model's motion now agrees with the
     observed motion. A bad match means staying closer to observed motion, held steady.
4. **Advect the radar.** Use semi-Lagrangian backward trajectories through the time-varying field, so
   paths can curve. Use small time steps (≤5 min) with bilinear sampling.
   - Areas flowing in from outside radar coverage are "unknown". Draw them transparent or faintly
     hatched, never as model rain.
5. **Later, optional: growth/decay.** Scale intensity along each trajectory by the model's predicted
   change in rain over the same (aligned) trajectory, capped to avoid making up storms.

**Keeping the look smooth.** This is a hard requirement and matters as much as accuracy:
- Time is continuous: the GPU builds the picture for any moment (the slider uses 1-min steps).
  - Fill in between the 15-min radar frames by **motion-based morphing** (warp both neighbouring frames
    along the flow), never by cross-fading.
  - Forecast frames should be built the same way in the shader: trace each pixel back through the
    motion texture(s) in a few steps and sample the latest radar frame there. The slider should feel
    continuous across "now".
- Use the same colour scale, opacity and resolution for every frame. Don't blur more with lead time by
  default; if blurring is ever added, make it a setting.
- Mark future frames gently (a dashed slider track, a time label like "+40 min"), not with a different look.

**Verification mode** (for development):
- Replay past days and score +30/+60/+120 min against the radar that actually fell. Use CSI at
  0.5 mm/h and a fractions skill score.
- Compare four methods: (a) hold the radar still, (b) straight-line observed motion (the RainToday
  baseline), (c) observed flow held constant (frozen dense field, semi-Lagrangian), (d) the
  model-motion method above. (c) comes almost free once the forecast shader exists: trace each pixel
  back through the latest motion field. Ship it as the first forecast, before the model work.
- Radar goes back 2 years, but Open-Meteo keeps model files for only **7 days**. Save a small archive
  of model fields (precip + 700 hPa wind over the UK bounding box) while developing.

Engineering notes:
- Read model fields as **raw numbers** with `@openmeteo/file-reader` in the worker. Only read the UK
  bounding box and the few variables needed: `precipitation`, plus the 700 hPa wind if used.
- Resample them onto a coarse (~4–8 km) Web Mercator motion grid. Do the motion maths there, then warp
  the 1 km radar with the upsampled vectors.
- Units: model `precipitation` is mm over the previous hour, and the radar gives an instantaneous mm/h
  rate. Only alignment and flow use the model rain, and both work on smoothed log values, so the
  difference in units hardly matters.
- `@openmeteo/weather-map-layer` is still useful as a debug overlay: show the model's own rain next to
  the warped radar.

## Recommended architecture (v1)

A **static site with no backend**, hosted on **GitHub Pages** (decided). A PWA needs HTTPS. The site is
the install source and the update channel. The installed app runs from its service-worker cache, and
fetches data directly from the AWS buckets. Changing the hosting URL later means reinstalling the app.

- **Build:** Vite + TypeScript, plain DOM or a tiny UI layer. Do not use a heavy framework, because the
  UI is one screen.
- **Map:** **MapLibre GL JS** with a free, keyless basemap such as OpenFreeMap. It gives smooth mobile
  gestures and makes image/canvas sources easy.
  - Google Maps JS API also works if that look is wanted. It needs an API key with billing enabled;
    10k free dynamic map loads per month is plenty for one user.
  - Draw the radar with a custom `OverlayView`, or with a `GroundOverlay` fed from an already-reprojected
    Web Mercator image.
  - Keep the map behind a small adapter so it can be swapped.
- **Radar pipeline** (as built):
  1. `src/sources/metoffice.ts` lists S3 keys for the last 3 h on the main thread.
  2. `src/worker/radar.worker.ts` handles the frames the app doesn't have yet, newest first.
     It fetches them (the service worker caches the `.h5` files) and decodes them with `jsfive`
     (`src/worker/decode.ts`).
  3. It resamples onto `GRID` through a lookup table (`src/worker/reproject.ts`). proj4 runs only on an
     8-px lattice of knots, with bilinear interpolation in between.
  4. It quantises to bytes (`src/radar/palette.ts`: 0 = no data, 1 = dry, 2–255 = log rain rate).
     The display-grid bytes are stored in Cache Storage (`radar-grids-<GRID_VERSION>`), so a cold start
     skips decoding.
  5. **Motion** (`src/worker/motion.ts`). The worker keeps its own copy of each observed frame.
     After loading, it works through consecutive pairs newest first (gaps ≤ 30 min) and posts a
     `motion` message per pair:
     - `estimateMotion` does block matching on block-averaged log-rain. A 72 km window is searched
       exhaustively on 12 km cells (±48 km), refined on 6 km then 3 km cells, with a parabola for
       sub-cell precision.
     - The vectors sit on a 24-px (≈36 km) lattice of nodes. They're cleaned with a 3×3 median, then
       filled and smoothed by confidence-weighted averaging. Where support is thin they blend
       towards the global median vector.
     - Timing in Node on real frames: about 0.3 s per motion estimate.
     - `morph()` is the CPU reference version of the shader's blend. It's used by the tests, and later
       for verification mode.
  6. **GPU rendering** (`src/map/radar-layer.ts`, a MapLibre WebGL2 custom layer).
     - Textures: each observed frame is an R8 texture (quantised bytes), each motion field an RG16F
       texture (one texel per node, linearly filtered), and the palette a 256×1 RGBA texture.
     - Per pixel, the fragment shader samples A at p − α·d and B at p + (1−α)·d. Each sample is
       bilinear in log space and skips no-data texels. It blends the two (falling back to one side
       where the other has no data), then colours the result through the palette and outputs
       premultiplied alpha.
     - The quad uses `options.defaultProjectionData.mainMatrix`, which maps Mercator 0..1 to clip
       space. `modelViewProjectionMatrix` is *not* in those units: the layer drew nothing with it.
     - Uploads and deletions are queued and applied inside `render()`, so MapLibre resyncs its GL state
       afterwards. Unpack state is set explicitly and then restored. CPU copies are kept so
       `onAdd` can rebuild everything after a context loss.
     - Transparent palette entries carry the first visible colour's RGB, so linear filtering doesn't
       fade light rain through black.
  7. **Choosing frames** (`src/radar/timeline.ts`): `pickFrames(t)` returns the bracketing observed
     frames and α, or the nearest frame (α = 0) until that pair's motion has arrived. Past the latest
     frame it returns `lead` (seconds), and the shader switches to extrapolation (`uSteps > 0`) with
     the `forecast` field texture.
     `App.show()` labels the slider with the time actually shown. The layer sits under the basemap's
     first symbol layer, so labels stay on top.
- **Timeline** (`App.rebuild`, `Controls.setTimeline`): 1-min slots from now − 2 h to now + 2 h,
  rebuilt every minute so "now" stays roughly central. A tick marks the exact current time, and the
  observed range is highlighted on the track and the forecast range more faintly (`--f0`…`--a1`).
  Shift+arrow moves 15 min. The app opens on **now** (normally a short forecast, since radar lags
  ~15 min) and follows it as the clock moves, until the user picks another time (`followNow`).
- **Offset pill** (top centre, below the credits): shows the selected moment relative to now
  ("Now", "−25 min", "+1 h 05"), plus "forecast" when extrapolated. It stays readable while a thumb
  covers the bottom strip. The bottom row keeps just the clock time and loading status. The listing fetches one extra frame before the
  window, so the earliest minutes can be interpolated.
- **Place labels** (`src/map/places.ts`): our own population-ranked labels replace the basemap's
  town/city labels over GB, Ireland and the Isle of Man below zoom 8.
  - Why: the basemap ranks places by Natural Earth `scalerank`, a hand-tuned atlas ranking. It puts
    Bath (7) above Bristol and Sheffield (8), and Wick/Lerwick (6) above both. Bristol isn't even in
    the zoom-6 tiles.
  - Data: `src/map/places.json`, about 680 rows of `[name, lon, lat, pop]`. Places and positions come
    from OSM `place=city|town`. Population is the OSM tag, falling back to GeoNames by name within
    5 km. GeoNames alone had misplaced towns (Loughton, Neston) and district totals.
  - Rendering: 4 symbol layers by population tier (zoom 0/5.8/6.6/7.2), stacked so larger places win
    collisions, plus `symbol-sort-key` = −pop within a tier. Text size scales with log(pop), and tier 1
    is bold. The dot is drawn on a canvas, so it works with either basemap sprite.
  - Basemap place layers are found by `source-layer: place`; the light and dark styles use different
    layer ids. Each is split into a copy below zoom 8 with a `!within(UK_IE polygon)` filter, so
    labels elsewhere (France, Norway…) still show. The Channel Islands are left to the basemap.
  - Known data quirks: some OSM figures are council-district totals (Leeds 766k, Wakefield 322k), and
    Birkenhead takes GeoNames' 325k (probably the Wirral's total). That's acceptable for ranking.
- `GRID` (`src/radar/grid.ts`) is EPSG:3857 at 1500 m per pixel, covering lon −11…4.5 and lat 46.5…61
  (1151×1844 px). Bump `GRID_VERSION` if it or the quantisation changes.
- **Forecast (planned):** the work is split between the worker and the GPU.
  - Worker, on coarse grids: read model fields with `@openmeteo/file-reader`, align them with the
    radar, and produce motion fields for future times.
  - GPU: render any future moment by tracing each pixel back through those fields and sampling the
    latest radar frame.

  Everything stays in one Web Mercator raster space. WebGPU compute (with a feature check) becomes
  worthwhile later for batch work such as verification replays. MapLibre v6 itself is WebGL2-only, so
  rendering stays WebGL2.
- **PWA:** a `manifest.webmanifest` (standalone, portrait, icons), and a service worker that precaches the
  app shell. Radar frames go in a separate runtime cache, keeping about 3 h of frames and evicting older ones.
- **Refresh:** poll every 5 min while the page is visible (`visibilitychange`). New frames appear at
  :05/:20/:35/:50.

## Conventions

- TypeScript strict mode. Plain DOM, no UI framework. Keep the modules small:
  - `src/sources/` — data sources.
  - `src/worker/` — decode, reproject, and later the motion/nowcast code.
  - `src/radar/` — grid and palette, shared by the main thread and the worker.
  - `src/map/` — the MapLibre wrapper.
  - `src/ui/` — controls and time formatting.
  - `src/app.ts` — state and wiring.
- Worker messages are typed in `src/worker/protocol.ts`. Transfer `Uint8Array` buffers; don't copy them.
- Timestamps are UTC epoch seconds internally. Display them in local time (Europe/London) in the UI.
- Show the source and licence attribution on the map at all times (Met Office CC BY-SA; RainViewer or
  Rainbow when those sources are used).
- Mobile-first. Test at 360×800 in Chrome DevTools device mode, and on a real Android phone over LAN
  (`vite --host`). The service worker needs HTTPS or localhost.

## Gotchas

- Do not hard-code EPSG:27700 for the radar grid. Read `projdef` from the file.
- S3 listing returns XML, at most 1000 keys per page (one day is 96 files, so this is fine). Parse it
  with `DOMParser` in the main thread, or with a regex in the worker, because `DOMParser` is not
  available in workers.
- Around midnight UTC the last N frames span two date prefixes.
- RainViewer: ask for z≤7 and set `maxNativeZoom`/`maxzoom` so the map library overzooms rather than
  requesting tiles that return 4xx.
- Keep memory low on phones: dispose of each decoded float array before decoding the next frame.
  `jsfive` returns a plain JS `Array` (≈30 MB transient per frame). If phones struggle, consider `h5wasm`.
- MapLibre v6 finds its own worker relative to its module URL, which breaks once bundled. Keep the
  `setWorkerUrl(… maplibre-gl-worker.mjs?url)` call in `src/map/map.ts`. Keep `mjs` in the workbox
  `globPatterns` so the worker is precached.
- **The radar picture contains fixed artifacts.** Around Cobbacombe Cross radar (near Bampton, Devon),
  on 2026-10-20 there were narrow radial streaks that stayed in place while the rain moved:
  - weaker bands at bearings ~22–24° and ~102–104° (×0.6–0.75);
  - a stronger band at ~167–168° (×1.3).

  These are probably partial beam blockage or interference. Every radar site may have them. Motion
  estimation (M2/M3) must not lock onto these zero-motion features: estimate on a smoothed/downsampled
  field, use a robust estimator, and ignore near-zero vectors that coincide with known radar sites.
- HDF5 string attributes from `jsfive` are NUL-padded. Strip them (`str()` in `decode.ts`).
- The grey "no data" tint fills the whole `GRID` rectangle outside radar range, so the rectangle's edge
  is visible at low zoom. It also shows clearly that most of the Republic of Ireland has no radar coverage.

## Open decisions

1. Basemap: decided and built. MapLibre + OpenFreeMap (`positron`, or `dark` when the system is in dark mode).
2. Model choice: UKV only, or a UKV/HARMONIE mix? DMI and KNMI HARMONIE publish 1–2 h sooner but run
   only every 3 h. Fresher runs may align better. Settle this with the verification mode.
3. Motion source: flow of the model's rain pattern versus the 700 hPa wind. Settle this with the
   verification mode too.
4. Later: compare against Rainbow.ai's AI nowcast. It would need a small Cloudflare Worker proxy.
5. Is Republic of Ireland coverage important? Its radar coverage is weak, and this method needs radar to warp.
