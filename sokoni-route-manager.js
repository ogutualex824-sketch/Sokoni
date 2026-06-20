/* ============================================================
   SOKONI RouteManager
   Single responsibility: all Leaflet layer management —
   the completed-path polyline that grows as the driver moves,
   the remaining-path polyline that shrinks toward the destination,
   the destination marker, and the optional marketplace overlay
   (service-area circles + named hub markers).

   Road routing via OSRM public API (fallback: straight line).
============================================================ */

export class RouteManager {
  _map              = null;
  _routeCompleted   = null;
  _routeRemaining   = null;
  _destMarker       = null;
  _marketLayer      = null;
  _marketVisible    = false;
  _roadPath         = [];   // [[lat,lng], ...] from OSRM or fallback

  static MARKET_ZONES = [
    { lat: -1.2921, lng: 36.8219, name: 'Nairobi CBD',    r: 1200 },
    { lat: -1.2673, lng: 36.8062, name: 'Westlands',      r: 900  },
    { lat: -1.3192, lng: 36.8278, name: 'South B',        r: 700  },
    { lat: -1.2588, lng: 36.8933, name: 'Eastleigh',      r: 750  },
    { lat: -1.2978, lng: 36.7539, name: 'Karen',          r: 1100 },
    { lat: -1.2197, lng: 36.8839, name: 'Kasarani',       r: 950  },
  ];

  attachTo(leafletMap) {
    this._map = leafletMap;
    return this;
  }

  /* ── Destination marker ──────────────────────────────── */
  setDestination(lat, lng) {
    if (!this._map) return;
    if (this._destMarker) this._map.removeLayer(this._destMarker);
    this._destMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          background:linear-gradient(135deg,#71ff00,#00e676);
          width:32px;height:32px;border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          font-size:16px;box-shadow:0 0 12px rgba(113,255,0,0.6);
          border:2px solid rgba(255,255,255,0.3);">📍</div>`,
        iconSize:   [32, 32],
        iconAnchor: [16, 16],
      }),
    }).addTo(this._map);
  }

  /* ── Route polylines (road-following) ───────────────── */
  /*
     Fetches the actual road geometry from OSRM and draws it.
     Falls back to a straight line if the API is unreachable.
     Returns the road path so the caller can animate along it.
  */
  async initRoute(fromLat, fromLng, toLat, toLng) {
    if (!this._map) return;
    this._clearPolylines();

    this._roadPath = await this._fetchRoute(fromLat, fromLng, toLat, toLng);

    /* Completed path — breadcrumb trail behind driver */
    this._routeCompleted = L.polyline([], {
      color:   '#71ff00',
      weight:  4,
      opacity: 0.35,
    }).addTo(this._map);

    /* Remaining path — full road ahead initially */
    this._routeRemaining = L.polyline(this._roadPath, {
      color:      '#71ff00',
      weight:     4,
      opacity:    0.82,
      dashArray:  '12, 8',
    }).addTo(this._map);
  }

  /* Returns the road waypoints so GPSManager can animate along them */
  getRoadPath() { return this._roadPath; }

  /*
     Called every animation frame with the driver's interpolated position.
     Completed breadcrumbs grow behind; remaining road path shrinks ahead.
  */
  updateDriverPosition(lat, lng, destLat, destLng, completedPath) {
    if (this._routeCompleted && completedPath) {
      this._routeCompleted.setLatLngs(completedPath);
    }
    if (this._routeRemaining) {
      if (this._roadPath.length > 2) {
        const nearestIdx = this._nearestRoadIdx(lat, lng);
        this._routeRemaining.setLatLngs([[lat, lng], ...this._roadPath.slice(nearestIdx)]);
      } else {
        this._routeRemaining.setLatLngs([[lat, lng], [destLat, destLng]]);
      }
    }
  }

  /* ── OSRM fetch ──────────────────────────────────────── */
  async _fetchRoute(fromLat, fromLng, toLat, toLng) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/` +
                  `${fromLng},${fromLat};${toLng},${toLat}` +
                  `?overview=full&geometries=geojson`;
      const ctrl    = new AbortController();
      const timer   = setTimeout(() => ctrl.abort(), 6000);
      const res     = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const data    = await res.json();
      if (data.routes && data.routes[0]) {
        /* GeoJSON coords are [lng, lat] — convert to Leaflet [lat, lng] */
        return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      }
    } catch (_) { /* offline or OSRM down — use fallback */ }
    /* Fallback: three-point arc so it looks like movement */
    const midLat = (fromLat + toLat) / 2 - 0.003;
    const midLng = (fromLng + toLng) / 2 + 0.004;
    return [[fromLat, fromLng], [midLat, midLng], [toLat, toLng]];
  }

  /* Find the index of the road waypoint nearest to [lat, lng] */
  _nearestRoadIdx(lat, lng) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this._roadPath.length; i++) {
      const [rlat, rlng] = this._roadPath[i];
      const d = (rlat - lat) ** 2 + (rlng - lng) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return Math.min(best + 1, this._roadPath.length - 1);
  }

  /* ── Marketplace overlay ─────────────────────────────── */
  toggleMarketLayer() {
    if (!this._map) return;
    if (this._marketVisible) {
      this._hideMarketLayer();
    } else {
      this._showMarketLayer();
    }
    return this._marketVisible;
  }

  _showMarketLayer() {
    if (this._marketLayer) { this._marketLayer.addTo(this._map); this._marketVisible = true; return; }
    const layers = [];
    RouteManager.MARKET_ZONES.forEach(z => {
      layers.push(L.circle([z.lat, z.lng], {
        radius: z.r, color: '#71ff00', fillColor: '#71ff00',
        fillOpacity: 0.05, weight: 1, opacity: 0.25,
      }));
      layers.push(L.marker([z.lat, z.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:rgba(0,0,0,0.75);border:1px solid rgba(113,255,0,0.45);
            border-radius:10px;padding:3px 8px;font-size:11px;color:#71ff00;
            white-space:nowrap;backdrop-filter:blur(8px);">🏪 ${z.name}</div>`,
          iconAnchor: [0, 0],
        }),
      }));
    });
    this._marketLayer = L.layerGroup(layers).addTo(this._map);
    this._marketVisible = true;
  }

  _hideMarketLayer() {
    if (this._marketLayer) this._map.removeLayer(this._marketLayer);
    this._marketVisible = false;
  }

  isMarketVisible() { return this._marketVisible; }

  /* ── Cleanup ─────────────────────────────────────────── */
  _clearPolylines() {
    if (this._routeCompleted) { this._map?.removeLayer(this._routeCompleted); this._routeCompleted = null; }
    if (this._routeRemaining) { this._map?.removeLayer(this._routeRemaining); this._routeRemaining = null; }
    this._roadPath = [];
  }

  destroy() {
    this._clearPolylines();
    if (this._destMarker)  { this._map?.removeLayer(this._destMarker);  this._destMarker  = null; }
    if (this._marketLayer) { this._map?.removeLayer(this._marketLayer); this._marketLayer = null; }
    this._map = null;
  }
}
