# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

```
npm install       # first time only (installs eslint only)
npm run dev       # serves public/ at http://localhost:5173
```

No build step. JS deps (maplibre-gl, opening_hours) are loaded from CDN via import map.

## Architecture

TheNextIs is a single-page POI (Point of Interest) finder and map explorer using OpenStreetMap data. Everything is served as static files from `public/` (Cloudflare Pages: no build command, output directory `public`):

- **`public/index.html`** — Shell with the map container, search box, feature panel, and buttons. Loads CSS (MapLibre, Bootstrap 5, Font Awesome 4.7) from jsDelivr and JS deps via an import map from esm.sh.
- **`public/app/app.js`** — All application logic, loaded as an ES module. Uses MapLibre GL with the OpenFreeMap `liberty` vector style.
- **`public/app/app.css`** — App styles.
- **`public/content.json`** — The POI category database. Each entry has a key, an `osm` field (semicolon-separated OSM tag queries), and translations for `lang-en`, `lang-de`, `lang-es`, `lang-fr`, `lang-ru`.
- Other static assets: `favicon.ico`, `og_icon.png`, `app/images/` (all under `public/`).

### Data flow

1. On load, `init()` initializes the MapLibre map (from the URL hash or geolocation), fetches `content.json` via `loadPOIdataFromFile()`, and sets up the search box (`initGeocoder()`) and map feature clicks (`initFeatureClick()`).
2. **Search box**: empty input shows recent searches and all categories. Typed input shows matching categories from `content.json` (matched against all languages) plus place results from Photon (`photon.komoot.io`), biased towards the current map view.
3. **Category search**: `selectCategory()` → `loadPOIs()` builds an Overpass query from the entry's `osm` tags (split on `;`), either around the user's location or within the map bounds. Queries race several Overpass servers (`OVERPASS_SERVERS`, `fetchOverpass()`). Results are rendered as MapLibre markers and a GeoJSON polygon layer, and listed in the feature panel; the map fits to the nearest result.
4. **Feature details**: clicking a vector-tile feature or a search result opens the feature panel. Tags come from the OSM API by id, or from Overpass by name + location as a fallback, and are cached in `localStorage` (`osm_cache_*`). Opening hours are rendered via the `opening_hours` library.
5. The URL hash encodes map state as `#map=zoom/lat/lng` so links are shareable.

### Adding a new POI category

Add an entry to `public/content.json` with a unique key, the OSM tag(s) in `osm` (semicolons separate multiple tags that are OR'd together), and translations for each `lang-*` field. Then run `npm run taginfo` to regenerate `public/taginfo.json` (the project's [taginfo](https://taginfo.openstreetmap.org/projects) listing of used OSM tags).
