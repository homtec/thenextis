import maplibregl from 'maplibre-gl';
import OpeningHours from 'opening_hours';
import {
  LANG, PREFERRED_LANG, PHOTON_LANG, t, typeLabel,
  formatTime, formatWeekday, formatDate, formatNumber, formatDistance, translateDocument,
} from './i18n.js';

var map;
var poiMarkers = [];
// Current category search results by 'type/id', so markers and polygons can open them
var resultPois = new Map();
var myLocation = null;
var berlin = [13.4101340342265, 52.5213616409873]; // [lng, lat]

const CACHE_PREFIX = 'osm_cache_';

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (raw) {
      return JSON.parse(raw);
    }
    return null;
  } catch { return null; }
}

function cacheSet(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch (e) { console.warn('[cache] localStorage write failed:', e); }
}

// Like cacheGet/cacheSet, for data that goes stale (search results)
function cacheGetFresh(key, maxAgeMs) {
  const entry = cacheGet(key);
  return entry && Date.now() - entry.savedAt < maxAgeMs ? entry.value : null;
}

function cacheSetFresh(key, value) {
  cacheSet(key, { savedAt: Date.now(), value });
}

// Public servers are often overloaded (HTTP 504) or rate-limit (429); maps.mail.ru is
// slow but usually up, so it serves as the fallback in the race
const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Queries all servers at once and uses the first answer; the other requests are then
// cancelled so they don't keep loading the shared servers
function fetchOverpass(query) {
  const controllers = OVERPASS_SERVERS.map(() => new AbortController());
  const requests = OVERPASS_SERVERS.map((server, i) =>
    fetch(`${server}?data=${encodeURIComponent(query)}`, { signal: controllers[i].signal })
      .then(r => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      })
      .then(data => {
        controllers.forEach((c, j) => { if (j !== i) c.abort(); });
        return data;
      })
  );
  return Promise.any(requests);
}
var mapDragged = false;
var geolocateControl = null;
var searchResultMarker = null;
var selectedCategory = null;
var placeQuery = null; // active free-text place search (Enter in the search box)
var selectedCuisine = null; // active cuisine/diet search, a key of cuisines.json
var poiData = null;
var cuisineData = null;
var mapLoaded = false;
// The open POI or dropped pin, kept in the URL hash so links can be shared:
// 'poi=<osm type>/<osm id>' or 'pin=<lat>/<lng>'
var sharedSelection = null;
var sharedPoiRequestId = 0;
var locationRequestId = 0;

function initMap(center, zoom) {

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: center, // [lng, lat]
    zoom: zoom
  });

  // Zoom buttons for mouse users; touch devices pinch to zoom
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  }

  geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    fitBoundsOptions: { maxZoom: 16 },
  });
  map.addControl(geolocateControl, 'top-right');
  geolocateControl.on('geolocate', onLocationFound);
  geolocateControl.on('error', onLocationError);

  map.on('dragend', onMapDragged);
  map.on('zoomend', onMapZoomed);
  map.on('moveend', (e) => {
    // Only for moves by the user, not for fitBounds/flyTo after a search
    if (e.originalEvent) showRedoSearchButton();
  });

  map.on('load', () => {
    mapLoaded = true;

    // Empty GeoJSON source for POI polygons
    map.addSource('poi-polygons', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'poi-polygons-fill',
      type: 'fill',
      source: 'poi-polygons',
      paint: { 'fill-color': '#0057ff', 'fill-opacity': 0.2 }
    });
    map.addLayer({
      id: 'poi-polygons-outline',
      type: 'line',
      source: 'poi-polygons',
      paint: { 'line-color': '#0057ff', 'line-width': 2 }
    });

    map.on('click', 'poi-polygons-fill', (e) => {
      const result = resultPois.get(e.features[0]?.properties.ref);
      if (!result) return;
      revealAboveSheet(result.lngLat);
      openResultPoi(result.poi, result.lngLat);
    });
    map.on('mouseenter', 'poi-polygons-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'poi-polygons-fill', () => {
      map.getCanvas().style.cursor = '';
    });
  });
}


function loadPOIs(manualRefresh) {
  var i;
  var tags = getTag();
  if (tags === '') return;

  var OSM_PARAMS = "";
  var tag = tags.split(";");

  var bounds = map.getBounds();
  var southwest = bounds.getSouthWest();
  var northeast = bounds.getNorthEast();

  if (!manualRefresh && !mapDragged) {
    for (i in tag) {
      OSM_PARAMS += "way[" + tag[i] + "](around:2000," + myLocation.lat + "," + myLocation.lng + ");>;" +
        "node[" + tag[i] + "](around:2000," + myLocation.lat + "," + myLocation.lng + ");";
    }
    OSM_PARAMS = "(" + OSM_PARAMS + ");out;";
  } else {
    if (map.getZoom() < REDO_SEARCH_MIN_ZOOM) {
      alert(t('search.pleaseZoomIn'));
      return;
    }
    for (i in tag) {
      OSM_PARAMS += "way[" + tag[i] + "](" + southwest.lat + "," + southwest.lng + "," +
        northeast.lat + "," + northeast.lng + ");>;" +
        "node[" + tag[i] + "](" + southwest.lat + "," + southwest.lng + "," +
        northeast.lat + "," + northeast.lng + ");";
    }
    OSM_PARAMS = "(" + OSM_PARAMS + ");out;";
  }

  const fullQuery = '[out:json];' + OSM_PARAMS;

  hideRedoSearchButton();

  clearResults();

  const tagName = getTagName();
  setSelection(null);
  document.querySelector('#feature-panel-name').textContent = tagName;
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML =
    `<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i> ${escapeHtml(t('search.searchingFor', { query: tagName }))}</div>`;
  document.querySelector('#feature-panel').classList.add('visible');

  fetchOverpass(fullQuery)
    .then((data) => {

      var pois = data.elements;

      if (pois.length === 0) {
        document.querySelector('#feature-panel-details').innerHTML =
          `<div class="feature-detail-empty">${t('search.noResultsArea')}</div>`;
        return;
      }

      var polygonFeatures = [];
      var markerPositions = []; // [lng, lat] for fitBounds
      var resultItems = []; // for panel list

      for (let poi of pois) {
        if (poi.type === 'node' && typeof poi.tags !== 'undefined') {
          poiMarkers.push(addResultMarker(poi, [poi.lon, poi.lat]));
          markerPositions.push([poi.lon, poi.lat]);
          resultItems.push({ poi, lngLat: [poi.lon, poi.lat] });
        }

        if (poi.type === 'way' && typeof poi.tags !== 'undefined') {
          var coordinates = poi.nodes
            .map(nodeId => pois.find(n => n.id === nodeId))
            .filter(Boolean)
            .map(n => [n.lon, n.lat]);

          if (coordinates.length < 3) continue;

          polygonFeatures.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [coordinates] },
            properties: { ref: `${poi.type}/${poi.id}` }
          });

          var lngs = coordinates.map(c => c[0]);
          var lats = coordinates.map(c => c[1]);
          var centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
          var centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
          poiMarkers.push(addResultMarker(poi, [centerLng, centerLat]));
          markerPositions.push([centerLng, centerLat]);
          resultItems.push({ poi, lngLat: [centerLng, centerLat] });
        }
      }

      if (mapLoaded) {
        map.getSource('poi-polygons').setData({
          type: 'FeatureCollection',
          features: polygonFeatures
        });
      }

      // Render result list in panel
      document.querySelector('#feature-panel-type').textContent = t('search.results', { count: resultItems.length });
      const detailsEl = document.querySelector('#feature-panel-details');
      detailsEl.innerHTML = '';
      for (const { poi, lngLat } of resultItems) {
        const name = poi.tags.name || poi.tags.operator || poi.tags.brand || tagName;
        const street = [poi.tags['addr:housenumber'], poi.tags['addr:street']].filter(Boolean).join(' ');
        const detail = street || poi.tags.description || '';
        const row = document.createElement('div');
        row.className = 'poi-result-item';
        row.innerHTML = `<div class="poi-result-name">${escapeHtml(name)}</div>${detail ? `<div class="poi-result-detail">${escapeHtml(detail)}</div>` : ''}`;
        row.addEventListener('click', () => {
          map.flyTo({ center: lngLat, zoom: 18, offset: sheetOffset() });
          openResultPoi(poi, lngLat);
        });
        detailsEl.appendChild(row);
      }

      if (myLocation === null) return;

      // Find nearest result and fit bounds
      if (!manualRefresh && !mapDragged && markerPositions.length > 0) {
        var nearest = markerPositions.reduce((best, pos) => {
          var dx = pos[0] - myLocation.lng;
          var dy = pos[1] - myLocation.lat;
          var dist = dx * dx + dy * dy;
          var bestDx = best[0] - myLocation.lng;
          var bestDy = best[1] - myLocation.lat;
          return dist < bestDx * bestDx + bestDy * bestDy ? pos : best;
        });

        map.fitBounds([
          [Math.min(myLocation.lng, nearest[0]), Math.min(myLocation.lat, nearest[1])],
          [Math.max(myLocation.lng, nearest[0]), Math.max(myLocation.lat, nearest[1])]
        ], { padding: 50 });
      }
    })
    .catch((error) => {
      console.error('[overpass] all servers failed:', error);
      document.querySelector('#feature-panel-details').innerHTML =
        `<div class="feature-detail-empty">${t('search.failed')}</div>`;
    });
}


