# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

```
npm install       # first time only
npm run dev       # dev server with HMR at http://localhost:5173
npm run build     # production build into dist/
npm run preview   # preview the production build locally
```

## Architecture

TheNextIs is a single-page POI (Point of Interest) finder using OpenStreetMap data. The entire app lives in three files:

- **`index.html`** — Shell with the map container, dropdown, and button elements.
- **`app/app.js`** — All application logic. Entry point for Vite. Imports Leaflet, Bootstrap 3, and Font Awesome from npm.
- **`public/content.json`** — The POI category database. Each entry has a key, an `osm` field (semicolon-separated OSM tag queries), and translations for `lang-en`, `lang-de`, `lang-es`, `lang-fr`, `lang-ru`.
- **`public/`** — Static assets served as-is: `content.json`, `favicon.ico`, `og_icon.png`, `app/images/`.

### Data flow

1. On load, `init()` runs: initializes the Leaflet map, sets up event listeners, fetches `content.json` via `loadPOIdataFromFile()`, and populates the `#mydropdown` select with localized labels.
2. When the user selects a POI type, `loadPOIs()` builds an Overpass API query from the selected entry's `osm` tags (split on `;`). It queries `https://z.overpass-api.de/api/interpreter`.
3. Results are rendered as Leaflet markers (nodes) and polygons (ways). The nearest result to the user's geolocation is used to auto-fit the map bounds.
4. The URL hash encodes map state as `#map=zoom/lat/lng` so links are shareable.

### Adding a new POI category

Add an entry to `content.json` with a unique key, the OSM tag(s) in `osm` (semicolons separate multiple tags that are OR'd together), and translations for each `lang-*` field.
