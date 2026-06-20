/* ================================================================
   SOKONI — Routing & Geocoding  (sokoni-routing.js)
   Deterministic route calculation via OSRM + Nominatim.
   Falls back to straight-line × 1.4 road factor if OSRM is down.
   Loaded as a regular <script> — exposes window.SokoniRouting.
================================================================ */
(function (g) {
  'use strict';

  /* ── Haversine great-circle distance in km ── */
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371,
      dLat = ((lat2 - lat1) * Math.PI) / 180,
      dLng = ((lng2 - lng1) * Math.PI) / 180,
      a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── Fare table — delivery vehicle fare rates ── */
  var FARE_TABLE = {
    moto:   { base: 80,  perKm: 15 },
    car:    { base: 200, perKm: 35 },
    tuktuk: { base: 120, perKm: 20 },
    ebike:  { base: 60,  perKm: 10 },
    van:    { base: 400, perKm: 50 },
    pickup: { base: 600, perKm: 70 },
  };

  /* ── Fetch with explicit timeout (AbortController, not AbortSignal.timeout) ── */
  function fetchT(url, opts, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 9000);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .finally(function () { clearTimeout(t); });
  }

  /* ── Nominatim in-memory cache: key = query string, value = result ── */
  var _geocodeCache = {};

  var SokoniRouting = {

    /* ── Haversine helper (exposed for use in matching logic) ── */
    haversine: haversine,

    /* ─────────────────────────────────────────
       geocode(query) → { lat, lng, display } | null
       Accepts plain "lat,lng" coords or a text address.
    ───────────────────────────────────────── */
    geocode: async function (query) {
      if (!query || !query.trim()) return null;

      /* Already coordinates? */
      var m = query.trim().match(/^(-?\d{1,3}\.?\d*),\s*(-?\d{1,3}\.?\d*)$/);
      if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), display: query.trim() };

      var key = query.trim().toLowerCase();
      if (_geocodeCache[key]) return _geocodeCache[key];

      try {
        var url =
          'https://nominatim.openstreetmap.org/search?q=' +
          encodeURIComponent(query.trim() + ', Kenya') +
          '&format=json&limit=1&accept-language=en&countrycodes=ke';
        var res = await fetchT(url, { headers: { 'User-Agent': 'SOKONI/1.0 mysokoni.co.ke' } }, 9000);
        if (!res.ok) return null;
        var data = await res.json();
        if (!data.length) return null;
        var result = {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          display: data[0].display_name,
        };
        _geocodeCache[key] = result;
        return result;
      } catch (e) {
        console.warn('[SokoniRouting] geocode:', e.message);
        return null;
      }
    },

    /* ─────────────────────────────────────────
       getRoute(fromLat, fromLng, toLat, toLng)
       → { distanceKm, durationMin, geometry } | null
    ───────────────────────────────────────── */
    getRoute: async function (fromLat, fromLng, toLat, toLng) {
      try {
        var url =
          'https://router.project-osrm.org/route/v1/driving/' +
          fromLng + ',' + fromLat + ';' +
          toLng + ',' + toLat +
          '?overview=full&geometries=geojson';
        var res = await fetchT(url, {}, 12000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var d = await res.json();
        if (d.code !== 'Ok' || !d.routes || !d.routes.length) throw new Error('No route');
        var r = d.routes[0];
        return {
          distanceKm: Math.round(r.distance / 100) / 10,  /* metres → km, 1dp */
          durationMin: Math.round(r.duration / 60),
          geometry: r.geometry,                            /* GeoJSON LineString */
        };
      } catch (e) {
        console.warn('[SokoniRouting] OSRM:', e.message);
        return null;
      }
    },

    /* ─────────────────────────────────────────
       calcFare(vehicleId, distanceKm) → integer KES
       Deterministic — same route always same fare.
    ───────────────────────────────────────── */
    calcFare: function (vehicleId, distanceKm) {
      var v = FARE_TABLE[vehicleId] || FARE_TABLE.moto;
      return Math.round(v.base + distanceKm * v.perKm);
    },

    /* ─────────────────────────────────────────
       calcRoute(pickupText, dropoffText, vehicleId)
       → { from, to, distanceKm, durationMin, fare, geometry, fallback? }
          OR { error: string }
    ───────────────────────────────────────── */
    calcRoute: async function (pickupText, dropoffText, vehicleId) {
      var results = await Promise.all([
        this.geocode(pickupText),
        this.geocode(dropoffText),
      ]);
      var from = results[0], to = results[1];
      if (!from || !to) {
        return {
          error:
            'Could not find ' +
            (!from ? '"' + pickupText + '"' : '"' + dropoffText + '"') +
            '. Try a more specific address (e.g. "Westlands, Nairobi").',
        };
      }

      var route = await this.getRoute(from.lat, from.lng, to.lat, to.lng);
      var distanceKm, durationMin, geometry, fallback;
      if (route) {
        distanceKm = route.distanceKm;
        durationMin = route.durationMin;
        geometry = route.geometry;
      } else {
        /* Straight-line × 1.4 road-distance factor */
        distanceKm = Math.round(haversine(from.lat, from.lng, to.lat, to.lng) * 1.4 * 10) / 10;
        durationMin = Math.round(distanceKm * 3);
        geometry = null;
        fallback = true;
      }
      if (distanceKm < 0.3) distanceKm = 0.3; /* minimum viable trip */

      return {
        from: from,
        to: to,
        distanceKm: distanceKm,
        durationMin: durationMin,
        fare: this.calcFare(vehicleId, distanceKm),
        geometry: geometry,
        fallback: fallback || false,
      };
    },
  };

  g.SokoniRouting = SokoniRouting;

})(window);