// Removes the markers and polygons of the previous category or place search
function clearResults() {
  poiMarkers.forEach(m => m.remove());
  poiMarkers = [];
  resultPois.clear();
  if (mapLoaded) {
    map.getSource('poi-polygons').setData({ type: 'FeatureCollection', features: [] });
  }
}

function addResultMarker(poi, lngLat) {
  resultPois.set(`${poi.type}/${poi.id}`, { poi, lngLat });
  const marker = new maplibregl.Marker()
    .setLngLat(lngLat)
    .addTo(map);
  const el = marker.getElement();
  el.style.cursor = 'pointer';
  el.addEventListener('click', (e) => {
    // Otherwise the map click handler looks up whatever tile feature is under the marker
    e.stopPropagation();
    revealAboveSheet(lngLat);
    openResultPoi(poi, lngLat);
  });
  return marker;
}

// Opens a category search result; its OSM type/id is already known, so no lookup by location
function openResultPoi(poi, lngLat) {
  const tagName = getTagName() || typeLabelFromTags(poi.tags);
  const poiName = poi.tags.name || poi.tags.operator || poi.tags.brand || tagName;
  setSelection(null);
  document.querySelector('#feature-panel-name').textContent = poiName;
  document.querySelector('#feature-panel-type').textContent = tagName;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');
  const place = { name: poiName, lngLat: { lng: lngLat[0], lat: lngLat[1] } };
  fetchOsmTagsByTypeAndId(poi.type, poi.id).then(result => {
    if (result) {
      renderOsmTags(result.tags, result.type, result.id, place);
    } else {
      renderOsmTags(poi.tags, poi.type, poi.id, place);
    }
  });
}

// The geolocate control draws the location dot and moves the map itself
function onLocationFound(position) {
  myLocation = {
    lat: position.coords.latitude,
    lng: position.coords.longitude
  };
  mapDragged = false;
  updateHashURL();
  showRedoSearchButton();
}

// Minimum zoom for searching the visible map area (see loadPOIs)
const REDO_SEARCH_MIN_ZOOM = 13;

// Offers to repeat the current category search after the map was moved
function showRedoSearchButton() {
  if (!selectedCategory && !placeQuery && !selectedCuisine) return;
  const button = document.querySelector('#redo-search-button');
  // Category searches query Overpass, which needs a small enough area
  const tooFar = !placeQuery && map.getZoom() < REDO_SEARCH_MIN_ZOOM;
  button.textContent = tooFar ? t('search.zoomIn') : t('search.thisArea');
  button.disabled = tooFar;
  button.classList.add('visible');
}

function hideRedoSearchButton() {
  document.querySelector('#redo-search-button').classList.remove('visible');
}

function onLocationError(error) {
  alert(error.message);
}

function onMapDragged() {
  mapDragged = true;
  updateHashURL();
}

function onMapZoomed() {
  updateHashURL();
}

// Name and "street, city, country" line for a Photon result
function photonLabel(p) {
  const streetWithNumber = p.street
    ? p.street + (p.housenumber ? ' ' + p.housenumber : '')
    : null;
  const name = p.name || streetWithNumber || p.city || '';
  const streetDetail = (p.name && streetWithNumber) ? streetWithNumber : null;
  const detail = [streetDetail, p.city, p.country].filter(Boolean).join(', ');
  return { name, detail };
}

const PLACE_SEARCH_LIMIT = 20;
const PLACE_SEARCH_NEARBY_KM = 50;
var placeSearchRequestId = 0;

// Free-text search ("pizza", "Rewe", "Hauptbahnhof"): all matching places as markers and
// a list in the sheet. inView restricts results to the visible map ("Search this area").
async function searchPlaces(query, inView) {
  const requestId = ++placeSearchRequestId;
  placeQuery = query;
  selectedCategory = null;
  selectedCuisine = null;
  hideRedoSearchButton();
  clearResults();
  setSelection(null);
  if (searchResultMarker) {
    searchResultMarker.remove();
    searchResultMarker = null;
  }

  document.querySelector('#feature-panel-name').textContent = query;
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML =
    `<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i> ${escapeHtml(t('search.searchingFor', { query }))}</div>`;
  document.querySelector('#feature-panel').classList.add('visible');

  const center = map.getCenter();
  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=${PLACE_SEARCH_LIMIT}&lang=${PHOTON_LANG}`;
  if (inView) {
    const b = map.getBounds();
    url += `&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  } else {
    url += `&lat=${center.lat}&lon=${center.lng}&zoom=${Math.round(map.getZoom())}&location_bias_scale=0.1`;
  }

  let features = [];
  try {
    const res = await fetch(url);
    if (res.ok) features = (await res.json()).features || [];
  } catch (e) { console.error('[photon] place search failed:', e); }
  if (requestId !== placeSearchRequestId || placeQuery !== query) return;

  // Prefer results around the current view; fall back to everything if none are close
  if (!inView) {
    const nearby = features.filter(f =>
      center.distanceTo(new maplibregl.LngLat(...f.geometry.coordinates)) < PLACE_SEARCH_NEARBY_KM * 1000);
    if (nearby.length) features = nearby;
  }

  const detailsEl = document.querySelector('#feature-panel-details');
  if (!features.length) {
    detailsEl.innerHTML = `<div class="feature-detail-empty">${t('search.noResults')}</div>`;
    return;
  }
  if (features.length === 1 && !inView) {
    openPlaceResult(features[0], true);
    return;
  }

  document.querySelector('#feature-panel-type').textContent = t('search.results', { count: features.length });
  detailsEl.innerHTML = '';
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of features) {
    const lngLat = feature.geometry.coordinates;
    bounds.extend(lngLat);

    const marker = new maplibregl.Marker().setLngLat(lngLat).addTo(map);
    const el = marker.getElement();
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaceResult(feature, false);
    });
    poiMarkers.push(marker);

    const { name, detail } = photonLabel(feature.properties);
    const row = document.createElement('div');
    row.className = 'poi-result-item';
    row.innerHTML = `<div class="poi-result-name">${escapeHtml(name)}</div>` +
      (detail ? `<div class="poi-result-detail">${escapeHtml(detail)}</div>` : '');
    row.addEventListener('click', () => openPlaceResult(feature, true));
    detailsEl.appendChild(row);
  }

  if (!inView) {
    // Keep the results clear of the search box and the sheet
    const mobile = window.innerWidth < SHEET_DESKTOP_MIN_WIDTH;
    const height = map.getContainer().clientHeight;
    map.fitBounds(bounds, {
      maxZoom: 16,
      padding: mobile
        ? { top: 80, bottom: height * SHEET_MAX_HEIGHT_RATIO + 20, left: 40, right: 40 }
        : { top: 80, bottom: 40, left: 380, right: 40 },
    });
  }
}

// Opens one place search result; fly moves the map to it, otherwise it only stays visible
function openPlaceResult(feature, fly) {
  const [lng, lat] = feature.geometry.coordinates;
  if (fly) {
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 17), offset: sheetOffset() });
  } else {
    revealAboveSheet([lng, lat]);
  }

  if (searchResultMarker) searchResultMarker.remove();
  searchResultMarker = new maplibregl.Marker({ color: '#e53e3e' })
    .setLngLat([lng, lat])
    .addTo(map);

  showGeocoderFeatureDetail(feature.properties, { lat, lng });
}

// Category name from content.json: the user's own language if translated there (it has
// more languages than the UI), else the UI language, else English
function categoryLabel(category) {
  return category[`lang-${PREFERRED_LANG}`] || category[`lang-${LANG}`] || category['lang-en'];
}

function cuisineLabel(id) {
  const labels = cuisineData?.[id]?.labels || {};
  return labels[PREFERRED_LANG] || labels[LANG] || labels.en || id;
}

