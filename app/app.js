import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap/dist/css/bootstrap-theme.min.css';
import 'font-awesome/css/font-awesome.css';
import './app.css';
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
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch {}
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
var myLocationMarker = null;
var searchResultMarker = null;
var selectedCategory = null;
var poiData = null;
var mapLoaded = false;

window.onload = init();

function initMap(center, zoom) {
  console.log("init map called");

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: center, // [lng, lat]
    zoom: zoom
  });

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
          document.querySelector('#feature-panel-name').textContent = poiName;
          document.querySelector('#feature-panel-type').textContent = tagName;
          document.querySelector('#feature-panel-details').innerHTML =
            '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
          fetchOsmTagsByTypeAndId(poi.type, poi.id).then(result => {
            if (result) {
              renderOsmTags(result.tags, result.type, result.id);
            } else {
              renderOsmTags(poi.tags, poi.type, poi.id);
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


function onLocationFound(position) {
  myLocation = {
    lat: position.coords.latitude,
    lng: position.coords.longitude
  };

  if (myLocationMarker) myLocationMarker.remove();

  const el = document.createElement('div');
  el.className = 'user-location-dot';

  myLocationMarker = new maplibregl.Marker({ element: el })
    .setLngLat([myLocation.lng, myLocation.lat])
    .addTo(map);

  const flyToUser = () => map.flyTo({ center: [myLocation.lng, myLocation.lat], zoom: 16 });
  if (map.loaded()) {
    flyToUser();
  } else {
    map.once('load', flyToUser);
  }

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

  var hash = window.location.hash;
  var type = null;
  var url_location = null;

  var startCenter = berlin;
  var startzoom = 3;

  if (hash.length > 0) {
    hash = hash.replace('#', '');
    var params = hash.split('&');

    for (let param of params) {
      var setting = param.split('=');
      switch (setting[0]) {
        case "map":
          url_location = setting[1];
          break;
        case "type":
          type = setting[1];
          break;
      }
    }
  }

  if (url_location) {
    // URL format stored as zoom/lat/lng
    var loc_array = url_location.split('/');
    startCenter = [parseFloat(loc_array[2]), parseFloat(loc_array[1])]; // [lng, lat]
    startzoom = parseFloat(loc_array[0]);
    mapDragged = true;
  }

  initMap(startCenter, startzoom);

  if (!url_location) {
    locateMe();
  }

  if (type) {
    // search for POI type from URL
  }

  loadPOIdataFromFile();

  document.querySelector('#locateMe-button').onclick = function () { locateMe(); };
  document.querySelector('#info-button').onclick = function () { showInfo(); };
  document.querySelector('#editOSM-button').onclick = function () { editOSM(); };

  initGeocoder();

  map.on('load', () => {
    initFeatureClick();
  });
}

function locateMe() {
  mapDragged = false;
  navigator.geolocation.getCurrentPosition(onLocationFound, onLocationError, {
    enableHighAccuracy: true
  });
}

function showInfo() {
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

function getPopupText(poi) {
  var popuptext = "";
  if (typeof poi.tags.name != 'undefined')
    popuptext += poi.tags.name + "<br>";
  if (typeof poi.tags.operator != 'undefined')
    popuptext += poi.tags.operator + "<br>";
  if (typeof poi.tags.collection_times != 'undefined')
    popuptext += poi.tags.collection_times + "<br>";
  if (typeof poi.tags.opening_hours != 'undefined')
    popuptext += poi.tags.opening_hours + "<br>";
  if (typeof poi.tags.phone != 'undefined')
    popuptext += '<a href="tel:' + poi.tags.phone + '">' + poi.tags.phone + '</a><br>';
  if (typeof poi.tags.website != 'undefined')
    popuptext += '<a href="' + poi.tags.website + '" target="_blank" rel="nofollow">' + poi.tags.website + '</a><br>';

  if (poi.tags['recycling:clothes'] == 'yes')
    popuptext += "Clothes<br>";
  if (poi.tags['recycling:paper'] == 'yes')
    popuptext += "Paper<br>";
  if (poi.tags['recycling:glass'] == 'yes')
    popuptext += "Glass<br>";
  if (poi.tags['recycling:garden_waste'] == 'yes')
    popuptext += "Garden waste<br>";

  return popuptext;
}


function updateHashURL() {
  var center = map.getCenter();
  var urlhash_location = "map=" + map.getZoom().toFixed(0) + '/' +
    center.lat.toFixed(5) + '/' + center.lng.toFixed(5);
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
}

function showFeatureDetail(feature, lngLat) {
  const props = feature.properties;
  const name = props.name || props.name_en || formatFeatureType(feature);
  const type = formatFeatureType(feature);

  document.querySelector('#feature-panel-name').textContent = name;
  document.querySelector('#feature-panel-type').textContent = type;
  document.querySelector('#feature-panel-details').innerHTML =
    '<div class="feature-detail-loading"><i class="fa fa-spinner fa-spin"></i></div>';
  document.querySelector('#feature-panel').classList.add('visible');

  // Try several property names different tile schemas use for the OSM id
  const osmId = props.osm_id || props.id || props.osm_way_id || null;

  if (osmId) {
    console.log('[feature] OSM id found:', osmId, '→ using OSM API');
  } else {
    console.log('[feature] no OSM id in tile properties, falling back to Overpass by location. props:', props);
  }

  const resolve = osmId
    ? fetchOsmTagsById(osmId)
    : fetchOsmTagsByLocation(name, lngLat);

  resolve.then(result => {
    if (result) {
      renderOsmTags(result.tags, result.type, result.id);
    } else {
      document.querySelector('#feature-panel-details').innerHTML =
        '<div class="feature-detail-empty">No additional details available.</div>';
    }
  });
}

function hideFeatureDetail() {
  document.querySelector('#feature-panel').classList.remove('visible');
  if (searchResultMarker) {
    searchResultMarker.remove();
    searchResultMarker = null;
  }
}

async function fetchOsmTagsById(osmId) {
  const cacheKey = `id_${osmId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const id = Math.abs(Math.round(osmId));
  const types = osmId > 0 ? ['node', 'way'] : ['way', 'node'];

  for (const type of types) {
    try {
      const res = await fetch(`https://api.openstreetmap.org/api/0.6/${type}/${id}.json`);
      if (res.ok) {
        const data = await res.json();
        if (data.elements?.length) {
          const result = { tags: data.elements[0].tags || {}, type, id };
          if (Object.keys(result.tags).length) cacheSet(cacheKey, result);
          return result;
        }
      }
    } catch (e) { /* try next */ }
  }
  return null;
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
  } catch (e) {}
  return null;
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
      renderOsmTags(result.tags, result.type, result.id);
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
  } catch (e) {}
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
    return `<span>${escapeHtml(ohStr)}</span>`;
  }

  const now = new Date();
  const isOpen = oh.getState(now);
  const nextChange = oh.getNextChange(now);

  // Status line
  let statusClass, statusText;
  if (isOpen) {
    if (nextChange && (nextChange - now) < 30 * 60 * 1000) {
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
    try { intervals = oh.getOpenIntervals(dayStart, dayEnd); } catch (e) {}

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

function renderOsmTags(tags, osmType, osmId) {
  const ROWS = [
    ['addr:street',     'Street',      false],
    ['addr:housenumber','Number',      false],
    ['addr:city',       'City',        false],
    ['addr:postcode',   'Postcode',    false],
    ['phone',           'Phone',       'tel'],
    ['website',         'Website',     'url'],
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

  for (const [key, label, linkType] of ROWS) {
    if (!tags[key]) continue;
    let value;
    if (linkType === 'url') {
      value = `<a href="${escapeHtml(tags[key])}" target="_blank" rel="nofollow">${escapeHtml(tags[key])}</a>`;
    } else if (linkType === 'tel') {
      value = `<a href="tel:${escapeHtml(tags[key])}">${escapeHtml(tags[key])}</a>`;
    } else {
      value = escapeHtml(tags[key]);
    }
    html += `<div class="feature-detail-row">
      <span class="feature-detail-label">${label}</span>
      <span class="feature-detail-value">${value}</span>
    </div>`;
  }

  if (!html) {
    html = '<div class="feature-detail-empty">No additional details available.</div>';
  }

  html += `<a class="feature-detail-osm-link"
    href="https://www.openstreetmap.org/${osmType}/${osmId}"
    target="_blank" rel="nofollow">View on OpenStreetMap</a>`;

  document.querySelector('#feature-panel-details').innerHTML = html;
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
      for (const [key, poi] of Object.entries(poiData)) {
        const label = poi[preferred] || poi['lang-en'];
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

  function searchPhoton(query) {
    const lang = window.navigator.language.substring(0, 2);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=${lang}`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => renderGeocoderResults(data.features))
      .catch(() => hideGeocoderResults());
  }

  function renderGeocoderResults(features) {
    results.innerHTML = '';
    if (!features || features.length === 0) {
      hideGeocoderResults();
      return;
    }

    features.forEach((feature) => {
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
