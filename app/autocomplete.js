$(function() {
    var availableTags = [
        {value: "Playground", data: "leisure=playground"}, 
        {value: "Tabletennis", data: "sport=table_tennis"}, 
        {value: "ATM", data: "amenity=atm"}, 
        {value: "Pharmacy", data: "amenity=pharmacy"}, 
        {value: "Cab stand", data: "amenity=taxi"}, 
        {value: "Fuel", data: "amenity=fuel"}, 
        {value: "Postbox", data: "amenity=post_box"},
        {value: "Telephone", data: "amenity=telephone"}, 
        {value: "Water", data: "amenity=drinking_water"}, 
        {value: "Charging", data: "amenity=charging_station"},
        {value: "Shelter", data: "amenity=shelter"},
        {value: "Public transport station", data: "public_transport=platform"}, 
        {value: "Bus station", data: "highway=bus_stop"},
        {value: "Library", data: "amenity=library"},
        {value: "Swimming pool", data: "amenity=swimming_pool"},
        {value: "Laundry", data: "shop=laundry"},
        {value: "Supermarket", data: "shop=supermarket"},
        {value: "Fast Food", data: "amenity=fast_food"},
        {value: "Recycling facility", data:"amenity=recycling"},
        {value: "Public toilet", data:"amenity=toilets"},
        {value: "Pub", data:"amenity=pub"},
        {value: "Café", data:"amenity=cafe"},
    ];

    availableTags.sort(function(a,b) {
        return a.value.localeCompare(b.value);;
    });

    $( "#mydropdown" ).autocomplete({
        minChars: 0,
        lookup: availableTags,
        onSelect: function(suggestion) {
            $('#tag_name').val(suggestion.data);
            loadPOIs();
        },
        triggerSelectOnValidInput: false,
        autoSelectFirst: true
    });

    $("#mydropdown").on("click", function () {
       $(this).select();
    });
  });