// Overpass query for a cuisines.json entry within bbox. Regex filters are slow on their
// own (no index), so first select everything with the key in the area into a named set,
// then apply the regex to that set: ~1 s instead of timeouts. The named sets must be
// built outside the union, or the union would output them too.
function cuisineQuery(entry, bbox) {
  const sets = [];
  const union = [];
  if (entry.cuisine) {
    // The regex also matches multi-value tags, e.g. cuisine=greek;mediterranean
    sets.push(`nwr["cuisine"](${bbox})->.c;`);
    union.push(`nwr.c["cuisine"~"(^|;)(${entry.cuisine.join('|')})(;|$)"];`);
  }
  if (entry.diet) {
    sets.push(`nwr["diet:${entry.diet}"](${bbox})->.d;`);
    union.push(`nwr.d["diet:${entry.diet}"~"^(yes|only)$"]["amenity"~"^(restaurant|fast_food|cafe|ice_cream|food_court|biergarten|pub|bar)$"];`);
  }
  for (const amenity of entry.amenity || []) union.push(`nwr["amenity"="${amenity}"](${bbox});`);
  return `[out:json][timeout:25];${sets.join('')}(${union.join('')});out center tags;`;
}

const CUISINE_SEARCH_RADIUS_M = 2000;
const CUISINE_FIT_RESULTS = 5;
const CUISINE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var cuisineSearchRequestId = 0;

// Restaurants etc. by cuisine or diet ("griechisch", "Döner", "vegan"), ranked by open now,
// then distance. Like category searches it starts around the user's location and searches
// the visible map after the map was moved (manualRefresh / "Search this area").
async function searchCuisine(id, manualRefresh) {
  const entry = cuisineData?.[id];
  if (!entry) return;
  const useLocation = !manualRefresh && !mapDragged && myLocation;
  if (!useLocation && map.getZoom() < REDO_SEARCH_MIN_ZOOM) {
    alert(t('search.pleaseZoomIn'));
    return;
  }

  const requestId = ++cuisineSearchRequestId;
  selectedCuisine = id;
  selectedCategory = null;
  placeQuery = null;
  hideRedoSearchButton();
  clearResults();
  setSelection(null);
  if (searchResultMarker) {
    searchResultMarker.remove();
    searchResultMarker = null;
  }

  const label = cuisineLabel(id);
  document.querySelector('#feature-panel-name').textContent = label;
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML =
    `<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i> ${escapeHtml(t('search.searchingFor', { query: label }))}</div>`;
  document.querySelector('#feature-panel').classList.add('visible');

  // A box rather than a radius: Overpass answers bbox queries faster. Rounded to ~100 m
  // so repeated searches of the same area hit the cache.
  const bounds = useLocation
    ? new maplibregl.LngLat(myLocation.lng, myLocation.lat).toBounds(CUISINE_SEARCH_RADIUS_M)
    : map.getBounds();
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map(v => v.toFixed(3)).join(',');
  const query = cuisineQuery(entry, bbox);
  const cacheKey = `cuisine_${id}_${bbox}`;

  let elements = cacheGetFresh(cacheKey, CUISINE_CACHE_MAX_AGE_MS);
  try {
    if (!elements) {
      elements = (await fetchOverpass(query)).elements || [];
      cacheSetFresh(cacheKey, elements);
    }
  } catch (e) {
    console.error('[overpass] cuisine search failed:', e);
    if (requestId === cuisineSearchRequestId) {
      document.querySelector('#feature-panel-details').innerHTML =
        `<div class="feature-detail-empty">${t('search.failed')}</div>`;
    }
    return;
  }
  if (requestId !== cuisineSearchRequestId || selectedCuisine !== id) return;

  const origin = myLocation
    ? new maplibregl.LngLat(myLocation.lng, myLocation.lat)
    : map.getCenter();
  const now = new Date();
  const results = elements
    .map(el => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat === undefined || !el.tags) return null;
      const lngLat = [lng, lat];
      return {
        poi: { type: el.type, id: el.id, tags: el.tags },
        lngLat,
        distance: origin.distanceTo(new maplibregl.LngLat(lng, lat)),
        status: openingStatus(el.tags.opening_hours, now),
      };
    })
    .filter(Boolean)
    // Open now first, then places without opening hours, then closed ones; nearest first
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.distance - b.distance);

  const detailsEl = document.querySelector('#feature-panel-details');
  if (!results.length) {
    detailsEl.innerHTML = `<div class="feature-detail-empty">${t('search.noResultsArea')}</div>`;
    return;
  }

  document.querySelector('#feature-panel-type').textContent = t('search.results', { count: results.length });
  detailsEl.innerHTML = '';
  for (const { poi, lngLat, distance, status } of results) {
    poiMarkers.push(addResultMarker(poi, lngLat));

    const name = poi.tags.name || poi.tags.brand || typeLabelFromTags(poi.tags);
    const statusHtml = status ? `<span class="${status.cls}">${escapeHtml(status.text)}</span> · ` : '';
    const row = document.createElement('div');
    row.className = 'poi-result-item';
    row.innerHTML = `<div class="poi-result-name">${escapeHtml(name)}</div>
      <div class="poi-result-detail">${statusHtml}${escapeHtml(formatDistance(distance))}</div>`;
    row.addEventListener('click', () => {
      map.flyTo({ center: lngLat, zoom: 18, offset: sheetOffset() });
      openResultPoi(poi, lngLat);
    });
    detailsEl.appendChild(row);
  }

  if (useLocation) {
    // Show the user and the best few results, clear of the search box and the sheet
    const bounds = new maplibregl.LngLatBounds([myLocation.lng, myLocation.lat], [myLocation.lng, myLocation.lat]);
    results.slice(0, CUISINE_FIT_RESULTS).forEach(r => bounds.extend(r.lngLat));
    const mobile = window.innerWidth < SHEET_DESKTOP_MIN_WIDTH;
    const height = map.getContainer().clientHeight;
    map.fitBounds(bounds, {
      maxZoom: 16,
      padding: mobile
        ? { top: 80, bottom: height * SHEET_MAX_HEIGHT_RATIO + 20, left: 40, right: 40 }
        : { top: 80, bottom: 40, left: 380, right: 40 },
    });
  }
}

// Sort order for openingStatus(): open, unknown (no hours), closed
function statusRank(status) {
  if (!status) return 1;
  return status.open ? 0 : 2;
}

function getTagName() {
  if (!selectedCategory || !poiData?.[selectedCategory]) return '';
  return categoryLabel(poiData[selectedCategory]) || '';
}

function getTag() {
  if (!selectedCategory || !poiData?.[selectedCategory]) return '';
  return poiData[selectedCategory].osm || '';
}

function selectCategory(key) {
  selectedCategory = key;
  placeQuery = null;
  selectedCuisine = null;
  const label = (poiData[key] && categoryLabel(poiData[key])) || key;
  const input = document.querySelector('#geocoder-input');
  const clearIcon = document.querySelector('#geocoder-clear-icon');
  input.value = label;
  clearIcon.style.display = 'block';
  loadPOIs();
}

const RECENT_SEARCHES_KEY = 'recent_searches';

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]'); } catch { return []; }
}

function addRecentSearch(item) {
  const list = getRecentSearches().filter(s => s.name !== item.name);
  list.unshift(item);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, 5)));
}


function init() {
  translateDocument();

  const params = parseHash();
  const url_location = parseMapParam(params.map);

  var startCenter = berlin;
  var startzoom = 3;

  if (url_location) {
    startCenter = url_location.center;
    startzoom = url_location.zoom;
    mapDragged = true;
  }

  initMap(startCenter, startzoom);

  if (!url_location && !params.poi && !params.pin) {
    locateMe();
  }

  loadPOIdataFromFile();

  document.querySelector('#info-button').onclick = function () { showInfo(); };
  document.querySelector('#redo-search-button').onclick = function () {
    if (placeQuery) searchPlaces(placeQuery, true);
    else if (selectedCuisine) searchCuisine(selectedCuisine, true);
    else loadPOIs(true);
  };
  document.querySelector('#editOSM-button').onclick = function () { editOSM(); };

  initGeocoder();

  document.querySelector('#feature-panel-share').addEventListener('click', shareSelection);
  openSharedSelection(params, !url_location);
  window.addEventListener('hashchange', () => {
    // A pasted link in the same tab: reapply its map position and selection
    const next = parseHash();
    const loc = parseMapParam(next.map);
    if (loc) map.jumpTo({ center: loc.center, zoom: loc.zoom });
    openSharedSelection(next, !loc);
  });

  map.on('load', () => {
    initFeatureClick();
  });
}

function parseHash() {
  const params = {};
  for (const param of window.location.hash.replace('#', '').split('&')) {
    const [key, value] = param.split('=');
    if (key && value) params[key] = decodeURIComponent(value);
  }
  return params;
}

// 'zoom/lat/lng' → { center: [lng, lat], zoom }
function parseMapParam(value) {
  const [zoom, lat, lng] = (value || '').split('/').map(parseFloat);
  if ([zoom, lat, lng].some(isNaN)) return null;
  return { center: [lng, lat], zoom };
}

