# RainRadar

A rain radar for the UK as an installable web app (PWA). It shows the Met Office 1 km radar with a
time slider, and a short-range forecast is planned.

- Live: deployed to GitHub Pages from `main`.
- Development notes, data sources and the forecast design are in [CLAUDE.md](CLAUDE.md).

```sh
npm install
npm run dev       # http://localhost:5173
npm test
npm run build && npm run preview
```

Radar data: © Crown copyright Met Office, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Basemap: [OpenFreeMap](https://openfreemap.org/) © OpenMapTiles, data © OpenStreetMap contributors.
