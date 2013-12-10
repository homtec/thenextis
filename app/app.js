var map;
var pois = [];
var markerlayer;
var myLocation = null;
var OSM_URL = "http://overpass.osm.rambler.ru/cgi/interpreter?data=%5Bout:json%5D;";
var berlin;
var icon_user;
var mapDragged = false;



function initMap() {
	markerlayer = L.layerGroup();
	berlin = new L.LatLng(52.5213616409873, 13.4101340342265); 

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
		center: berlin,
		zoom: 13
	});

	// create a CloudMade tile layer
	var cloudmadeUrl = 'http://{s}.tile.cloudmade.com/97b13b2de7f543d784fbc30129b14ae0/1714@2x/256/{z}/{x}/{y}.png';
	var osmAttr = '&copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>';
	var attribution = 'Map data ' + osmAttr + ', Imagery &copy; <a href="http://cloudmade.com">CloudMade</a>';

	cloudmade = new L.TileLayer(cloudmadeUrl, {maxZoom: 18, attribution: attribution, detectRetina: true});
	map.addLayer(cloudmade);
	map.addLayer(markerlayer); 
}
	

function loadPOIs(manualRefresh) {
	console.log("loadPOIs called");
	var tag = getTag();
	if ( tag == '') return;

	//get map bounds from current window
	var southwest = map.getBounds().getSouthWest();
	var northeast = map.getBounds().getNorthEast();

	//build URL
	//search around only if map not dragged, otherwise search in map window
	//but only with appropriate zoom level

	if(!manualRefresh && !mapDragged)
	{
		//search around user position
		var OSM_PARAMS = "node["+tag+ "](around:2000," +myLocation.lat+  ","  +myLocation.lng+ ");out;";
	} else {
		//don't search in big areas
		if(map.getZoom() < 13) {
			alert("Please zoom in");		
			return;
		}
		//search in current map window
		var OSM_PARAMS = "(way["+tag+ "](" +southwest.lat+  ","  +southwest.lng+  ","  +northeast.lat+ "," +northeast.lng +");>;" + "node["+tag+ "](" +southwest.lat+  ","  +southwest.lng+  ","  +northeast.lat+ "," +northeast.lng +"););out;";
	}

	console.log(OSM_PARAMS);
	var URL = OSM_URL + encodeURIComponent(OSM_PARAMS);

	//remove old markers
	markerlayer.clearLayers();

	//show loading indicator
	$("#loading").show();

	//load POIs from OSM	
	var markers = [];
	$.getJSON(URL)
	.done( function(data) {

		//remove loading indicator
		$("#loading").hide()		

		//build markers
		pois = data['elements'];

		if(pois.length == 0) {
			//$('#modal_no_pois').modal();
			
			// show a no POI alert - ToDo: remove alert, show short notice on site  
			alert("Sorry, no POI in this area. Zoom out or pan the map.");
			return;
		};
		
		$.each(pois, function(index, poi) {
			lat = poi['lat'];
			lon = poi['lon'];
                        popuptext = "";
                        if(typeof poi['tags']['name'] != 'undefined')
                                popuptext += poi['tags']['name'] + "</br>";
                        if(typeof poi['tags']['operator'] != 'undefined')
                                popuptext += poi['tags']['operator'] + "</br>";
                        if(typeof poi['tags']['collection_times'] != 'undefined')
                                popuptext += poi['tags']['collection_times'] + "</br>";
                        if(typeof poi['tags']['opening_hours'] != 'undefined')
                                popuptext += poi['tags']['opening_hours'] + "</br>";
                        if(typeof poi['tags']['phone'] != 'undefined')
                                popuptext += poi['tags']['phone'] + "</br>";
                        if(typeof poi['tags']['website'] != 'undefined')
                                popuptext += '<a href="' + poi['tags']['website'] + '" target="_blank" rel="nofollow">' + poi['tags']['website'] + '</a></br>';
                        markers.push(new L.Marker([lat, lon]).bindPopup(getTagName() + "</br>" + popuptext));
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
		})

		//zoom map
		if(!manualRefresh && !mapDragged) {
			map.fitBounds(new L.LatLngBounds([myLocation, nearest.getLatLng(), myLocation])); 
		}

	})
	.fail( function(jqxhr, textStatus, error ) {
		var err = textStatus + ', ' + error;
		console.log( "Request Failed: " + err);
	});
}


function onLocationFound(e) {
    var radius = e.accuracy / 2;

    L.marker(e.latlng, {icon: icon_user}).addTo(map).bindPopup("You are somewhere here").openPopup();

    L.circle(e.latlng, radius).addTo(map);
	myLocation = e.latlng;
}

function onLocationError(e) {
    alert(e.message);
}

function onMapDragged(){
	mapDragged = true;
}

function getTagName(){
	var tagName = "";
	tagName = $('#mydropdown :selected').text();
        return tagName;
}

function getTag() {
        var tag = "";
	var selection = $('#mydropdown').val();

	  switch(selection)
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
	case 'Pharmacy':
	  tag="amenity=pharmacy";
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
	case 'Telephone':
	  tag="amenity=telephone";
	  break;
	case 'Water':
	  tag="amenity=drinking_water";
	  break;
	case 'Charging':
	  tag="amenity=charging_station";
	  break;
        case 'Bus station':
	  tag="highway=bus_stop";
	  break;
	default:
	  tag='';
	  break;
	}
	
	return tag;
}

function reloadCurrentMapWindow() {
	//get current zoom level and check
    //get current map coordinates

	//get current tag
	//go
}	


$(function() {


	initMap();

	// setup geolocation
	map.on('locationfound', onLocationFound);
	map.on('locationerror', onLocationError);
	map.on('dragend', onMapDragged);
	map.locate({setView: true, maxZoom: 16});


	//setup dropdown listener
	$('#mydropdown').change(function() 
		{
		loadPOIs();
	});   

	//set onClick for refresh button
	$('#redo_link').click(function(){loadPOIs(true);});
    $('#locateMe_link').click(function(){locateMe();});
    $('#editOSM_link').click(function(){editOSM();});
    
});

function locateMe() {
	map.locate({setView: true, maxZoom: 16});
    mapDragged = false;
}	

function editOSM() {
        var center = map.getCenter();
        var z = map.getZoom();
        window.open('http://www.openstreetmap.org/edit?' + 'zoom=' + z +
            '&editor=id' + '&lat=' + center.lat + '&lon=' + center.lng);
    }