function openSharedSelection(params, flyToIt) {
  if (params.poi) {
    const [type, id] = params.poi.split('/');
    if (['node', 'way', 'relation'].includes(type) && /^\d+$/.test(id)) {
      showSharedPoi(type, id, flyToIt);
    }
  } else if (params.pin) {
    const [lat, lng] = params.pin.split('/').map(parseFloat);
    if (!isNaN(lat) && !isNaN(lng)) {
      if (flyToIt) map.jumpTo({ center: [lng, lat], zoom: 17 });
      showLocationDetail({ lat, lng });
    }
  }
}

// Tag keys that say what kind of place an OSM object is, in priority order
const TYPE_TAG_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'sport', 'craft', 'office',
  'healthcare', 'historic', 'public_transport', 'railway', 'highway', 'building'];

function typeLabelFromTags(tags) {
  const key = TYPE_TAG_KEYS.find(k => tags[k] && tags[k] !== 'yes');
  return typeLabel(key && tags[key]);
}


async function showSharedPoi(osmType, osmId, flyToIt) {
  const requestId = ++sharedPoiRequestId;
  const selection = `poi=${osmType}/${osmId}`;
  setSelection(selection);
  document.querySelector('#feature-panel-name').textContent = '';
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  const el = await fetchOsmElementWithCenter(osmType, osmId);
  // Stale if another shared link was opened, or anything else was opened/closed meanwhile
  if (requestId !== sharedPoiRequestId || sharedSelection !== selection) return;

  if (!el) {
    setSelection(null);
    document.querySelector('#feature-panel-name').textContent = t('place.notFound');
    document.querySelector('#feature-panel-details').innerHTML =
      `<div class="feature-detail-empty">${t('place.deleted')}</div>`;
    return;
  }

  const { tags, lat, lng } = el;
  const name = tags.name || tags.brand || tags.operator || typeLabelFromTags(tags);
  document.querySelector('#feature-panel-name').textContent = name;
  document.querySelector('#feature-panel-type').textContent = typeLabelFromTags(tags);

  if (searchResultMarker) searchResultMarker.remove();
  searchResultMarker = new maplibregl.Marker({ color: '#e53e3e' })
    .setLngLat([lng, lat])
    .addTo(map);
  if (flyToIt) map.jumpTo({ center: [lng, lat], zoom: 18 });
  revealAboveSheet([lng, lat]);

  renderOsmTags(tags, osmType, osmId, { name, lngLat: { lat, lng } });
}

function setSelection(selection) {
  sharedSelection = selection;
  document.querySelector('#feature-panel-share').style.display = selection ? '' : 'none';
  if (map) updateHashURL();
}

function shareSelection() {
  const url = window.location.href;
  const title = document.querySelector('#feature-panel-name').textContent;
  const button = document.querySelector('#feature-panel-share');
  const confirmCopied = () => {
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1200);
  };

  if (navigator.share) {
    navigator.share({ title, url }).catch(err => {
      if (err.name !== 'AbortError') console.warn('[share] share failed:', err);
    });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(confirmCopied)
      .catch(() => window.prompt(t('share.copyPrompt'), url));
  } else {
    // Clipboard API is unavailable on insecure (http) origins
    window.prompt(t('share.copyPrompt'), url);
  }
}

function locateMe() {
  if (map.loaded()) {
    geolocateControl.trigger();
  } else {
    map.once('load', () => geolocateControl.trigger());
  }
}

function showInfo() {
  setSelection(null);
  document.querySelector('#feature-panel-name').textContent = t('info.title');
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML = `
    <div class="feature-detail-row">
      <span class="feature-detail-value">${t('info.intro')}</span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">${t('info.source')}</span>
      <span class="feature-detail-value"><a href="https://www.openstreetmap.org" target="_blank" rel="nofollow">OpenStreetMap</a></span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">${t('info.code')}</span>
      <span class="feature-detail-value"><a href="https://github.com/homtec/thenextis/" target="_blank" rel="nofollow">${t('info.contribute')}</a></span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">${t('info.follow')}</span>
      <span class="feature-detail-value">
        <a href="https://twitter.com/thenextis" target="_blank" rel="nofollow"><i class="fa fa-twitter"></i> Twitter</a>
        &nbsp;&nbsp;
        <a href="https://www.facebook.com/Thenextis" target="_blank" rel="nofollow"><i class="fa fa-facebook-square"></i> Facebook</a>
      </span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">${t('info.mapData')}</span>
      <span class="feature-detail-value">${t('info.missingPlace')} <a href="#" id="info-edit-osm-link">${t('info.addInOsm')}</a></span>
    </div>
  `;
  document.querySelector('#feature-panel').classList.add('visible');
  document.querySelector('#info-edit-osm-link').addEventListener('click', (e) => {
    e.preventDefault();
    editOSM();
  });
}

function editOSM() {
  var center = map.getCenter();
  var z = map.getZoom();
  window.open('https://www.openstreetmap.org/edit?' + 'zoom=' + z +
    '&editor=id' + '&lat=' + center.lat + '&lon=' + center.lng);
}



function updateHashURL() {
  var center = map.getCenter();
  var urlhash_location = "map=" + map.getZoom().toFixed(0) + '/' +
    center.lat.toFixed(5) + '/' + center.lng.toFixed(5);
  if (sharedSelection) urlhash_location += '&' + sharedSelection;
  history.replaceState(null, null, window.location.origin + "/#" + urlhash_location);
}

