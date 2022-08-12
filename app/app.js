var map;
var pois = [];
var markerlayer;
var waylayer;
var myLocation = null;
var OSM_URL = "https://z.overpass-api.de/api/interpreter?data=%5Bout:json%5D;";
var berlin = new L.LatLng(52.5213616409873, 13.4101340342265);
var icon_user;
var mapDragged = false;
var way;
var myLocationMarker = null;
var myLocationCircle = null;
var poiData = null;

window.onload = init();

function initMap(loc, zoom) {
  console.log("init map called")


  markerlayer = L.layerGroup();
  waylayer = L.layerGroup();



  icon_user = L.icon({
    iconUrl: 'app/images/user.svg',
    iconRetinaUrl: 'app/images/user.png',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [10, -20],
    //   shadowUrl: 'my-icon-shadow.png',
    //   shadowRetinaUrl: 'my-icon-shadow@2x.png',
    shadowSize: [68, 95],
    shadowAnchor: [22, 94]
  });


  map = new L.Map('map', {
    center: loc,
    zoom: zoom,
    worldCopyJump: true
  });

  // create a CloudMade tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);


  map.addLayer(markerlayer);
  map.addLayer(waylayer);
}


function loadPOIs(manualRefresh) {
  var i;
  console.log("loadPOIs called");
  var tags = getTag();
  if (tags === '') return;

  var OSM_PARAMS = "";
  var tag = tags.split(";");

  //get map bounds from current window
  var southwest = map.getBounds().getSouthWest();
  var northeast = map.getBounds().getNorthEast();

  //build URL
  //search around only if map not dragged, otherwise search in map window
  //but only with appropriate zoom level

  if (!manualRefresh && !mapDragged) {
    //search around user position
    for (i in tag) {
      OSM_PARAMS += "way[" + tag[i] + "](around:2000," + myLocation.lat + "," + myLocation.lng + ");>;" +
        "node[" + tag[i] + "](around:2000," + myLocation.lat + "," + myLocation.lng + ");";
    }
    OSM_PARAMS = "(" + OSM_PARAMS + ");out;";

  } else {
    //don't search in big areas
    if (map.getZoom() < 13) {
      alert("Please zoom in");
      return;
    }
    //search in current map window
    for (i in tag) {
      OSM_PARAMS += "way[" + tag[i] + "](" + southwest.lat + "," + southwest.lng + "," +
        northeast.lat + "," + northeast.lng + ");>;" + "node[" + tag[i] + "](" + southwest.lat + "," + southwest.lng + "," + northeast.lat + "," + northeast.lng + ");";
    }
    OSM_PARAMS = "(" + OSM_PARAMS + ");out;";

  }

  console.log(OSM_PARAMS);
  var URL = OSM_URL + encodeURIComponent(OSM_PARAMS);

  //remove old markers
  markerlayer.clearLayers();
  waylayer.clearLayers();

  //show loading indicator
  document.querySelector("#loading").style.visibility = "visible";

  //load POIs from OSM
  var markers = [];
  var ways = [];

  fetch(URL)
  .then((response) => {
    if (!response.ok) {
      throw Error(response.statusText);
    }

    return response.json()
  })
  .then((data) => {
      //remove loading indicator
      document.querySelector("#loading").style.visibility = "hidden";


      //build markers
      pois = data.elements;

      if (pois.length === 0) {
        // show a no POI alert - ToDo: remove alert, show short notice on site
        alert("Sorry, no POI in this area. Zoom out or pan the map.");
        return;
      }
      //ga('send', 'event', 'poisearch', 'got_results', pois.length);
      for (let poi of pois) {
        var popuptext = "";
        if (poi.type == 'node' && typeof poi.tags != 'undefined') {
          lat = poi.lat;
          lon = poi.lon;
          popuptext = getPopupText(poi);
          markers.push(new L.Marker([lat, lon]).bindPopup(getTagName() + "</br>" + popuptext));
        }
        if (poi.type == 'way' && typeof poi.tags != 'undefined') {
          way = new L.polygon({ color: 'blue' });
          for(let poinote of poi.nodes) {
            for(let waynode of pois) {
              if (waynode.id == poinode) {
                //console.log(waynode);
                way.addLatLng(new L.latLng(waynode.lat, waynode.lon));
                //console.log(way);
              }
            };
          };
          popuptext = getPopupText(poi);

          //add polygon to map
          ways.push(way.bindPopup(getTagName() + "</br>" + popuptext));

          //add aditional marker at polygons bbox center
          markers.push(new L.Marker(way.getBounds().getCenter()).bindPopup(getTagName() + "</br>" + popuptext));
        }
      };

      //add markers to map
      newmarkers = L.layerGroup(markers);
      markerlayer.addLayer(newmarkers);

      //add polygons to map
      newways = L.layerGroup(ways);
      waylayer.addLayer(newways);

      //if no geolocation, finish here
      if (myLocation === null) {
        return;
      }

      //find nearest marker
      var distance = Number.MAX_VALUE;
      var nearest = null;
      var temp;
      for(let marker of markers) {
        temp = marker.getLatLng();
        if (temp.distanceTo(myLocation) < distance) {
          distance = temp.distanceTo(myLocation);
          nearest = temp;
        }
      };

      //find nearest polygon
      for(let polygon of ways) {
        temp = polygon.getBounds().getCenter();
        if (temp.distanceTo(myLocation) < distance) {
          distance = temp.distanceTo(myLocation);
          nearest = temp;
        }
      };

      //zoom map
      if (!manualRefresh && !mapDragged) {
        map.fitBounds(new L.LatLngBounds([myLocation, nearest], { padding: [10, 10] }));
      }

    })
    .catch((error) => {
      console.log("Request Failed: " + error);
    });
}


