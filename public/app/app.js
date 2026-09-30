import maplibregl from 'maplibre-gl';
import OpeningHours from 'opening_hours';

var map;
var poiMarkers = [];
var myLocation = null;
var berlin = [13.4101340342265, 52.5213616409873]; // [lng, lat]

const CACHE_PREFIX = 'osm_cache_';

function cacheGet(key) {
  console.log('[cache] looking for:', key);
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (raw) {
      console.log('[cache] hit:', key);
      return JSON.parse(raw);
    }
    console.log('[cache] miss:', key);
    return null;
  } catch { return null; }
}

function cacheSet(key, value) {
  console.log('[cache] saving:', key, value);
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch (e) { console.warn('[cache] localStorage write failed:', e); }
}

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function fetchOverpass(query) {
  const requests = OVERPASS_SERVERS.map(server =>
    fetch(`${server}?data=${encodeURIComponent(query)}`)
      .then(r => {
        if (!r.ok) throw new Error(r.statusText);
        console.log('[overpass] winner:', server);
        return r.json();
      })
  );
  return Promise.any(requests);
}
var mapDragged = false;
var geolocateControl = null;
var searchResultMarker = null;
var selectedCategory = null;
var poiData = null;
var mapLoaded = false;
// The open POI or dropped pin, kept in the URL hash so links can be shared:
// 'poi=<osm type>/<osm id>' or 'pin=<lat>/<lng>'
var sharedSelection = null;
var sharedPoiRequestId = 0;
var locationRequestId = 0;

window.onload = init();