function loadPOIdataFromFile() {
  fetch("content.json")
    .then((response) => response.json())
    .then((data) => { poiData = data; });
  fetch("cuisines.json")
    .then((response) => response.json())
    .then((data) => { cuisineData = data; });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


// Source layers to consider for feature clicks, in priority order
const SOURCE_LAYER_ORDER = ['poi', 'place', 'building', 'park', 'landuse', 'water', 'waterway'];

function selectFeature(features) {
  const external = features.filter(f =>
    !['poi-polygons-fill', 'poi-polygons-outline'].includes(f.layer.id)
  );

  for (const sl of SOURCE_LAYER_ORDER) {
    const f = external.find(f => f.sourceLayer === sl);
    if (f) return f;
  }

  return external.find(f => f.properties?.name) || null;
}

function formatFeatureType(feature) {
  const p = feature.properties;
  return typeLabel(p.subclass || p.class || feature.sourceLayer);
}

function initFeatureClick() {
  map.on('mousemove', (e) => {
    const features = map.queryRenderedFeatures(e.point);
    const hit = selectFeature(features);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  });

  map.on('click', (e) => {
    // A long-press can be followed by a synthetic click; don't let it close the panel
    if (Date.now() - lastLongPressAt < LONG_PRESS_CLICK_GUARD_MS) return;
    if (map.queryRenderedFeatures(e.point, { layers: ['poi-polygons-fill'] }).length) return;

    const features = map.queryRenderedFeatures(e.point);
    const feature = selectFeature(features);
    if (feature) {
      showFeatureDetail(feature, e.lngLat);
    } else {
      hideFeatureDetail();
    }
  });

  document.querySelector('#feature-panel-close').addEventListener('click', hideFeatureDetail);

  initLongPress();
  initSheetDrag();
}

const SHEET_DESKTOP_MIN_WIDTH = 768;
const SHEET_SNAP_THRESHOLD_PX = 60;
const SHEET_MAX_HEIGHT_RATIO = 0.55; // #feature-panel max-height: 55vh
const SHEET_REVEAL_MARGIN_PX = 60;   // room for the marker above the sheet top

// Lowest screen y where a selected point stays visible above the mobile sheet,
// or null on desktop where the panel is at the side
function sheetRevealY() {
  if (window.innerWidth >= SHEET_DESKTOP_MIN_WIDTH) return null;
  const height = map.getContainer().clientHeight;
  return height * (1 - SHEET_MAX_HEIGHT_RATIO) - SHEET_REVEAL_MARGIN_PX;
}

// flyTo offset that lands the target just above the mobile sheet instead of mid-screen
function sheetOffset() {
  const y = sheetRevealY();
  if (y === null) return [0, 0];
  return [0, Math.min(0, y - map.getContainer().clientHeight / 2)];
}

// Pans the map up if the point would be covered by the mobile sheet. Skipped while
// the camera is already moving (e.g. a flyTo that targets the point with sheetOffset)
function revealAboveSheet(lngLat) {
  const y = sheetRevealY();
  if (y === null || map.isMoving()) return;
  const point = map.project(lngLat);
  if (point.y > y) map.panBy([0, point.y - y]);
}

// Mobile bottom sheet: dragging anywhere on the sheet moves it (up to expand, down to
// collapse or close). Inside the details list, the list scrolls natively instead when it
// can: while expanded, or while dragging down with the list not at its top.
function initSheetDrag() {
  const panel = document.querySelector('#feature-panel');
  const details = document.querySelector('#feature-panel-details');
  let startY = null;
  let startHeight = 0;
  let dy = 0;
  let mode = null; // null (undecided) | 'sheet' | 'scroll'

  panel.addEventListener('touchstart', (e) => {
    if (window.innerWidth >= SHEET_DESKTOP_MIN_WIDTH || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    startHeight = panel.getBoundingClientRect().height;
    dy = 0;
    mode = null;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dy = e.touches[0].clientY - startY;
    if (mode === null) {
      if (Math.abs(dy) < 4) return;
      const inList = details.contains(e.target);
      const canScroll = details.scrollHeight > details.clientHeight;
      const expanded = panel.classList.contains('expanded');
      const listScrolls = inList && canScroll &&
        (dy < 0 ? expanded : details.scrollTop > 0);
      mode = listScrolls ? 'scroll' : 'sheet';
      if (mode === 'sheet') {
        panel.classList.add('dragging');
        startY = e.touches[0].clientY;
        dy = 0;
      }
    }
    if (mode !== 'sheet') return;
    e.preventDefault();
    if (dy > 0) {
      panel.style.transform = `translateY(${dy}px)`;
      panel.style.height = '';
      panel.style.maxHeight = '';
    } else {
      panel.style.transform = 'translateY(0)';
      panel.style.maxHeight = 'none';
      panel.style.height = `${Math.min(startHeight - dy, window.innerHeight - 70)}px`;
    }
  }, { passive: false });

  const onEnd = () => {
    if (startY === null) return;
    const wasSheet = mode === 'sheet';
    startY = null;
    mode = null;
    if (!wasSheet) return;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    panel.style.height = '';
    panel.style.maxHeight = '';
    if (dy < -SHEET_SNAP_THRESHOLD_PX) {
      panel.classList.add('expanded');
    } else if (dy > SHEET_SNAP_THRESHOLD_PX) {
      if (panel.classList.contains('expanded')) {
        panel.classList.remove('expanded');
      } else {
        hideFeatureDetail();
      }
    }
  };
  panel.addEventListener('touchend', onEnd);
  panel.addEventListener('touchcancel', onEnd);
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const LONG_PRESS_CLICK_GUARD_MS = 800;
var lastLongPressAt = 0;

function initLongPress() {
  let timer = null;
  let startPoint = null;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  map.on('touchstart', (e) => {
    cancel();
    if (e.originalEvent.touches.length !== 1) return;
    startPoint = e.point;
    const lngLat = e.lngLat;
    timer = setTimeout(() => {
      timer = null;
      lastLongPressAt = Date.now();
      showLocationDetail(lngLat);
    }, LONG_PRESS_MS);
  });

  map.on('touchmove', (e) => {
    if (!timer) return;
    if (e.originalEvent.touches.length !== 1 ||
        e.point.dist(startPoint) > LONG_PRESS_MOVE_TOLERANCE_PX) {
      cancel();
    }
  });
  map.on('touchend', cancel);
  map.on('touchcancel', cancel);

  // Desktop: right-click. Android also fires contextmenu on long-press, so skip it
  // when the touch timer has just handled the same gesture.
  map.on('contextmenu', (e) => {
    e.preventDefault();
    if (Date.now() - lastLongPressAt < LONG_PRESS_CLICK_GUARD_MS) return;
    showLocationDetail(e.lngLat);
  });
}

function showLocationDetail(lngLat) {
  const { lat, lng } = lngLat;
  const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const requestId = ++locationRequestId;

  if (searchResultMarker) searchResultMarker.remove();
  searchResultMarker = new maplibregl.Marker({ color: '#e53e3e' })
    .setLngLat([lng, lat])
    .addTo(map);

  setSelection(`pin=${lat.toFixed(6)}/${lng.toFixed(6)}`);
  revealAboveSheet([lng, lat]);
  document.querySelector('#feature-panel-name').textContent = t('pin.title');
  document.querySelector('#feature-panel-type').textContent = coords;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  reverseGeocode(lat, lng).then(props => {
    // Ignore stale responses if another pin was dropped meanwhile
    if (requestId !== locationRequestId) return;

    let html = '';
    if (props) {
      const street = props.street
        ? props.street + (props.housenumber ? ' ' + props.housenumber : '')
        : null;
      const locality = [props.postcode, props.city || props.town || props.village].filter(Boolean).join(' ');
      const address = [street, locality, props.country].filter(Boolean).join(', ');
      if (props.name && props.name !== props.street) {
        document.querySelector('#feature-panel-name').textContent = props.name;
      } else if (street) {
        document.querySelector('#feature-panel-name').textContent = street;
      }
      if (address) {
        html += `<div class="feature-detail-row">
          <span class="feature-detail-label">${t('label.address')}</span>
          <span class="feature-detail-value">${escapeHtml(address)}</span>
        </div>`;
      }
    }

    html += `<div class="feature-detail-row">
      <span class="feature-detail-label">${t('label.coordinates')}</span>
      <span class="feature-detail-value"><a href="#" id="location-copy-coords" title="${escapeHtml(t('pin.copy'))}">${coords}</a></span>
    </div>`;
    html += `<a class="feature-detail-osm-link"
      href="https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=18/${lat.toFixed(6)}/${lng.toFixed(6)}"
      target="_blank" rel="nofollow">${t('place.viewOnOsm')}</a>`;

    document.querySelector('#feature-panel-details').innerHTML = html;
    const copyLink = document.querySelector('#location-copy-coords');
    copyLink.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard?.writeText(coords).then(() => {
        copyLink.textContent = t('pin.copied');
        setTimeout(() => { copyLink.textContent = coords; }, 1200);
      }).catch(err => console.warn('[location] copy failed:', err));
    });
  });
}

async function reverseGeocode(lat, lng) {
  const cacheKey = `rev_${lat.toFixed(5)}_${lng.toFixed(5)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=${PHOTON_LANG}`);
    if (res.ok) {
      const data = await res.json();
      const props = data.features?.[0]?.properties || null;
      if (props) cacheSet(cacheKey, props);
      return props;
    }
  } catch (e) { console.error('[photon] reverse geocode failed:', e); }
  return null;
}

function showFeatureDetail(feature, lngLat) {
  const props = feature.properties;
  const name = props.name || props.name_en || formatFeatureType(feature);
  const type = formatFeatureType(feature);

  setSelection(null);
  revealAboveSheet(lngLat);
  document.querySelector('#feature-panel-name').textContent = name;
  document.querySelector('#feature-panel-type').textContent = type;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  const osmRef = osmRefFromFeatureId(feature.id);

  const resolve = osmRef
    ? fetchOsmTagsByTypeAndId(osmRef.type, osmRef.id)
    : fetchOsmTagsByLocation(name, lngLat);

  resolve.then(result => {
    if (result) {
      renderOsmTags(result.tags, result.type, result.id, { name, lngLat });
    } else {
      document.querySelector('#feature-panel-details').innerHTML =
        `<div class="feature-detail-empty">${t('place.noDetails')}</div>`;
    }
  });
}

function hideFeatureDetail() {
  setSelection(null);
  document.querySelector('#feature-panel').classList.remove('visible', 'expanded');
  if (searchResultMarker) {
    searchResultMarker.remove();
    searchResultMarker = null;
  }
}

// OpenMapTiles tiles built with Planetiler (OpenFreeMap) encode the OSM element in the
// feature id as osm_id * 10 + (1 = node, 2 = way, 3 = relation)
function osmRefFromFeatureId(featureId) {
  if (typeof featureId !== 'number' || featureId <= 0) return null;
  const type = ['node', 'way', 'relation'][featureId % 10 - 1];
  return type ? { type, id: Math.floor(featureId / 10) } : null;
}

async function fetchOsmTagsByTypeAndId(osmType, osmId) {
  const typeMap = { N: 'node', W: 'way', R: 'relation' };
  const type = typeMap[osmType] || osmType.toLowerCase();
  const cacheKey = `${type}_${osmId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.openstreetmap.org/api/0.6/${type}/${osmId}.json`);
    if (res.ok) {
      const data = await res.json();
      if (data.elements?.length) {
        const result = { tags: data.elements[0].tags || {}, type, id: osmId };
        cacheSet(cacheKey, result);
        return result;
      }
    }
  } catch (e) { console.error('[osm] fetchOsmTagsByTypeAndId failed:', e); }
  return null;
}

