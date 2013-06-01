var map;
var pois = [];
var markerlayer;
var myLocation = null;
var OSM_URL = "http://overpass.osm.rambler.ru/cgi/interpreter?data=%5Bout:json%5D;";
var berlin;





function initMap() {
	markerlayer = L.layerGroup();
	berlin = new L.LatLng(52.5213616409873, 13.4101340342265); 

	map = new L.Map('map', {
		center: berlin,
		zoom: 13
	});

	// create a CloudMade tile layer
	var cloudmadeUrl = 'http://{s}.tile.cloudmade.com/120a22aa24a94b57a93ce17a1c6155e3/997/256/{z}/{x}/{y}.png', 		cloudmade = new L.TileLayer(cloudmadeUrl, {maxZoom: 18});
	var osmAttr = '&copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>';

	map.addLayer(cloudmade);
	map.addLayer(markerlayer); 
}
	

function loadPOI(tag) {

	//remove old markers
	markerlayer.clearLayers();
	
	//get map bounds from current window
	var southwest = map.getBounds().getSouthWest();
	var northeast = map.getBounds().getNorthEast();

	//build URL
	var OSM_PARAMS = "node["+tag+ "](" +southwest.lat+  ","  +southwest.lng+  ","  +northeast.lat+ "," +northeast.lng +");out;";
	console.log(OSM_PARAMS);
	var URL = OSM_URL + encodeURIComponent(OSM_PARAMS);


	//load POIs from OSM
	var markers = [];
	$.getJSON(URL, function(data) {
		
		//build markers
		pois = data['elements'];
		$.each(pois, function(index, poi) {
			lat = poi['lat'];
			lon = poi['lon'];
	    	markers.push(new L.Marker([lat, lon]));
	  	});	

	  	//add markers to map	
		console.log(markers);
		newmarkers = L.layerGroup(markers);
		markerlayer.addLayer(newmarkers);    

		//if no geolocation, finish here
		if(myLocation === null){
			return;
		}

		//find nearest marker
		var distance = Number.MAX_VALUE;
		var nearest = null;
		$.each(markers, function(i, marker) {
			temp = marker.getLatLng();
			dist = temp.distanceTo(myLocation);
			if(marker.getLatLng().distanceTo(myLocation) < distance) {
				distance = marker.getLatLng().distanceTo(myLocation);
				nearest = marker;
			}
		});

		//zoom map
		//map.panTo(nearest.getLatLng());
		map.fitBounds(new L.LatLngBounds([myLocation, nearest.getLatLng(), myLocation])); 

	});
}


function onLocationFound(e) {
    var radius = e.accuracy / 2;

    L.marker(e.latlng).addTo(map).bindPopup("You are within " + radius + " meters from this point").openPopup();

    L.circle(e.latlng, radius).addTo(map);
	myLocation = e.latlng;
}

function onLocationError(e) {
    alert(e.message);
}


window.onload = function() {


	initMap();

	// setup geolocation
	map.on('locationfound', onLocationFound);
	map.on('locationerror', onLocationError);
	map.locate({setView: true, maxZoom: 16});


	//setup dropdown listener
	$('#mydropdown').change(function() 
		{
		  var tag = "";
		  switch($(this).val())
		{
		case 'Playground':
		  tag="leisure=playground";
		  break;
		case 'Tabletennis':
		  tag="sport=table_tennis";
		  break;
		case 'ATM':
		  tag="amenity=atm";
		  break;
		case 'Taxi':
		  tag="amenity=taxi";
		  break;
		case 'Fuel':
		  tag="amenity=fuel";
		  break;
		case 'Postbox':
		  tag="amenity=post_box";
		  break;
		default:
		  tag='';
		  break;
		}
		
		//load POIs into map
		loadPOI(tag);
	});
	   
};