function initMap(center, zoom) {
  console.log("init map called");

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
      if (!e.features.length) return;
      new maplibregl.Popup({ maxWidth: '300px' })
        .setLngLat(e.lngLat)
        .setHTML(e.features[0].properties.popupHtml)
        .addTo(map);
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
  console.log("loadPOIs called");
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
    if (map.getZoom() < 13) {
      alert("Please zoom in");
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
  console.log('[overpass] querying category:', selectedCategory, '| servers:', OVERPASS_SERVERS);
  console.log('[overpass] query:', fullQuery);

  // Clear old markers and polygons
  poiMarkers.forEach(m => m.remove());
  poiMarkers = [];
  if (mapLoaded) {
    map.getSource('poi-polygons').setData({ type: 'FeatureCollection', features: [] });
  }

  const tagName = getTagName();
  setSelection(null);
  document.querySelector('#feature-panel-name').textContent = tagName;
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML =
    `<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i> Searching for ${tagName}...</div>`;
  document.querySelector('#feature-panel').classList.add('visible');

  fetchOverpass(fullQuery)
    .then((data) => {
      console.log('[overpass] response received, elements:', data.elements?.length ?? 0);

      var pois = data.elements;

      if (pois.length === 0) {
        document.querySelector('#feature-panel-details').innerHTML =
          '<div class="feature-detail-empty">No results in this area. Zoom out or pan the map.</div>';
        return;
      }

      var polygonFeatures = [];
      var markerPositions = []; // [lng, lat] for fitBounds
      var resultItems = []; // for panel list

      for (let poi of pois) {
        if (poi.type === 'node' && typeof poi.tags !== 'undefined') {
          var marker = new maplibregl.Marker()
            .setLngLat([poi.lon, poi.lat])
            .addTo(map);
          poiMarkers.push(marker);
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
            properties: {}
          });

          var lngs = coordinates.map(c => c[0]);
          var lats = coordinates.map(c => c[1]);
          var centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
          var centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
          var centerMarker = new maplibregl.Marker()
            .setLngLat([centerLng, centerLat])
            .addTo(map);
          poiMarkers.push(centerMarker);
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
      document.querySelector('#feature-panel-type').textContent = `${resultItems.length} result${resultItems.length !== 1 ? 's' : ''}`;
      const detailsEl = document.querySelector('#feature-panel-details');
      detailsEl.innerHTML = '';
      for (const { poi, lngLat } of resultItems) {
        const name = poi.tags.name || poi.tags.operator || poi.tags.brand || tagName;
        const street = [poi.tags['addr:housenumber'], poi.tags['addr:street']].filter(Boolean).join(' ');
        const detail = street || poi.tags.description || '';
        const row = document.createElement('div');
        row.className = 'poi-result-item';
        row.innerHTML = `<div class="poi-result-name">${name}</div>${detail ? `<div class="poi-result-detail">${detail}</div>` : ''}`;
        row.addEventListener('click', () => {
          map.flyTo({ center: lngLat, zoom: 18 });
          const poiName = poi.tags.name || poi.tags.operator || poi.tags.brand || tagName;
          setSelection(null);
          document.querySelector('#feature-panel-name').textContent = poiName;
          document.querySelector('#feature-panel-type').textContent = tagName;
          document.querySelector('#feature-panel-details').innerHTML =
            '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
          const place = { name: poiName, lngLat: { lng: lngLat[0], lat: lngLat[1] } };
          fetchOsmTagsByTypeAndId(poi.type, poi.id).then(result => {
            if (result) {
              renderOsmTags(result.tags, result.type, result.id, place);
            } else {
              renderOsmTags(poi.tags, poi.type, poi.id, place);
            }
          });
        });
        detailsEl.appendChild(row);
      }

      const redoBtn = document.createElement('div');
      redoBtn.className = 'poi-redo-search';
      redoBtn.textContent = 'Redo search in this region';
      redoBtn.addEventListener('click', () => loadPOIs(true));
      detailsEl.appendChild(redoBtn);

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
      console.log('[overpass] all servers failed:', error);
      document.querySelector('#feature-panel-details').innerHTML =
        '<div class="feature-detail-empty">Search failed. Please try again.</div>';
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

function getTagName() {
  if (!selectedCategory || !poiData?.[selectedCategory]) return '';
  return poiData[selectedCategory]['lang-en'] || '';
}

function getTag() {
  if (!selectedCategory || !poiData?.[selectedCategory]) return '';
  return poiData[selectedCategory].osm || '';
}

function selectCategory(key) {
  selectedCategory = key;
  const preferred = 'lang-' + window.navigator.language.substring(0, 2);
  const label = poiData[key]?.[preferred] || poiData[key]?.['lang-en'] || key;
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
  console.log("init called");

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
  if (!key) return 'Place';
  const value = tags[key];
  return FEATURE_TYPE_LABELS[value] || value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
    document.querySelector('#feature-panel-name').textContent = 'Place not found';
    document.querySelector('#feature-panel-details').innerHTML =
      '<div class="feature-detail-empty">This place no longer exists on OpenStreetMap.</div>';
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
      .catch(() => window.prompt('Copy this link:', url));
  } else {
    // Clipboard API is unavailable on insecure (http) origins
    window.prompt('Copy this link:', url);
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
  document.querySelector('#feature-panel-name').textContent = 'About TheNextIs';
  document.querySelector('#feature-panel-type').textContent = '';
  document.querySelector('#feature-panel-details').innerHTML = `
    <div class="feature-detail-row">
      <span class="feature-detail-value">Find the nearest point of interest around you using OpenStreetMap data.</span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">Source</span>
      <span class="feature-detail-value"><a href="https://www.openstreetmap.org" target="_blank" rel="nofollow">OpenStreetMap</a></span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">Code</span>
      <span class="feature-detail-value"><a href="https://github.com/homtec/thenextis/" target="_blank" rel="nofollow">Contribute on GitHub</a></span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">Follow</span>
      <span class="feature-detail-value">
        <a href="https://twitter.com/thenextis" target="_blank" rel="nofollow"><i class="fa fa-twitter"></i> Twitter</a>
        &nbsp;&nbsp;
        <a href="https://www.facebook.com/Thenextis" target="_blank" rel="nofollow"><i class="fa fa-facebook-square"></i> Facebook</a>
      </span>
    </div>
    <div class="feature-detail-row">
      <span class="feature-detail-label">Map data</span>
      <span class="feature-detail-value">Missing a place? <a href="#" id="info-edit-osm-link">Add it in OpenStreetMap</a></span>
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
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


// Source layers to consider for feature clicks, in priority order
const SOURCE_LAYER_ORDER = ['poi', 'place', 'building', 'park', 'landuse', 'water', 'waterway'];

const FEATURE_TYPE_LABELS = {
  // poi subclasses
  restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Fast Food', bar: 'Bar',
  pub: 'Pub', biergarten: 'Beer Garden', pharmacy: 'Pharmacy', hospital: 'Hospital',
  bank: 'Bank', atm: 'ATM', hotel: 'Hotel', hostel: 'Hostel',
  supermarket: 'Supermarket', convenience: 'Convenience Store', bakery: 'Bakery',
  hairdresser: 'Hairdresser', clothes: 'Clothing Store', books: 'Bookshop',
  library: 'Library', school: 'School', kindergarten: 'Kindergarten',
  college: 'College', university: 'University', cinema: 'Cinema',
  theatre: 'Theatre', museum: 'Museum', gallery: 'Gallery',
  playground: 'Playground', park: 'Park', pitch: 'Sports Field',
  swimming_pool: 'Swimming Pool', sports_centre: 'Sports Centre',
  fuel: 'Gas Station', parking: 'Parking', bicycle: 'Bicycle Shop',
  car: 'Car Dealer', car_repair: 'Car Repair', laundry: 'Laundry',
  post_office: 'Post Office', police: 'Police', fire_station: 'Fire Station',
  drinking_water: 'Drinking Water', toilets: 'Toilets', shelter: 'Shelter',
  place_of_worship: 'Place of Worship', charging_station: 'Charging Station',
  // source layers
  building: 'Building', water: 'Water', waterway: 'Waterway',
  // place classes
  city: 'City', town: 'Town', village: 'Village', suburb: 'Suburb',
  neighbourhood: 'Neighbourhood', island: 'Island', country: 'Country',
  state: 'State', county: 'County',
};

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
  const key = p.subclass || p.class || feature.sourceLayer || '';
  return FEATURE_TYPE_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Place';
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
      console.log('[feature click] sourceLayer:', feature.sourceLayer, 'properties:', feature.properties);
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
  document.querySelector('#feature-panel-name').textContent = 'Dropped pin';
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
          <span class="feature-detail-label">Address</span>
          <span class="feature-detail-value">${escapeHtml(address)}</span>
        </div>`;
      }
    }

    html += `<div class="feature-detail-row">
      <span class="feature-detail-label">Coordinates</span>
      <span class="feature-detail-value"><a href="#" id="location-copy-coords" title="Copy to clipboard">${coords}</a></span>
    </div>`;
    html += `<a class="feature-detail-osm-link"
      href="https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=18/${lat.toFixed(6)}/${lng.toFixed(6)}"
      target="_blank" rel="nofollow">View on OpenStreetMap</a>`;

    document.querySelector('#feature-panel-details').innerHTML = html;
    const copyLink = document.querySelector('#location-copy-coords');
    copyLink.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard?.writeText(coords).then(() => {
        copyLink.textContent = 'Copied!';
        setTimeout(() => { copyLink.textContent = coords; }, 1200);
      }).catch(err => console.warn('[location] copy failed:', err));
    });
  });
}

