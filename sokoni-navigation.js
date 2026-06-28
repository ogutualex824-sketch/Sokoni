/* ==========================================================================
   SOKONI Navigation Engine v1.0  (sokoni-navigation.js)
   Real-time GPS navigation · Turn-by-turn · Geofencing · Offline support
   Works with OSRM for routing (same as sokoni-routing.js) and Leaflet for maps.
   Exposes window.SokoniNavigation and window.SokoniNavOptimize.
========================================================================== */
(function (g) {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────────── */
  var OSRM_BASE          = 'https://router.project-osrm.org/route/v1';
  var ARRIVAL_RADIUS_M   = 60;    // metres — triggers "arrived" geofence
  var DEVIATION_M        = 160;   // metres from route before recalculation
  var UPLOAD_INTERVAL_MS = 4000;  // Firestore location write cadence (moving)
  var SMOOTH_K           = 0.25;  // bearing smoothing factor
  var DB_NAME            = 'sokoni_nav_v1';
  var STEP_ADVANCE_M     = 30;    // metres from step maneuver point → advance

  /* ── Haversine distance in metres ───────────────────────────────────────── */
  function _hav(lat1, lng1, lat2, lng2) {
    var R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180,
      dLng = (lng2 - lng1) * Math.PI / 180,
      a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── Bearing (degrees, 0 = North) ──────────────────────────────────────── */
  function _bearing(lat1, lng1, lat2, lng2) {
    var dLng = (lng2 - lng1) * Math.PI / 180,
      y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180),
      x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
        - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  /* ── Distance from point to polyline ──────────────────────────────────── */
  function _distToRoute(lat, lng, coords) {
    var min = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var lng1 = coords[i][0], lat1 = coords[i][1];
      var lng2 = coords[i + 1][0], lat2 = coords[i + 1][1];
      var A = lat - lat1, B = lng - lng1, C = lat2 - lat1, D = lng2 - lng1;
      var dot = A * C + B * D, lenSq = C * C + D * D;
      var t = lenSq > 0 ? Math.max(0, Math.min(1, dot / lenSq)) : 0;
      min = Math.min(min, _hav(lat, lng, lat1 + t * C, lng1 + t * D));
    }
    return min;
  }

  /* ── Maneuver icon from OSRM step ───────────────────────────────────────── */
  function _icon(step) {
    var t = (step.maneuver || {}).type || '', m = (step.maneuver || {}).modifier || '';
    if (t === 'depart')                     return '🚦';
    if (t === 'arrive')                     return '📍';
    if (t === 'roundabout' || t === 'rotary') return '🔄';
    if (t === 'merge')                      return '↗';
    if (t === 'fork')                       return '⑂';
    if (m === 'uturn')                      return '↩';
    if (m === 'sharp left')                 return '↰';
    if (m === 'sharp right')                return '↱';
    if (m === 'left' || m === 'slight left') return '↰';
    if (m === 'right' || m === 'slight right') return '↱';
    return '⬆';
  }

  /* ── Human-readable instruction from OSRM step ─────────────────────────── */
  function _instruction(step, stopName) {
    var t = (step.maneuver || {}).type || '', m = (step.maneuver || {}).modifier || '';
    if (t === 'arrive') return 'Arrive at ' + (stopName || 'destination');
    if (t === 'depart') return 'Head ' + m + (step.name ? ' on ' + step.name : '');
    if (t === 'roundabout') return 'Take exit from roundabout';
    if (m === 'left' || m === 'sharp left') return 'Turn left' + (step.name ? ' onto ' + step.name : '');
    if (m === 'right' || m === 'sharp right') return 'Turn right' + (step.name ? ' onto ' + step.name : '');
    if (m === 'slight left') return 'Keep left' + (step.name ? ' on ' + step.name : '');
    if (m === 'slight right') return 'Keep right' + (step.name ? ' on ' + step.name : '');
    if (m === 'straight') return 'Continue straight' + (step.name ? ' on ' + step.name : '');
    if (m === 'uturn') return 'Make a U-turn';
    return (step.name ? 'Continue on ' + step.name : 'Continue');
  }

  /* ── Format distance ─────────────────────────────────────────────────────── */
  function _fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }

  /* ── Format duration ─────────────────────────────────────────────────────── */
  function _fmtTime(sec) {
    if (sec < 60) return Math.round(sec) + ' sec';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  /* ── Fetch with abort timeout ────────────────────────────────────────────── */
  function _fetchT(url, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 10000);
    return fetch(url, { signal: ctrl.signal }).finally(function () { clearTimeout(t); });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SokoniNavigation — main class
  ═══════════════════════════════════════════════════════════════════════ */
  function SokoniNavigation(opts) {
    opts = opts || {};
    this._riderId  = opts.riderId  || null;
    this._tripId   = opts.tripId   || null;
    this._vehicle  = opts.vehicle  || 'motorcycle'; // motorcycle|driving|cycling
    this._cbs      = {
      positionUpdate: opts.onPositionUpdate || null,
      etaUpdate:      opts.onEtaUpdate      || null,
      stepChange:     opts.onStepChange     || null,
      arrival:        opts.onArrival        || null,
      deviation:      opts.onDeviation      || null,
      recalculated:   opts.onRecalculated   || null,
      error:          opts.onError          || null,
      offlineQueued:  opts.onOfflineQueued  || null,
    };

    this._stops          = [];   // [{lat,lng,name,type,id,status,phone?,orderId?}]
    this._stopIdx        = 0;    // current stop index
    this._route          = null; // OSRM route object
    this._routeCoords    = [];   // [[lng,lat],...] for deviation check
    this._steps          = [];   // flat array of all OSRM steps (all legs)
    this._stepIdx        = 0;
    this._pos            = null; // {lat,lng,bearing,speed,accuracy}
    this._smoothBrg      = 0;
    this._watchId        = null;
    this._lastUpload     = 0;
    this._deviating      = false;
    this._arrivedStops   = new Set();
    this._offlineQueue   = [];
    this._db             = null;
    this._map            = null;
    this._riderMarker    = null;
    this._routeLayer     = null;
    this._stopMarkers    = [];
    this._directionArrow = null;
    this._isOnline       = navigator.onLine;
    this._recalcTimer    = null;
    this._uploadRef      = null; // Firestore doc ref for location

    var self = this;
    window.addEventListener('online',  function () { self._isOnline = true;  self._flushQueue(); });
    window.addEventListener('offline', function () { self._isOnline = false; });

    this._initDB();
  }

  /* ── IndexedDB offline store ─────────────────────────────────────────────── */
  SokoniNavigation.prototype._initDB = function () {
    if (!window.indexedDB) return;
    var self = this, req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('locQueue'))
        db.createObjectStore('locQueue', { autoIncrement: true });
      if (!db.objectStoreNames.contains('routeCache'))
        db.createObjectStore('routeCache', { keyPath: 'key' });
    };
    req.onsuccess = function (e) {
      self._db = e.target.result;
      self._flushQueue();
    };
  };

  SokoniNavigation.prototype._dbSave = function (store, data, key) {
    if (!this._db) return;
    try {
      var tx = this._db.transaction(store, 'readwrite');
      var s = tx.objectStore(store);
      if (key !== undefined) s.put(data); else s.add(data);
    } catch (e) { /* silent */ }
  };

  SokoniNavigation.prototype._dbGetAll = function (store) {
    var self = this;
    return new Promise(function (res) {
      if (!self._db) return res([]);
      try {
        var tx = self._db.transaction(store, 'readonly');
        var r = tx.objectStore(store).getAll();
        r.onsuccess = function () { res(r.result || []); };
        r.onerror   = function () { res([]); };
      } catch (e) { res([]); }
    });
  };

  SokoniNavigation.prototype._dbClear = function (store) {
    if (!this._db) return;
    try {
      var tx = this._db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
    } catch (e) { /* silent */ }
  };

  /* ── Location upload ─────────────────────────────────────────────────────── */
  SokoniNavigation.prototype._uploadLocation = function (pos) {
    if (!this._riderId || !window.firebase || !firebase.firestore) return;
    var data = {
      lat: pos.lat, lng: pos.lng,
      bearing: pos.bearing, speed: pos.speed, accuracy: pos.accuracy,
      tripId:       this._tripId   || null,
      currentStop:  this._stopIdx,
      totalStops:   this._stops.length,
      status:       'active',
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (!this._uploadRef)
      this._uploadRef = firebase.firestore().collection('riderLocations').doc(this._riderId);
    this._uploadRef.set(data).catch(function () { /* silent — will retry */ });
  };

  SokoniNavigation.prototype._saveOffline = function (pos) {
    this._offlineQueue.push(pos);
    this._dbSave('locQueue', pos);
    if (this._cbs.offlineQueued) this._cbs.offlineQueued(this._offlineQueue.length);
  };

  SokoniNavigation.prototype._flushQueue = function () {
    if (!this._isOnline || !this._riderId) return;
    var self = this;
    if (this._offlineQueue.length > 0) {
      var last = this._offlineQueue[this._offlineQueue.length - 1];
      this._offlineQueue = [];
      this._dbClear('locQueue');
      this._uploadLocation(last);
    } else {
      this._dbGetAll('locQueue').then(function (items) {
        if (!items.length) return;
        self._dbClear('locQueue');
        self._uploadLocation(items[items.length - 1]);
      });
    }
  };

  /* ── GPS ─────────────────────────────────────────────────────────────────── */
  SokoniNavigation.prototype.startTracking = function () {
    if (!navigator.geolocation) {
      this._emit('error', 'GPS not supported on this device');
      return false;
    }
    var self = this;
    this._watchId = navigator.geolocation.watchPosition(
      function (p) { self._onPos(p); },
      function (e) { self._emit('error', 'GPS error: ' + e.message); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    return true;
  };

  SokoniNavigation.prototype.stopTracking = function () {
    if (this._watchId != null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    if (this._riderId && window.firebase && firebase.firestore) {
      firebase.firestore().collection('riderLocations').doc(this._riderId)
        .update({ status: 'offline', updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(function () {});
    }
  };

  SokoniNavigation.prototype._onPos = function (raw) {
    var c = raw.coords;
    var lat = c.latitude, lng = c.longitude;

    // Smooth bearing
    var rawBrg = c.heading != null && !isNaN(c.heading)
      ? c.heading
      : (this._pos ? _bearing(this._pos.lat, this._pos.lng, lat, lng) : 0);
    this._smoothBrg = this._pos
      ? this._smoothBrg * (1 - SMOOTH_K) + rawBrg * SMOOTH_K
      : rawBrg;

    this._pos = {
      lat: lat, lng: lng,
      bearing: Math.round(this._smoothBrg),
      speed:   Math.round((c.speed || 0) * 3.6), // m/s → km/h
      accuracy: Math.round(c.accuracy || 0),
    };

    // Upload at interval
    var now = Date.now();
    if (now - this._lastUpload >= UPLOAD_INTERVAL_MS) {
      this._lastUpload = now;
      if (this._isOnline) this._uploadLocation(this._pos);
      else this._saveOffline(this._pos);
    }

    // Map
    if (this._map) this._moveRiderMarker(lat, lng, this._smoothBrg);

    // Navigation logic
    if (this._steps.length) this._advanceStep(lat, lng);
    if (this._stops.length) this._checkArrival(lat, lng);
    if (this._routeCoords.length) this._checkDeviation(lat, lng);
    this._updateETA();

    this._emit('positionUpdate', this._pos);
  };

  /* ── Route calculation ───────────────────────────────────────────────────── */
  SokoniNavigation.prototype.calculateRoute = function (stops) {
    if (!stops || !stops.length) return Promise.resolve(null);
    this._stops = stops.map(function (s, i) {
      return Object.assign({}, s, { status: s.status || 'pending', _idx: i });
    });
    this._stopIdx = 0;
    for (var i = 0; i < this._stops.length; i++) {
      if (this._stops[i].status !== 'completed') { this._stopIdx = i; break; }
    }
    return this._fetchRoute();
  };

  SokoniNavigation.prototype._fetchRoute = function () {
    var self = this;
    var pending = this._stops.filter(function (s) { return s.status !== 'completed' && s.status !== 'cancelled'; });
    if (!pending.length) return Promise.resolve(null);

    var wpts = [];
    if (this._pos) wpts.push(this._pos.lng + ',' + this._pos.lat);
    pending.forEach(function (s) { wpts.push(s.lng + ',' + s.lat); });
    if (wpts.length < 2) return Promise.resolve(null);

    var profile = this._vehicle === 'cycling' ? 'cycling' : 'driving';
    var url = OSRM_BASE + '/' + profile + '/' + wpts.join(';')
      + '?steps=true&geometries=geojson&overview=full&annotations=false';
    var cacheKey = wpts.join('|');

    return _fetchT(url, 12000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.code !== 'Ok' || !d.routes || !d.routes.length) throw new Error('No route found');
        var route = d.routes[0];
        self._route       = route;
        self._routeCoords = route.geometry.coordinates; // [[lng,lat],...]
        self._steps       = route.legs.reduce(function (acc, leg) { return acc.concat(leg.steps); }, []);
        self._stepIdx     = 0;
        self._deviating   = false;
        // Cache to IndexedDB
        self._dbSave('routeCache', { key: cacheKey, route: route, ts: Date.now() }, true);
        if (self._map) self._renderRoute();
        self._emit('recalculated', { distanceM: route.distance, durationSec: route.duration });
        return route;
      })
      .catch(function (e) {
        // Try offline cache
        return self._dbGetAll('routeCache').then(function (cached) {
          var hit = (cached || []).find(function (c) { return c.key === cacheKey; });
          if (hit) {
            self._route       = hit.route;
            self._routeCoords = hit.route.geometry.coordinates;
            self._steps       = hit.route.legs.reduce(function (a, l) { return a.concat(l.steps); }, []);
            self._stepIdx     = 0;
            if (self._map) self._renderRoute();
            return hit.route;
          }
          self._emit('error', 'Route unavailable: ' + e.message);
          return null;
        });
      });
  };

  SokoniNavigation.prototype.recalculate = function () {
    this._deviating = false;
    if (this._recalcTimer) { clearTimeout(this._recalcTimer); this._recalcTimer = null; }
    return this._fetchRoute();
  };

  /* ── Turn-by-turn ────────────────────────────────────────────────────────── */
  SokoniNavigation.prototype.getCurrentStep = function () {
    var step = this._steps[this._stepIdx];
    if (!step) return null;
    var stop = this._stops[this._stopIdx];
    return {
      icon:        _icon(step),
      instruction: _instruction(step, stop && stop.name),
      distanceM:   step.distance,
      distanceText:_fmtDist(step.distance),
      durationSec: step.duration,
      type:        (step.maneuver || {}).type,
      modifier:    (step.maneuver || {}).modifier,
    };
  };

  SokoniNavigation.prototype.getNextStep = function () {
    var step = this._steps[this._stepIdx + 1];
    if (!step) return null;
    return {
      icon:        _icon(step),
      distanceText:_fmtDist(step.distance),
      instruction: _instruction(step),
    };
  };

  SokoniNavigation.prototype._advanceStep = function (lat, lng) {
    if (this._stepIdx >= this._steps.length - 1) return;
    var step = this._steps[this._stepIdx];
    var loc  = step.maneuver && step.maneuver.location;
    if (!loc) return;
    var dist = _hav(lat, lng, loc[1], loc[0]);
    if (dist < STEP_ADVANCE_M) {
      this._stepIdx++;
      this._emit('stepChange', this.getCurrentStep());
    }
  };

  /* ── ETA ─────────────────────────────────────────────────────────────────── */
  SokoniNavigation.prototype._updateETA = function () {
    if (!this._steps.length) return;
    var rem = this._steps.slice(this._stepIdx);
    var sec = rem.reduce(function (s, st) { return s + (st.duration || 0); }, 0);
    var m   = rem.reduce(function (s, st) { return s + (st.distance || 0); }, 0);
    this._emit('etaUpdate', {
      durationSec:  Math.round(sec),
      durationText: _fmtTime(sec),
      distanceM:    Math.round(m),
      distanceText: _fmtDist(m),
      eta:          new Date(Date.now() + sec * 1000),
    });
  };

  SokoniNavigation.prototype.getETA = function () {
    if (!this._steps.length) return null;
    var sec = this._steps.slice(this._stepIdx).reduce(function (s, st) { return s + (st.duration || 0); }, 0);
    var m   = this._steps.slice(this._stepIdx).reduce(function (s, st) { return s + (st.distance || 0); }, 0);
    return {
      durationSec:  Math.round(sec),
      durationText: _fmtTime(sec),
      distanceM:    Math.round(m),
      distanceText: _fmtDist(m),
      eta:          new Date(Date.now() + sec * 1000),
    };
  };

  /* ── Arrival detection (geofence) ────────────────────────────────────────── */
  SokoniNavigation.prototype._checkArrival = function (lat, lng) {
    var stop = this._stops[this._stopIdx];
    if (!stop || stop.status === 'completed' || this._arrivedStops.has(this._stopIdx)) return;
    var dist = _hav(lat, lng, stop.lat, stop.lng);
    if (dist <= ARRIVAL_RADIUS_M) {
      this._arrivedStops.add(this._stopIdx);
      this._emit('arrival', {
        stopIdx:   this._stopIdx,
        stop:      stop,
        distanceM: Math.round(dist),
      });
    }
  };

  /* ── Deviation detection ─────────────────────────────────────────────────── */
  SokoniNavigation.prototype._checkDeviation = function (lat, lng) {
    if (!this._routeCoords.length) return;
    var dist = _distToRoute(lat, lng, this._routeCoords);
    if (dist > DEVIATION_M && !this._deviating) {
      this._deviating = true;
      this._emit('deviation', { distanceM: Math.round(dist) });
      // Auto-recalculate after 4 s to filter GPS spikes
      var self = this;
      if (this._recalcTimer) clearTimeout(this._recalcTimer);
      this._recalcTimer = setTimeout(function () {
        if (self._deviating) self.recalculate();
      }, 4000);
    } else if (dist <= DEVIATION_M && this._deviating) {
      this._deviating = false;
      if (this._recalcTimer) { clearTimeout(this._recalcTimer); this._recalcTimer = null; }
    }
  };

  /* ── Multi-stop management ───────────────────────────────────────────────── */
  SokoniNavigation.prototype.completeStop = function (idx) {
    if (idx == null) idx = this._stopIdx;
    if (idx < 0 || idx >= this._stops.length) return;
    this._stops[idx].status       = 'completed';
    this._stops[idx].completedAt  = new Date().toISOString();
    // Advance to next pending stop
    var moved = false;
    for (var i = idx + 1; i < this._stops.length; i++) {
      var s = this._stops[i];
      if (s.status !== 'completed' && s.status !== 'cancelled') {
        this._stopIdx = i;
        moved = true;
        break;
      }
    }
    if (!moved) this._stopIdx = idx; // all done
    return this.recalculate();
  };

  SokoniNavigation.prototype.addStop = function (stop) {
    this._stops.push(Object.assign({}, stop, { status: 'pending', _idx: this._stops.length }));
    return this.recalculate();
  };

  SokoniNavigation.prototype.cancelStop = function (idx) {
    if (this._stops[idx]) {
      this._stops[idx].status = 'cancelled';
      if (this._stopIdx === idx) {
        for (var i = idx + 1; i < this._stops.length; i++) {
          if (this._stops[i].status !== 'completed' && this._stops[i].status !== 'cancelled') {
            this._stopIdx = i; break;
          }
        }
      }
      return this.recalculate();
    }
    return Promise.resolve(null);
  };

  SokoniNavigation.prototype.getStops = function () { return this._stops; };
  SokoniNavigation.prototype.getCurrentStop = function () { return this._stops[this._stopIdx] || null; };
  SokoniNavigation.prototype.getPosition = function () { return this._pos; };
  SokoniNavigation.prototype.isDeviating = function () { return this._deviating; };
  SokoniNavigation.prototype.isOnline = function () { return this._isOnline; };

  /* ── Nearest-neighbour TSP optimisation ─────────────────────────────────── */
  SokoniNavigation.prototype.optimizeStopOrder = function () {
    var pending = this._stops.filter(function (s) { return s.status === 'pending'; });
    if (pending.length <= 2) return Promise.resolve(null);
    var current = this._pos || { lat: pending[0].lat, lng: pending[0].lng };
    var ordered = [], remaining = pending.slice();
    while (remaining.length) {
      var minD = Infinity, minI = 0;
      remaining.forEach(function (s, i) {
        var d = _hav(current.lat, current.lng, s.lat, s.lng);
        if (d < minD) { minD = d; minI = i; }
      });
      ordered.push(remaining.splice(minI, 1)[0]);
      current = ordered[ordered.length - 1];
    }
    var completed = this._stops.filter(function (s) { return s.status !== 'pending'; });
    this._stops = completed.concat(ordered).map(function (s, i) { return Object.assign({}, s, { _idx: i }); });
    return this.recalculate();
  };

  /* ── External navigation launch ─────────────────────────────────────────── */
  SokoniNavigation.prototype.launchGoogleMaps = function (stop) {
    window.open(
      'https://www.google.com/maps/dir/?api=1&destination=' + stop.lat + ',' + stop.lng + '&travelmode=driving',
      '_blank'
    );
  };

  SokoniNavigation.prototype.launchWaze = function (stop) {
    window.open('https://waze.com/ul?ll=' + stop.lat + ',' + stop.lng + '&navigate=yes', '_blank');
  };

  SokoniNavigation.prototype.launchAppleMaps = function (stop) {
    window.open('https://maps.apple.com/?daddr=' + stop.lat + ',' + stop.lng + '&dirflg=d', '_blank');
  };

  /* ── Leaflet map ─────────────────────────────────────────────────────────── */
  SokoniNavigation.prototype.initMap = function (containerId) {
    if (!window.L) { this._emit('error', 'Leaflet not loaded'); return null; }
    this._map = L.map(containerId, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(this._map);
    L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(this._map);
    L.control.zoom({ position: 'bottomright' }).addTo(this._map);

    // Rider marker
    var riderHtml = '<div style="width:44px;height:44px;background:#71ff00;border:3px solid #000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 3px 10px rgba(0,0,0,.4);transition:transform .3s">🏍</div>';
    this._riderMarker = L.marker([1.2921, 36.8219], {
      icon: L.divIcon({ className: '', html: riderHtml, iconSize: [44, 44], iconAnchor: [22, 22] }),
      zIndexOffset: 1000,
    }).addTo(this._map);

    this._map.setView([1.2921, 36.8219], 14);
    // Prevent auto-pan if user is manually panning
    var self = this;
    this._map.on('dragstart', function () { self._userPanning = true; });
    this._map.on('dragend',   function () {
      setTimeout(function () { self._userPanning = false; }, 3000);
    });
    return this._map;
  };

  SokoniNavigation.prototype._moveRiderMarker = function (lat, lng, bearing) {
    if (!this._riderMarker) return;
    this._riderMarker.setLatLng([lat, lng]);
    if (!this._userPanning)
      this._map.panTo([lat, lng], { animate: true, duration: 0.5 });
  };

  SokoniNavigation.prototype._renderRoute = function () {
    if (!this._map || !this._route) return;
    if (this._routeLayer) { this._routeLayer.remove(); this._routeLayer = null; }
    var coords = this._routeCoords.map(function (c) { return [c[1], c[0]]; });
    this._routeLayer = L.polyline(coords, {
      color: '#00bcd4', weight: 6, opacity: 0.85, lineJoin: 'round',
    }).addTo(this._map);

    // Stop markers
    this._stopMarkers.forEach(function (m) { m.remove(); });
    this._stopMarkers = [];
    var self = this;
    this._stops.forEach(function (s) {
      if (s.status === 'completed' || s.status === 'cancelled') return;
      var isPick = s.type === 'pickup';
      var color  = isPick ? '#ff9800' : (s._idx === self._stopIdx ? '#71ff00' : '#00bcd4');
      var emoji  = isPick ? '📦' : '📍';
      var html   = '<div style="background:' + color + ';border:2px solid #000;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3)">' + emoji + '</div>';
      var marker = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: html, iconSize: [32, 32], iconAnchor: [16, 16] }),
      }).bindTooltip(s.name || (isPick ? 'Pickup' : 'Delivery'), { direction: 'top', offset: [0, -20] })
        .addTo(self._map);
      self._stopMarkers.push(marker);
    });

    this._map.fitBounds(this._routeLayer.getBounds(), { padding: [50, 50] });
  };

  SokoniNavigation.prototype.getMap = function () { return this._map; };

  /* ── SOS ─────────────────────────────────────────────────────────────────── */
  SokoniNavigation.prototype.triggerSOS = function () {
    if (!this._tripId || !this._riderId) return Promise.reject(new Error('No active trip'));
    if (!window.firebase || !firebase.functions) return Promise.reject(new Error('Firebase not loaded'));
    var pos = this._pos || {};
    return firebase.functions().httpsCallable('navTriggerSOS')({
      tripId: this._tripId,
      lat:    pos.lat  || null,
      lng:    pos.lng  || null,
    });
  };

  /* ── Event emitter ───────────────────────────────────────────────────────── */
  SokoniNavigation.prototype._emit = function (event, data) {
    var cb = this._cbs[event];
    if (typeof cb === 'function') cb(data);
  };

  SokoniNavigation.prototype.on = function (event, fn) {
    this._cbs[event] = fn;
    return this;
  };

  /* ── Standalone multi-stop optimiser (exported separately) ─────────────── */
  function SokoniNavOptimize(currentPos, stops) {
    var pending = stops.filter(function (s) { return s.status !== 'completed' && s.status !== 'cancelled'; });
    if (pending.length <= 2) return pending;
    var cur = currentPos || { lat: pending[0].lat, lng: pending[0].lng };
    var ordered = [], rem = pending.slice();
    while (rem.length) {
      var minD = Infinity, minI = 0;
      rem.forEach(function (s, i) {
        var d = _hav(cur.lat, cur.lng, s.lat, s.lng);
        if (d < minD) { minD = d; minI = i; }
      });
      ordered.push(rem.splice(minI, 1)[0]);
      cur = ordered[ordered.length - 1];
    }
    return ordered;
  }

  g.SokoniNavigation = SokoniNavigation;
  g.SokoniNavOptimize = SokoniNavOptimize;
  g._SokoniNavHav = _hav; // exposed for fleet-monitor distance calculations
})(window);