// Tags plus a position for an OSM object. Nodes and ways come from the OSM API,
// which answers much faster than Overpass; relations need Overpass to get a center.
async function fetchOsmElementWithCenter(osmType, osmId) {
  const cacheKey = `center_${osmType}_${osmId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let result = null;
  try {
    if (osmType === 'node' || osmType === 'way') {
      const suffix = osmType === 'way' ? '/full' : '';
      const res = await fetch(`https://api.openstreetmap.org/api/0.6/${osmType}/${osmId}${suffix}.json`);
      if (res.ok) {
        const elements = (await res.json()).elements || [];
        const el = elements.find(e => e.type === osmType && String(e.id) === String(osmId));
        const nodes = elements.filter(e => e.type === 'node');
        if (el && nodes.length) {
          // Center of the bounding box, like Overpass 'out center'
          const lats = nodes.map(n => n.lat), lngs = nodes.map(n => n.lon);
          result = {
            tags: el.tags || {},
            lat: (Math.min(...lats) + Math.max(...lats)) / 2,
            lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
          };
        }
      }
    } else {
      const data = await fetchOverpass(`[out:json][timeout:10];${osmType}(${osmId});out center;`);
      const el = data.elements?.[0];
      if (el?.center) result = { tags: el.tags || {}, lat: el.center.lat, lng: el.center.lon };
    }
  } catch (e) { console.error('[share] loading shared POI failed:', e); }

  if (result) cacheSet(cacheKey, result);
  return result;
}

function showGeocoderFeatureDetail(props, lngLat) {
  const streetWithNumber = props.street
    ? props.street + (props.housenumber ? ' ' + props.housenumber : '')
    : null;
  const name = props.name || streetWithNumber || props.city || '';
  const streetDetail = (props.name && streetWithNumber) ? streetWithNumber : null;
  const type = typeLabel(props.type || props.osm_value);

  setSelection(null);
  document.querySelector('#feature-panel-name').textContent = name;
  document.querySelector('#feature-panel-type').textContent =
    [streetDetail, props.city, props.country].filter(Boolean).join(', ') || type;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  const resolve = (props.osm_id && props.osm_type)
    ? fetchOsmTagsByTypeAndId(props.osm_type, props.osm_id)
    : fetchOsmTagsByLocation(name, lngLat);

  resolve.then(result => {
    if (result) {
      renderOsmTags(result.tags, result.type, result.id, { name, lngLat });
    } else {
      document.querySelector('#feature-panel-details').innerHTML =
        `<div class="feature-detail-empty">${t('place.noDetails')}</div>`;
    }
  });
}

