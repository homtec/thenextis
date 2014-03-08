var map;
var pois = [];
var markerlayer;
var waylayer;
var myLocation = null;
var OSM_URL = "http://overpass.osm.rambler.ru/cgi/interpreter?data=%5Bout:json%5D;";
var berlin = new L.LatLng(52.5213616409873, 13.4101340342265);
var icon_user;
var mapDragged = false;
var way;
var myLocationMarker = null;
var myLocationCircle = null;
var isMobile = false;



function initMap(loc, zoom) {
	

    
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
		zoom: zoom
	});

	// create a CloudMade tile layer
	var cloudmadeUrl = 'http://{s}.tile.cloudmade.com/97b13b2de7f543d784fbc30129b14ae0/1714@2x/256/{z}/{x}/{y}.png';
	var osmAttr = '&copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>';
	var attribution = 'Map data ' + osmAttr + ', Imagery &copy; <a href="http://cloudmade.com">CloudMade</a>';

	cloudmade = new L.TileLayer(cloudmadeUrl, {maxZoom: 18, attribution: attribution, detectRetina: true});
	map.addLayer(cloudmade);
	map.addLayer(markerlayer);
        map.addLayer(waylayer);
}
	

function loadPOIs(manualRefresh) {
	console.log("loadPOIs called");
	var tags = getTag();
	if ( tags == '') return;
	
	var OSM_PARAMS = "";
	tag = tags.split(";");

	//get map bounds from current window
	var southwest = map.getBounds().getSouthWest();
	var northeast = map.getBounds().getNorthEast();

	//build URL
	//search around only if map not dragged, otherwise search in map window
	//but only with appropriate zoom level

	if(!manualRefresh && !mapDragged)
	{
		//search around user position
		for (var i in tag) {
			OSM_PARAMS += "way["+tag[i]+ "](around:2000," +myLocation.lat+  ","  +myLocation.lng+ ");>;" +"node["+tag[i]+ "](around:2000," +myLocation.lat+  ","  +myLocation.lng+ ");";
		}
		OSM_PARAMS = "(" + OSM_PARAMS + ");out;";
	
	} else {
		//don't search in big areas
		if(map.getZoom() < 13) {
			alert("Please zoom in");		
			return;
		}
		//search in current map window
		for (var i in tag) {
			OSM_PARAMS += "way["+tag[i]+ "](" +southwest.lat+  ","  +southwest.lng+  ","  +northeast.lat+ "," +northeast.lng +");>;" + "node["+tag[i]+ "](" +southwest.lat+  ","  +southwest.lng+  ","  +northeast.lat+ "," +northeast.lng +");";
		}
		OSM_PARAMS = "(" + OSM_PARAMS + ");out;";
	
	}

	console.log(OSM_PARAMS);
	var URL = OSM_URL + encodeURIComponent(OSM_PARAMS);

	//remove old markers
	markerlayer.clearLayers();
        waylayer.clearLayers();

	//show loading indicator
    if(isMobile) {
        $("#loading").css("visibility", "visible");
    }
    else{
        $("#loading").show();
    }
	//load POIs from OSM	
	var markers = [];
        var ways = [];
	$.getJSON(URL)
	.done( function(data) {

		
        //remove loading indicator
        if(isMobile) {
        $("#loading").css("visibility", "hidden");
        }
        else{
            $("#loading").hide();
        }

		//build markers
		pois = data['elements'];

		if(pois.length == 0) {
			//$('#modal_no_pois').modal();
			
			// show a no POI alert - ToDo: remove alert, show short notice on site  
			alert("Sorry, no POI in this area. Zoom out or pan the map.");
            
			return;
		};
		_paq.push(['trackPageView', 'POIFound']);
        _paq.push(['trackGoal', 1]);
		$.each(pois, function(index, poi) {
                        popuptext = "";
                        if(poi['type'] == 'node' && typeof poi['tags'] != 'undefined'){
                                lat = poi['lat'];
                                lon = poi['lon'];
                                popuptext = getPopupText(poi);
                                markers.push(new L.Marker([lat, lon]).bindPopup(getTagName() + "</br>" + popuptext));
                        }
                        if(poi['type'] == 'way' && typeof poi['tags'] != 'undefined'){
                                way = new L.polygon({color: 'blue'});
                                $.each(poi['nodes'], function(index, poinode) {
                                        $.each(pois, function(index, waynode) {
                                                if (waynode['id'] == poinode){
                                                        //console.log(waynode);
                                                        way.addLatLng(new L.latLng(waynode['lat'], waynode['lon']));
                                                        //console.log(way);
                                                }
                                        });
                                });
                                popuptext = getPopupText(poi);
                                
                                //add polygon to map
                                ways.push(way.bindPopup(getTagName() + "</br>" + popuptext));
                                
                                //add aditional marker at polygons bbox center
                                markers.push(new L.Marker(way.getBounds().getCenter()).bindPopup(getTagName() + "</br>" + popuptext));
                        }
	  	});	

	  	//add markers to map
		newmarkers = L.layerGroup(markers);
		markerlayer.addLayer(newmarkers);    
                
                //add polygons to map
                newways = L.layerGroup(ways);
		waylayer.addLayer(newways);

		//if no geolocation, finish here
		if(myLocation === null){
			return;
		}

		//find nearest marker
		var distance = Number.MAX_VALUE;
		var nearest = null;
		$.each(markers, function(i, marker) {
			temp = marker.getLatLng();
			if(temp.distanceTo(myLocation) < distance) {
				distance = temp.distanceTo(myLocation);
				nearest = temp;
			}
		})
                
                //find nearest polygon 
		$.each(ways, function(i, polygon) {
			temp = polygon.getBounds().getCenter();
			if(temp.distanceTo(myLocation) < distance) {
				distance =temp.distanceTo(myLocation);
				nearest = temp;
			}
		})

		//zoom map
		if(!manualRefresh && !mapDragged) {
			map.fitBounds(new L.LatLngBounds([myLocation, nearest], {padding:[10,10]})); 
		}

	})
	.fail( function(jqxhr, textStatus, error ) {
		var err = textStatus + ', ' + error;
		console.log( "Request Failed: " + err);
	});
}