async function reverseGeocode(lat, lng) {
  const cacheKey = `rev_${lat.toFixed(5)}_${lng.toFixed(5)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const lang = window.navigator.language.substring(0, 2);
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=${lang}`);
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
  document.querySelector('#feature-panel-name').textContent = name;
  document.querySelector('#feature-panel-type').textContent = type;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  const osmRef = osmRefFromFeatureId(feature.id);

  if (osmRef) {
    console.log('[feature] OSM ref from tile feature id:', osmRef, '→ using OSM API');
  } else {
    console.log('[feature] no OSM id in tile feature, falling back to Overpass by location. props:', props);
  }

  const resolve = osmRef
    ? fetchOsmTagsByTypeAndId(osmRef.type, osmRef.id)
    : fetchOsmTagsByLocation(name, lngLat);

  resolve.then(result => {
    if (result) {
      renderOsmTags(result.tags, result.type, result.id, { name, lngLat });
    } else {
      document.querySelector('#feature-panel-details').innerHTML =
        '<div class="feature-detail-empty">No additional details available.</div>';
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
  const typeKey = props.type || props.osm_value || '';
  const type = FEATURE_TYPE_LABELS[typeKey]
    || typeKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    || 'Place';

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
        '<div class="feature-detail-empty">No additional details available.</div>';
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

const OH_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Week order for table: Mon–Sun (matching OSM convention)
const OH_MON_TO_SUN = [1, 2, 3, 4, 5, 6, 0];

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderOpeningHours(ohStr) {
  let oh;
  try {
    oh = new OpeningHours(ohStr, null, { tag_key: 'opening_hours' });
  } catch (e) {
    console.warn('[oh] failed to parse opening hours:', e);
    return `<span>${escapeHtml(ohStr)}</span>`;
  }

  const now = new Date();
  const isOpen = oh.getState(now);
  const isUnknown = oh.getUnknown(now); // true for open-end (+) intervals
  const nextChange = oh.getNextChange(now);

  // Status line
  let statusClass, statusText;

  if (isOpen || isUnknown) {
    if (isUnknown) {
      statusClass = 'oh-open';
      statusText = 'Open';
    } else if (nextChange && (nextChange - now) < 30 * 60 * 1000) {
      statusClass = 'oh-closing-soon';
      statusText = `Closing soon · until ${formatTime(nextChange)}`;
    } else {
      statusClass = 'oh-open';
      statusText = nextChange ? `Open until ${formatTime(nextChange)}` : 'Open';
    }
  } else {
    statusClass = 'oh-closed';
    if (nextChange) {
      const sameDay = nextChange.toDateString() === now.toDateString();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const nextDayTomorrow = nextChange.toDateString() === tomorrow.toDateString();
      if (sameDay) {
        statusText = `Closed · Opens at ${formatTime(nextChange)}`;
      } else if (nextDayTomorrow) {
        statusText = `Closed · Opens tomorrow at ${formatTime(nextChange)}`;
      } else {
        statusText = `Closed · Opens ${OH_DAY_NAMES[nextChange.getDay()]} at ${formatTime(nextChange)}`;
      }
    } else {
      statusText = 'Closed';
    }
  }

  // Weekly table (Mon–Sun)
  const weekStart = new Date(now);
  const dayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
  weekStart.setDate(now.getDate() + dayOffset);
  weekStart.setHours(0, 0, 0, 0);

  let tableRows = '';
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(weekStart);
    dayStart.setDate(weekStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    let intervals = [];
    try { intervals = oh.getOpenIntervals(dayStart, dayEnd); } catch (e) { console.error('[oh] getOpenIntervals failed:', e); }

    const times = intervals.length
      ? intervals.map(([s, e]) => `${formatTime(s)}–${formatTime(e)}`).join(', ')
      : 'Closed';

    const jsDay = OH_MON_TO_SUN[i];
    const isToday = jsDay === now.getDay();
    tableRows += `<tr${isToday ? ' class="oh-today"' : ''}>
      <td>${OH_DAY_NAMES[jsDay]}</td>
      <td>${times}</td>
    </tr>`;
  }

  return `<div class="oh-container">
    <div class="oh-status ${statusClass}">
      <span class="oh-dot"></span>
      <span>${statusText}</span>
    </div>
    <details class="oh-details">
      <summary class="oh-summary">
        All opening times <i class="fa fa-chevron-right oh-chevron"></i>
      </summary>
      <table class="oh-table"><tbody>${tableRows}</tbody></table>
    </details>
  </div>`;
}

function renderOsmTags(tags, osmType, osmId, place) {
  // Skip if the panel was closed while the tags were loading
  if (!document.querySelector('#feature-panel').classList.contains('visible')) return;
  setSelection(`poi=${osmType}/${osmId}`);

  const ROWS = [
    ['addr:street',     'Street',      false],
    ['addr:housenumber','Number',      false],
    ['addr:city',       'City',        false],
    ['addr:postcode',   'Postcode',    false],
    [['phone', 'contact:phone'],   'Phone',   'tel'],
    [['mobile', 'contact:mobile'], 'Mobile',  'tel'],
    [['website', 'contact:website'], 'Website', 'url'],
    ['operator',        'Operator',    false],
    ['brand',           'Brand',       false],
    ['cuisine',         'Cuisine',     false],
    ['wheelchair',      'Wheelchair',  false],
    ['description',     'Description', false],
  ];

  let html = '';

  // Opening hours rendered first with the rich component
  if (tags['opening_hours']) {
    html += `<div class="feature-detail-row feature-detail-row--oh">
      <span class="feature-detail-label">Hours</span>
      <span class="feature-detail-value">${renderOpeningHours(tags['opening_hours'])}</span>
    </div>`;
  }

  for (const [keys, label, linkType] of ROWS) {
    const present = [keys].flat().map(k => tags[k]).filter(Boolean);
    if (!present.length) continue;
    let value;
    if (linkType === 'url') {
      value = `<a href="${escapeHtml(present[0])}" target="_blank" rel="nofollow">${escapeHtml(present[0])}</a>`;
    } else if (linkType === 'tel') {
      // A tag may hold several numbers separated by ';', and the plain and
      // contact:* variants often repeat the same number
      const numbers = new Map();
      for (const n of present.flatMap(v => v.split(';')).map(n => n.trim()).filter(Boolean)) {
        const digits = n.replace(/[^\d+]/g, '');
        if (!numbers.has(digits)) numbers.set(digits, n);
      }
      value = [...numbers.values()]
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
    html = '<div class="feature-detail-empty">No additional details available.</div>';
  }

  const reviewName = tags.name || place?.name;
  if (reviewName && place?.lngLat) {
    html += '<div id="feature-reviews"><div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div></div>';
  }

  html += `<a class="feature-detail-osm-link"
    href="https://www.openstreetmap.org/${osmType}/${osmId}"
    target="_blank" rel="nofollow">View on OpenStreetMap</a>`;

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
  return `<span class="review-stars" title="${stars} / 5">${html}</span>`;
}

function renderReviews(reviews, sub) {
  const rated = reviews.filter(r => typeof r.payload?.rating === 'number');
  let summary;
  if (rated.length) {
    const avg = rated.reduce((sum, r) => sum + r.payload.rating, 0) / rated.length;
    summary = `${renderStars(avg)} <span class="review-count">${(avg / 20).toFixed(1)} · ${reviews.length} review${reviews.length !== 1 ? 's' : ''}</span>`;
  } else {
    summary = '<span class="review-count">No reviews yet</span>';
  }

  let html = `<div class="feature-detail-row">
    <span class="feature-detail-label">Reviews</span>
    <span class="feature-detail-value">${summary}</span>
  </div>`;

  const recent = [...reviews].sort((a, b) => (b.payload?.iat || 0) - (a.payload?.iat || 0)).slice(0, REVIEWS_SHOWN);
  for (const { payload } of recent) {
    const meta = [
      payload.metadata?.nickname,
      payload.iat ? new Date(payload.iat * 1000).toLocaleDateString() : null,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    html += `<div class="review-item">
      ${typeof payload.rating === 'number' ? renderStars(payload.rating) : ''}
      ${payload.opinion ? `<div class="review-opinion">${escapeHtml(payload.opinion)}</div>` : ''}
      ${meta ? `<div class="review-meta">${meta}</div>` : ''}
    </div>`;
  }

  const linkText = reviews.length > REVIEWS_SHOWN ? `See all ${reviews.length} reviews` : 'Write a review on Mangrove';
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
    const preferred = 'lang-' + window.navigator.language.substring(0, 2);
    let html = '';

    if (recents.length) {
      html += '<div class="suggestions-section">';
      html += '<div class="suggestions-section-title">Recent</div>';
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
      html += '<div class="suggestions-section-title">Categories</div>';
      const categories = Object.entries(poiData)
        .map(([key, poi]) => ({ key, label: poi[preferred] || poi['lang-en'] }))
        .sort((a, b) => a.label.localeCompare(b.label));
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
        map.flyTo({ center: [r.lng, r.lat], zoom: r.zoom });
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
    const preferred = 'lang-' + window.navigator.language.substring(0, 2);
    const matches = [];
    for (const [key, poi] of Object.entries(poiData)) {
      const labels = Object.keys(poi).filter(k => k.startsWith('lang-')).map(k => normalize(poi[k]));
      if (labels.some(l => l.includes(q))) {
        matches.push({ key, label: poi[preferred] || poi['lang-en'] || key });
      }
    }
    return matches.sort((a, b) => a.label.localeCompare(b.label));
  }

  function searchPhoton(query) {
    const lang = window.navigator.language.substring(0, 2);
    const center = map.getCenter();
    // Bias results towards the current map view
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=${lang}` +
      `&lat=${center.lat}&lon=${center.lng}&zoom=${Math.round(map.getZoom())}&location_bias_scale=0.1`;
    const categories = matchCategories(query);
    if (categories.length) renderGeocoderResults([], categories);
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (input.value.trim() !== query) return; // stale response
        renderGeocoderResults(data.features, categories);
      })
      .catch(() => renderGeocoderResults([], categories));
  }

  function renderGeocoderResults(features, categories = []) {
    results.innerHTML = '';
    if ((!features || features.length === 0) && categories.length === 0) {
      hideGeocoderResults();
      return;
    }

    if (categories.length) {
      const section = document.createElement('div');
      section.className = 'suggestions-section';
      section.innerHTML = '<div class="suggestions-section-title">Categories</div>';
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

      const streetWithNumber = p.street
        ? p.street + (p.housenumber ? ' ' + p.housenumber : '')
        : null;
      const name = p.name || streetWithNumber || p.city || '';
      const streetDetail = (p.name && streetWithNumber) ? streetWithNumber : null;
      const detailParts = [streetDetail, p.city, p.country].filter(Boolean);
      const detail = detailParts.join(', ');

      const item = document.createElement('div');
      item.className = 'geocoder-result';
      item.innerHTML = `<div class="geocoder-result-name">${escapeHtml(name)}</div>` +
        (detail ? `<div class="geocoder-result-detail">${escapeHtml(detail)}</div>` : '');

      item.addEventListener('click', () => {
        const fullName = name + (detail ? ', ' + detail : '');
        input.value = fullName;
        addRecentSearch({ name: fullName, lat, lng: lon, zoom: zoomForType(p.type || p.osm_value) });
        hideGeocoderResults();
        const zoom = zoomForType(p.type || p.osm_value);
        map.flyTo({ center: [lon, lat], zoom });

        if (searchResultMarker) searchResultMarker.remove();
        searchResultMarker = new maplibregl.Marker({ color: '#e53e3e' })
          .setLngLat([lon, lat])
          .addTo(map);

        showGeocoderFeatureDetail(p, { lat, lng: lon });
      });

      results.appendChild(item);
    });

    results.style.display = 'block';
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