async function fetchOsmTagsByLocation(name, lngLat) {
  const { lat, lng } = lngLat;
  const cacheKey = `loc_${name}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const safeName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const query = `[out:json][timeout:10];(node["name"="${safeName}"](around:25,${lat},${lng});way["name"="${safeName}"](around:25,${lat},${lng}););out tags;`;

  try {
    const data = await fetchOverpass(query);
    if (data.elements?.length) {
      const el = data.elements[0];
      const result = { tags: el.tags || {}, type: el.type, id: el.id };
      cacheSet(cacheKey, result);
      return result;
    }
  } catch (e) { console.error('[osm] fetchOsmTagsByLocation failed:', e); }
  return null;
}

// tagKey 'collection_times' parses the value as points in time (post box collections)
function parseOpeningHours(ohStr, tagKey = 'opening_hours') {
  try {
    return new OpeningHours(ohStr, null, { tag_key: tagKey });
  } catch (e) {
    console.warn('[oh] failed to parse opening hours:', e);
    return null;
  }
}

// { open, cls, text } for an opening_hours value at `now`, or null if missing/unparseable
function openingStatus(ohStr, now = new Date()) {
  const oh = ohStr && parseOpeningHours(ohStr);
  return oh ? openingStatusOf(oh, now) : null;
}

function openingStatusOf(oh, now) {
  const isOpen = oh.getState(now);
  const isUnknown = oh.getUnknown(now); // true for open-end (+) intervals
  const nextChange = oh.getNextChange(now);

  // Status line
  let statusClass, statusText;

  if (isOpen || isUnknown) {
    if (isUnknown) {
      statusClass = 'oh-open';
      statusText = t('oh.open');
    } else if (nextChange && (nextChange - now) < 30 * 60 * 1000) {
      statusClass = 'oh-closing-soon';
      statusText = t('oh.closingSoon', { time: formatTime(nextChange) });
    } else {
      statusClass = 'oh-open';
      statusText = nextChange ? t('oh.openUntil', { time: formatTime(nextChange) }) : t('oh.open');
    }
  } else {
    statusClass = 'oh-closed';
    if (nextChange) {
      const sameDay = nextChange.toDateString() === now.toDateString();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const nextDayTomorrow = nextChange.toDateString() === tomorrow.toDateString();
      const time = formatTime(nextChange);
      if (sameDay) {
        statusText = t('oh.opensAt', { time });
      } else if (nextDayTomorrow) {
        statusText = t('oh.opensTomorrow', { time });
      } else {
        statusText = t('oh.opensOnDay', { day: formatWeekday(nextChange), time });
      }
    } else {
      statusText = t('oh.closed');
    }
  }
  return { open: isOpen || isUnknown, cls: statusClass, text: statusText };
}

function renderOpeningHours(ohStr) {
  const oh = parseOpeningHours(ohStr);
  if (!oh) return `<span>${escapeHtml(ohStr)}</span>`;

  const now = new Date();
  const { cls: statusClass, text: statusText } = openingStatusOf(oh, now);
  const rows = weekTableRows(oh, now, intervals => intervals.length
    ? intervals.map(([s, e]) => `${formatTime(s)}–${formatTime(e)}`).join(', ')
    : t('oh.closed'));

  return `<div class="oh-container">
    <div class="oh-status ${statusClass}">
      <span class="oh-dot"></span>
      <span>${statusText}</span>
    </div>
    ${weekTableDetails(t('oh.allTimes'), rows)}
  </div>`;
}

// Post box collection_times: next collection plus the weekly times
function renderCollectionTimes(ctStr) {
  const oh = parseOpeningHours(ctStr, 'collection_times');
  if (!oh) return `<span>${escapeHtml(ctStr)}</span>`;

  const now = new Date();
  const next = oh.getNextChange(now);
  let nextText = escapeHtml(ctStr);
  if (next) {
    const time = formatTime(next);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (next.toDateString() === now.toDateString()) {
      nextText = t('ct.nextToday', { time });
    } else if (next.toDateString() === tomorrow.toDateString()) {
      nextText = t('ct.nextTomorrow', { time });
    } else {
      nextText = t('ct.nextOnDay', { day: formatWeekday(next), time });
    }
  }
  // Each collection is a one-minute interval; show its start time
  const rows = weekTableRows(oh, now, intervals => intervals.length
    ? intervals.map(([s]) => formatTime(s)).join(', ')
    : '–');

  return `<div class="oh-container">
    <div class="oh-status ct-next">
      <i class="fa fa-envelope-o"></i>
      <span>${nextText}</span>
    </div>
    ${weekTableDetails(t('ct.allTimes'), rows)}
  </div>`;
}

// One table row per day of the current week (Mon–Sun); formatIntervals turns that
// day's intervals into the cell text
function weekTableRows(oh, now, formatIntervals) {
  const weekStart = new Date(now);
  const dayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
  weekStart.setDate(now.getDate() + dayOffset);
  weekStart.setHours(0, 0, 0, 0);

  let rows = '';
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(weekStart);
    dayStart.setDate(weekStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    let intervals = [];
    try { intervals = oh.getOpenIntervals(dayStart, dayEnd); } catch (e) { console.error('[oh] getOpenIntervals failed:', e); }

    const isToday = dayStart.toDateString() === now.toDateString();
    rows += `<tr${isToday ? ' class="oh-today"' : ''}>
      <td>${formatWeekday(dayStart)}</td>
      <td>${formatIntervals(intervals)}</td>
    </tr>`;
  }
  return rows;
}

function weekTableDetails(summary, rows) {
  return `<details class="oh-details">
      <summary class="oh-summary">
        ${summary} <i class="fa fa-chevron-right oh-chevron"></i>
      </summary>
      <table class="oh-table"><tbody>${rows}</tbody></table>
    </details>`;
}

// A tag may hold several numbers separated by ';', and the plain and contact:*
// variants often repeat the same number: split and de-duplicate by digits
function phoneNumbers(values) {
  const numbers = new Map();
  for (const n of values.filter(Boolean).flatMap(v => v.split(';')).map(n => n.trim()).filter(Boolean)) {
    const digits = n.replace(/[^\d+]/g, '');
    if (!numbers.has(digits)) numbers.set(digits, n);
  }
  return [...numbers.values()];
}

// OSM websites sometimes omit the scheme ("www.example.com"), which would make a relative link
function websiteUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function renderOsmTags(tags, osmType, osmId, place) {
  // Skip if the panel was closed while the tags were loading
  if (!document.querySelector('#feature-panel').classList.contains('visible')) return;
  setSelection(`poi=${osmType}/${osmId}`);

  const ROWS = [
    [['phone', 'contact:phone'],     t('label.phone'),       'tel'],
    [['mobile', 'contact:mobile'],   t('label.mobile'),      'tel'],
    [['website', 'contact:website'], t('label.website'),     'url'],
    ['operator',                     t('label.operator'),    false],
    ['brand',                        t('label.brand'),       false],
    ['cuisine',                      t('label.cuisine'),     false],
    ['wheelchair',                   t('label.wheelchair'),  false],
    ['description',                  t('label.description'), false],
  ];

  let html = '';

  // Quick actions on top: call the first number, open the website
  const phone = phoneNumbers([tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile']])[0];
  const website = tags.website || tags['contact:website'];
  if (phone || website) {
    html += '<div class="feature-actions">';
    if (phone) {
      html += `<a class="feature-action" href="tel:${escapeHtml(phone.replace(/\s/g, ''))}">
        <i class="fa fa-phone"></i> ${t('place.call')}</a>`;
    }
    if (website) {
      html += `<a class="feature-action" href="${escapeHtml(websiteUrl(website))}" target="_blank" rel="nofollow">
        <i class="fa fa-globe"></i> ${t('place.website')}</a>`;
    }
    html += '</div>';
  }

  // Opening hours rendered first with the rich component
  if (tags['opening_hours']) {
    html += `<div class="feature-detail-row feature-detail-row--oh">
      <span class="feature-detail-label">${t('label.hours')}</span>
      <span class="feature-detail-value">${renderOpeningHours(tags['opening_hours'])}</span>
    </div>`;
  }

  if (tags['collection_times']) {
    html += `<div class="feature-detail-row feature-detail-row--oh">
      <span class="feature-detail-label">${t('label.collectionTimes')}</span>
      <span class="feature-detail-value">${renderCollectionTimes(tags['collection_times'])}</span>
    </div>`;
  }

  // Address as one block: "Street 12" / "12345 City"
  const street = [tags['addr:street'] || tags['addr:place'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const locality = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const address = [street, locality].filter(Boolean).map(escapeHtml).join('<br>');
  if (address) {
    html += `<div class="feature-detail-row">
      <span class="feature-detail-label">${t('label.address')}</span>
      <span class="feature-detail-value">${address}</span>
    </div>`;
  }

  for (const [keys, label, linkType] of ROWS) {
    const present = [keys].flat().map(k => tags[k]).filter(Boolean);
    if (!present.length) continue;
    let value;
    if (linkType === 'url') {
      value = `<a href="${escapeHtml(websiteUrl(present[0]))}" target="_blank" rel="nofollow">${escapeHtml(present[0])}</a>`;
    } else if (linkType === 'tel') {
      value = phoneNumbers(present)
        .map(n => `<a href="tel:${escapeHtml(n.replace(/\s/g, ''))}">${escapeHtml(n)}</a>`)
        .join('<br>');
    } else {
      value = escapeHtml(present[0]);
    }
    html += `<div class="feature-detail-row">
      <span class="feature-detail-label">${label}</span>
      <span class="feature-detail-value">${value}</span>
    </div>`;
  }

  if (!html) {
    html = `<div class="feature-detail-empty">${t('place.noDetails')}</div>`;
  }

  const reviewName = tags.name || place?.name;
  if (reviewName && place?.lngLat) {
    html += '<div id="feature-reviews"><div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div></div>';
  }

  html += `<a class="feature-detail-osm-link"
    href="https://www.openstreetmap.org/${osmType}/${osmId}"
    target="_blank" rel="nofollow">${t('place.viewOnOsm')}</a>`;

  document.querySelector('#feature-panel-details').innerHTML = html;

  if (reviewName && place?.lngLat) loadReviews(reviewName, place.lngLat);
}

const MANGROVE_API = 'https://api.mangrove.reviews/reviews';
const MANGROVE_RADIUS_M = 50;
const REVIEWS_SHOWN = 3;
const reviewsCache = new Map();
var reviewsRequestId = 0;

function mangroveSubject(name, lngLat) {
  return `geo:${lngLat.lat.toFixed(7)},${lngLat.lng.toFixed(7)}?q=${encodeURIComponent(name)}&u=${MANGROVE_RADIUS_M}`;
}

async function fetchMangroveReviews(sub) {
  if (reviewsCache.has(sub)) return reviewsCache.get(sub);
  try {
    const res = await fetch(`${MANGROVE_API}?${new URLSearchParams({ sub })}`);
    if (res.ok) {
      const data = await res.json();
      const reviews = data.reviews || [];
      reviewsCache.set(sub, reviews);
      return reviews;
    }
  } catch (e) { console.error('[mangrove] fetch reviews failed:', e); }
  return [];
}

function renderStars(rating) {
  // Mangrove ratings are 0–100; show 0–5 stars in half steps
  const stars = Math.round(rating / 10) / 2;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const icon = stars >= i ? 'fa-star' : stars >= i - 0.5 ? 'fa-star-half-o' : 'fa-star-o';
    html += `<i class="fa ${icon}"></i>`;
  }
  return `<span class="review-stars" title="${formatNumber(stars, 1)} / 5">${html}</span>`;
}

function renderReviews(reviews, sub) {
  const rated = reviews.filter(r => typeof r.payload?.rating === 'number');
  let summary;
  if (rated.length) {
    const avg = rated.reduce((sum, r) => sum + r.payload.rating, 0) / rated.length;
    summary = `${renderStars(avg)} <span class="review-count">${formatNumber(avg / 20, 1)} · ${t('reviews.count', { count: reviews.length })}</span>`;
  } else {
    summary = `<span class="review-count">${t('reviews.none')}</span>`;
  }

  let html = `<div class="feature-detail-row">
    <span class="feature-detail-label">${t('label.reviews')}</span>
    <span class="feature-detail-value">${summary}</span>
  </div>`;

  const recent = [...reviews].sort((a, b) => (b.payload?.iat || 0) - (a.payload?.iat || 0)).slice(0, REVIEWS_SHOWN);
  for (const { payload } of recent) {
    const meta = [
      payload.metadata?.nickname,
      payload.iat ? formatDate(new Date(payload.iat * 1000)) : null,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    html += `<div class="review-item">
      ${typeof payload.rating === 'number' ? renderStars(payload.rating) : ''}
      ${payload.opinion ? `<div class="review-opinion">${escapeHtml(payload.opinion)}</div>` : ''}
      ${meta ? `<div class="review-meta">${meta}</div>` : ''}
    </div>`;
  }

  const linkText = reviews.length > REVIEWS_SHOWN ? t('reviews.seeAll', { count: reviews.length }) : t('reviews.write');
  html += `<a class="review-link" href="https://mangrove.reviews/?sub=${encodeURIComponent(sub)}"
    target="_blank" rel="nofollow">${linkText}</a>`;
  return html;
}

function loadReviews(name, lngLat) {
  const requestId = ++reviewsRequestId;
  const sub = mangroveSubject(name, lngLat);
  fetchMangroveReviews(sub).then(reviews => {
    const el = document.querySelector('#feature-reviews');
    // Ignore stale responses if another feature was opened meanwhile
    if (requestId !== reviewsRequestId || !el) return;
    el.innerHTML = renderReviews(reviews, sub);
  });
}


function initGeocoder() {
  const input = document.querySelector('#geocoder-input');
  const clearIcon = document.querySelector('#geocoder-clear-icon');
  const results = document.querySelector('#geocoder-results');
  let debounceTimer = null;

  input.addEventListener('focus', () => {
    if (input.value.trim().length === 0) renderSuggestions();
  });

  input.addEventListener('input', () => {
    clearIcon.style.display = input.value.length > 0 ? 'block' : 'none';
    clearTimeout(debounceTimer);
    if (input.value.trim().length === 0) {
      renderSuggestions();
      return;
    }
    if (input.value.trim().length < 2) {
      hideGeocoderResults();
      return;
    }
    debounceTimer = setTimeout(() => searchPhoton(input.value.trim()), 300);
  });

  // Keyboard navigation of the dropdown. The highlight lives in the DOM, so it resets
  // whenever the results are re-rendered.
  function dropdownItems() {
    return [...results.querySelectorAll('.suggestions-item, .geocoder-result')];
  }

  function moveHighlight(step) {
    const items = dropdownItems();
    if (!items.length) return;
    const current = items.findIndex(el => el.classList.contains('keyboard-focus'));
    const next = current === -1
      ? (step > 0 ? 0 : items.length - 1)
      : (current + step + items.length) % items.length;
    items[current]?.classList.remove('keyboard-focus');
    items[next].classList.add('keyboard-focus');
    items[next].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.style.display !== 'block') return;
      e.preventDefault(); // keep the caret in place
      moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      clearTimeout(debounceTimer);
      hideGeocoderResults();
      input.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    const highlighted = results.querySelector('.keyboard-focus');
    if (highlighted) {
      e.preventDefault();
      highlighted.click();
      input.blur();
      return;
    }
    const query = input.value.trim();
    if (query.length < 2) return;
    e.preventDefault();
    clearTimeout(debounceTimer);
    hideGeocoderResults();
    input.blur(); // closes the on-screen keyboard
    // An exact category name runs that category search, a cuisine word ("griechisch",
    // "Döner") a cuisine search; anything else searches place names
    const category = matchCategories(query).find(c => normalize(c.label) === normalize(query));
    const cuisines = matchCuisines(query);
    const full = cuisines.filter(c => c.full);
    const cuisine = cuisines.find(c => c.exact) || (full.length === 1 ? full[0] : null);
    if (category) {
      selectCategory(category.key);
    } else if (cuisine) {
      openCuisineSearch(cuisine.id);
    } else {
      searchPlaces(query, false);
    }
  });

  clearIcon.addEventListener('click', () => {
    input.value = '';
    clearIcon.style.display = 'none';
    renderSuggestions();
    input.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#geocoder')) hideGeocoderResults();
  });

  function renderSuggestions() {
    const recents = getRecentSearches();
    let html = '';

    if (recents.length) {
      html += '<div class="suggestions-section">';
      html += `<div class="suggestions-section-title">${t('search.recent')}</div>`;
      recents.forEach((r, i) => {
        html += `<div class="suggestions-item suggestions-recent" data-index="${i}">
          <i class="fa fa-clock-o suggestions-icon"></i>
          <span class="suggestions-item-name">${escapeHtml(r.name)}</span>
        </div>`;
      });
      html += '</div>';
    }

    if (poiData) {
      html += '<div class="suggestions-section">';
      html += `<div class="suggestions-section-title">${t('search.categories')}</div>`;
      const categories = Object.entries(poiData)
        .map(([key, poi]) => ({ key, label: categoryLabel(poi) }))
        .sort((a, b) => a.label.localeCompare(b.label, LANG));
      for (const { key, label } of categories) {
        const active = key === selectedCategory ? ' suggestions-item--active' : '';
        html += `<div class="suggestions-item suggestions-category${active}" data-key="${escapeHtml(key)}">
          <i class="fa fa-map-marker suggestions-icon"></i>
          <span class="suggestions-item-name">${escapeHtml(label)}</span>
        </div>`;
      }
      html += '</div>';
    }

    if (!html) return;
    results.innerHTML = html;
    results.style.display = 'block';

    results.querySelectorAll('.suggestions-recent').forEach(el => {
      el.addEventListener('click', () => {
        const r = recents[parseInt(el.dataset.index)];
        input.value = r.name;
        clearIcon.style.display = 'block';
        hideGeocoderResults();
        if (r.props) {
          openGeocoderResult(r.props, r.lat, r.lng, r.zoom);
        } else {
          // Entries saved before place details were stored: show the spot as a pin
          map.flyTo({ center: [r.lng, r.lat], zoom: r.zoom, offset: sheetOffset() });
          showLocationDetail({ lat: r.lat, lng: r.lng });
        }
      });
    });

    results.querySelectorAll('.suggestions-category').forEach(el => {
      el.addEventListener('click', () => {
        hideGeocoderResults();
        selectCategory(el.dataset.key);
      });
    });
  }

  function normalize(str) {
    return String(str).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  // Categories whose label in any language matches the query
  function matchCategories(query) {
    if (!poiData) return [];
    const q = normalize(query);
    const matches = [];
    for (const [key, poi] of Object.entries(poiData)) {
      const labels = Object.keys(poi).filter(k => k.startsWith('lang-')).map(k => normalize(poi[k]));
      if (labels.some(l => l.includes(q))) {
        matches.push({ key, label: categoryLabel(poi) || key });
      }
    }
    return matches.sort((a, b) => a.label.localeCompare(b.label, LANG));
  }

  const CUISINE_SUGGESTIONS = 3;
  const MIN_TOKEN_LENGTH = 3;

  // Cuisines whose label (any language) or extra terms match the query by word prefix:
  // "griech" → greek, "zum griechen" → greek (term "grieche"), "döner" → kebab.
  // exact: a whole label or term equals the query. full: every longer query word matched,
  // so "zum griechen" counts as a cuisine search but "burger king" doesn't.
  function matchCuisines(query) {
    if (!cuisineData) return [];
    const q = normalize(query);
    const tokens = q.split(/\s+/).filter(tok => tok.length >= MIN_TOKEN_LENGTH);
    if (!tokens.length) return [];
    const matches = [];
    for (const [id, entry] of Object.entries(cuisineData)) {
      const phrases = [...Object.values(entry.labels), ...(entry.terms || [])].map(normalize);
      const words = phrases.flatMap(p => p.split(/[\s\-/]+/));
      const matchesToken = (tok) => words.some(w => w.startsWith(tok) || (w.length >= 4 && tok.startsWith(w)));
      if (!tokens.some(matchesToken)) continue;
      const longTokens = tokens.filter(tok => tok.length >= 4);
      matches.push({
        id,
        label: cuisineLabel(id),
        exact: phrases.includes(q),
        full: longTokens.length > 0 && longTokens.every(matchesToken),
      });
    }
    return matches.sort((a, b) => b.exact - a.exact || a.label.localeCompare(b.label, LANG));
  }

  function openCuisineSearch(id) {
    input.value = cuisineLabel(id);
    clearIcon.style.display = 'block';
    hideGeocoderResults();
    searchCuisine(id, false);
  }

  function searchPhoton(query) {
    const center = map.getCenter();
    // Bias results towards the current map view
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=${PHOTON_LANG}` +
      `&lat=${center.lat}&lon=${center.lng}&zoom=${Math.round(map.getZoom())}&location_bias_scale=0.1`;
    const categories = matchCategories(query);
    const cuisines = matchCuisines(query).slice(0, CUISINE_SUGGESTIONS);
    if (categories.length || cuisines.length) renderGeocoderResults([], categories, cuisines);
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (input.value.trim() !== query) return; // stale response
        renderGeocoderResults(data.features, categories, cuisines);
      })
      .catch(() => renderGeocoderResults([], categories, cuisines));
  }

  function renderGeocoderResults(features, categories = [], cuisines = []) {
    results.innerHTML = '';
    if ((!features || features.length === 0) && categories.length === 0 && cuisines.length === 0) {
      hideGeocoderResults();
      return;
    }

    if (cuisines.length) {
      const section = document.createElement('div');
      section.className = 'suggestions-section';
      section.innerHTML = `<div class="suggestions-section-title">${t('search.food')}</div>`;
      for (const { id, label } of cuisines) {
        const el = document.createElement('div');
        el.className = 'suggestions-item suggestions-category';
        el.innerHTML = `<i class="fa fa-cutlery suggestions-icon"></i>
          <span class="suggestions-item-name">${escapeHtml(label)}</span>`;
        el.addEventListener('click', () => openCuisineSearch(id));
        section.appendChild(el);
      }
      results.appendChild(section);
    }

    if (categories.length) {
      const section = document.createElement('div');
      section.className = 'suggestions-section';
      section.innerHTML = `<div class="suggestions-section-title">${t('search.categories')}</div>`;
      for (const { key, label } of categories) {
        const el = document.createElement('div');
        el.className = 'suggestions-item suggestions-category';
        el.innerHTML = `<i class="fa fa-map-marker suggestions-icon"></i>
          <span class="suggestions-item-name">${escapeHtml(label)}</span>`;
        el.addEventListener('click', () => {
          hideGeocoderResults();
          selectCategory(key);
        });
        section.appendChild(el);
      }
      results.appendChild(section);
    }

    (features || []).forEach((feature) => {
      const p = feature.properties;
      const [lon, lat] = feature.geometry.coordinates;

      const { name, detail } = photonLabel(p);

      const item = document.createElement('div');
      item.className = 'geocoder-result';
      item.innerHTML = `<div class="geocoder-result-name">${escapeHtml(name)}</div>` +
        (detail ? `<div class="geocoder-result-detail">${escapeHtml(detail)}</div>` : '');

      item.addEventListener('click', () => {
        const fullName = name + (detail ? ', ' + detail : '');
        input.value = fullName;
        const zoom = zoomForType(p.type || p.osm_value);
        addRecentSearch({ name: fullName, lat, lng: lon, zoom, props: p });
        hideGeocoderResults();
        openGeocoderResult(p, lat, lon, zoom);
      });

      results.appendChild(item);
    });

    results.style.display = 'block';
  }

  function openGeocoderResult(props, lat, lng, zoom) {
    map.flyTo({ center: [lng, lat], zoom, offset: sheetOffset() });

    if (searchResultMarker) searchResultMarker.remove();
    searchResultMarker = new maplibregl.Marker({ color: '#e53e3e' })
      .setLngLat([lng, lat])
      .addTo(map);

    showGeocoderFeatureDetail(props, { lat, lng });
  }

  function hideGeocoderResults() {
    results.style.display = 'none';
    results.innerHTML = '';
  }

  function zoomForType(type) {
    const zoomMap = {
      city: 12, town: 13, village: 13, suburb: 14,
      street: 15, road: 15, house: 17, district: 12,
    };
    return zoomMap[type] || 14;
  }
}

init();
