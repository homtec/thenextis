# TheNextIs

A user-friendly POI search and map explorer based on OpenStreetMap data.
Search for a category ("pharmacy", "bakery", …) or a place, click anything on the
map to see its details, and share links to places.

## Development

```
npm install   # first time only
npm run dev   # serves public/ at http://localhost:5173
npm run lint
```

There is no build step: `public/` is deployed as static files.

## Contributing

1. Fork it
2. Create your feature branch (`git checkout -b my-new-feature`)
3. Commit your changes (`git commit -am 'Add some feature'`)
4. Push to the branch (`git push origin my-new-feature`)
5. Create new Pull Request

## Software and data used

- [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) vector tiles
- [OpenStreetMap](https://www.openstreetmap.org/) data via the OSM API and [Overpass](https://overpass-api.de/)
- [Photon](https://photon.komoot.io/) for place search
- [opening_hours.js](https://github.com/opening-hours/opening_hours.js)
- [Mangrove](https://mangrove.reviews/) for reviews
- Bootstrap, Font Awesome