function onLocationFound(e) {
  var radius = e.accuracy / 2;

  //opt: remove old marker
  if (myLocationMarker !== null) {
    map.removeLayer(myLocationMarker);
    map.removeLayer(myLocationCircle);
  }

  //draw stuff
  myLocationMarker = L.marker(e.latlng, { icon: icon_user });
  myLocationMarker.addTo(map).bindPopup("You are somewhere here").openPopup();
  myLocationCircle = L.circle(e.latlng, radius);
  myLocationCircle.addTo(map);

  //save current location
  myLocation = e.latlng;

  //update browser URL
  updateHashURL();

  //ga('send', 'event', 'geolocation', 'found');
}

function onLocationError(e) {
  //ga('send', 'event', 'geolocation', 'LocationError');
  alert(e.message);
}

function onMapDragged() {
  mapDragged = true;
  updateHashURL();
}

function onMapZoomed() {
  updateHashURL();
}

function getTagName() {
  var tagName = "";
  tagName = poiData[document.querySelector('#mydropdown').value]["lang-en"];
  return tagName;
}

function getTag() {
  var tag = "";
  var selection = document.querySelector('#mydropdown').value;

  // OSM-Tag preset for mobile
  //search tag in object
  console.log(poiData);
  var tagdata = poiData[selection].osm;
  if (tagdata)
    tag = tagdata;


  //ga('send', 'event', 'poisearch', 'search_for', tag);
  return tag;
}

function reloadCurrentMapWindow() {
  //get current zoom level and check
  //get current map coordinates

  //get current tag
  //go
}


//init function
function init() {
  console.log("init called")


  //detect if url parameter existing
  var hash = window.location.hash;
  var type = null;
  var url_location = null;

  var startloc = berlin;
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
    };
  }

  if (url_location) {
    //new location and zoom to
    var loc_array = url_location.split('/');
    startloc = new L.LatLng(loc_array[1], loc_array[2]);
    startzoom = loc_array[0];

    // set dragged -> search in current map
    mapDragged = true;
  }


  initMap(startloc, startzoom);

  // setup geolocation
  map.on('locationfound', onLocationFound);
  map.on('locationerror', onLocationError);
  map.on('dragend', onMapDragged);
  map.on('zoomend', onMapZoomed);


  //start location detection if no location preset
  if (!url_location) {
    locateMe();
  }


  if (type) {
    //search for POI
  }





  //load dropdown OSM data
  loadPOIdataFromFile();

  //setup dropdown listener
  document.querySelector('#mydropdown').onchange = function () {
    loadPOIs();
  };



  //set onClick for refresh button
  document.querySelector('#reload-button').onclick = function () { loadPOIs(true); };
  document.querySelector('#locateMe-button').onclick = function () { locateMe(); };
  document.querySelector('#info-button').onclick = function () { showInfo(); };
  document.querySelector('#editOSM-button').onclick = function () { editOSM(); };
  document.querySelector('#info_overlay').onclick = function () { hideInfo(); };


}

function locateMe() {
  map.locate({ setView: true, maxZoom: 16 });
  mapDragged = false;
}

function showInfo() {
  document.querySelector("#info_overlay").style.visibility = "visible";
}

function hideInfo() {
  document.querySelector("#info_overlay").style.visibility = "hidden";
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
    popuptext += poi.tags.name + "</br>";
  if (typeof poi.tags.operator != 'undefined')
    popuptext += poi.tags.operator + "</br>";
  if (typeof poi.tags.collection_times != 'undefined')
    popuptext += poi.tags.collection_times + "</br>";
  if (typeof poi.tags.opening_hours != 'undefined')
    popuptext += poi.tags.opening_hours + "</br>";
  if (typeof poi.tags.phone != 'undefined')
    popuptext += '<a href="tel:' + poi.tags.phone + '">' + poi.tags.phone + '</a></br>';
  if (typeof poi.tags.website != 'undefined')
    popuptext += '<a href="' + poi.tags.website + '" target="_blank" rel="nofollow">' + poi.tags.website + '</a></br>';

  if (poi.tags['recycling:clothes'] == 'yes')
    popuptext += "Clothes" + "</br>";
  if (poi.tags['recycling:paper'] == 'yes')
    popuptext += "Paper" + "</br>";
  if (poi.tags['recycling:glass'] == 'yes')
    popuptext += "Glass" + "</br>";
  if (poi.tags['recycling:garden_waste'] == 'yes')
    popuptext += "Garden waste" + "</br>";

  return popuptext;
}


function updateHashURL() {

  var urlhash_location = "map=" + map.getZoom() + '/' + map.getCenter().lat.toFixed(5) + '/' + map.getCenter().lng.toFixed(5);
  history.replaceState(null, null, window.location.origin + "/#" + urlhash_location);
}

function loadPOIdataFromFile() {

  fetch("content.json")
    .then((response) => response.json())
    .then((data) => {
      console.log(data);

      //save to global var
      poiData = data;
      fillMobileSelectionBox(poiData);
    });
}

function fillMobileSelectionBox(data) {

  //language detection
  var default_lang = "lang-en";
  var preferred_lang = "lang-" + window.navigator.language.substring(0, 2);


  //fill list
  for (const [key, poi] of Object.entries(data)) {
    console.log(poi["lang-en"]);
    var text = poi.hasOwnProperty(preferred_lang) ? poi[preferred_lang] : poi[default_lang];

    //add entry to drop down list
    const opt = document.createElement("option");
    opt.value = key;
    opt.text = text;
    document.querySelector('#mydropdown').add(opt, null);
  };


}