function onLocationFound(e) {
    var radius = e.accuracy / 2;
    
    //opt: remove old marker
    if(myLocationMarker != null) {
        map.removeLayer(myLocationMarker);
        map.removeLayer(myLocationCircle);
    }

    //draw stuff
    myLocationMarker = L.marker(e.latlng, {icon: icon_user});
    myLocationMarker.addTo(map).bindPopup("You are somewhere here").openPopup();
    myLocationCircle = L.circle(e.latlng, radius);
    myLocationCircle.addTo(map);
	
    //save current location
    myLocation = e.latlng;
    
    //update browser URL
    updateHashURL();
    
    _paq.push(['trackPageView', 'LocationFound']);
}

function onLocationError(e) {
    _paq.push(['trackPageView', 'LocationError']);
    alert(e.message);
}

function onMapDragged(){
	mapDragged = true;
    updateHashURL();
}

function onMapZoomed() {
    updateHashURL();
}

function getTagName(){
	var tagName = "";
	tagName = $('#mydropdown').val();
        return tagName;
}

function getTag() {
	if (isMobile) {
		var tag = "";
		var selection = $('#mydropdown').val();
		
		// OSM-Tag preset for mobile
		switch(selection)
		{
		case 'Playground':
		  tag="leisure=playground";
		  break;
		case 'Tabletennis':
		  tag="sport=table_tennis";
		  break;
		case 'ATM':
		  tag="amenity=atm;atm=yes";
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
	} else {
		tag = $('#tag_name').val();
	}
    _paq.push(['trackPageView', 'Selection/' + tag]);
    return tag;
}

function reloadCurrentMapWindow() {
	//get current zoom level and check
    //get current map coordinates

	//get current tag
	//go
}	


$(function() {
    
    //detect if mobile
    if(window.location.pathname.indexOf('mobile') > -1) {
        isMobile = true;
    }
    
    //detect if url parameter existing
    var hash = window.location.hash;
    var type = null;
    var url_location = null;
    
    var startloc = berlin;
    var startzoom = 13;
    
    if (hash.length > 0) {
        hash = hash.replace('#', '');
        var params = hash.split('&');
        
        $.each(params, function(i, param) {
            var setting = param.split('=');
            switch(setting[0]) 
            {
                case "map" : url_location = setting[1];
                case "type" : type = setting[1];
            }
        
        });


    }
    
    if(url_location) {
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
    if(!url_location) {
        locateMe();    
    }
    
    
    if(type) {
        //search for POI
    }



	if (isMobile)
	//setup dropdown listener
		$('#mydropdown').change(function() 
			{
			loadPOIs();
		});   
	else {
		$('#tag_name').change(function() 
			{
		loadPOIs();
		});  
	}

	//set onClick for refresh button
	$('#reload-button').click(function(){loadPOIs(true);});
    $('#locateMe-button').click(function(){locateMe();});
    $('#editOSM-button').click(function(){editOSM();});
    
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

function getPopupText(poi) {
        if(typeof poi['tags']['name'] != 'undefined')
                popuptext += poi['tags']['name'] + "</br>";
        if(typeof poi['tags']['operator'] != 'undefined')
                popuptext += poi['tags']['operator'] + "</br>";
        if(typeof poi['tags']['collection_times'] != 'undefined')
                popuptext += poi['tags']['collection_times'] + "</br>";
        if(typeof poi['tags']['opening_hours'] != 'undefined')
                popuptext += poi['tags']['opening_hours'] + "</br>";
        if(typeof poi['tags']['phone'] != 'undefined')
                popuptext += '<a href="tel:' + poi['tags']['phone'] + '">' + poi['tags']['phone'] + '</a></br>';
        if(typeof poi['tags']['website'] != 'undefined')
                popuptext += '<a href="' + poi['tags']['website'] + '" target="_blank" rel="nofollow">' + poi['tags']['website'] + '</a></br>';
    
        if( poi['tags']['recycling:clothes'] == 'yes')
                popuptext += "Clothes" + "</br>";
        if( poi['tags']['recycling:paper'] == 'yes')
                popuptext += "Paper" + "</br>";
        if( poi['tags']['recycling:glass'] == 'yes')
                popuptext += "Glass" + "</br>";
        if( poi['tags']['recycling:garden_waste'] == 'yes')
                popuptext += "Garden waste" + "</br>";
    
        return popuptext;
}


function updateHashURL() {
    
    var urlhash_location = "map=" + map.getZoom() + '/' + map.getCenter().lat.toFixed(5) + '/' + map.getCenter().lng.toFixed(5);
    history.replaceState(null, null, window.location.origin + "/#" + urlhash_location);
}

