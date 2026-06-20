/* ============================================================
   SOKONI TrackingManager
   Orchestrator — imports all four specialist modules and
   exposes the single public API that track.html calls:

     SokoniTracking.startTracking(location, orderId, steps)
     SokoniTracking.onLiveGPS(lat, lng)
     SokoniTracking.enableFollowMode()
     SokoniTracking.toggleMarketLayer()
     SokoniTracking.destroy()

   All map/GPS/route/UI logic lives in the four sub-modules.
   This file only wires them together and drives the flow.
============================================================ */

import { MapManager   } from './sokoni-map-manager.js';
import { GPSManager   } from './sokoni-gps-manager.js';
import { RouteManager } from './sokoni-route-manager.js';
import { UIManager    } from './sokoni-ui-manager.js';

export class TrackingManager {
  _map    = null;   // MapManager
  _gps    = null;   // GPSManager
  _route  = null;   // RouteManager
  _ui     = null;   // UIManager

  _dest          = { lat: null, lng: null };
  _orderId       = null;
  _followMode    = true;
  _completedPath = [];
  _driverMarker  = null;
  _completed     = false;   // guard: prevents confetti firing twice

  /* Offline detection */
  _offlineHandler = null;
  _onlineHandler  = null;

  /* ── Boot ────────────────────────────────────────────── */
  /*
     location: { driverLat, driverLng, destLat, destLng }
     orderId:  string  — "SK1234"
     steps:    array of { label, done } for the timeline
               (optional — simulated if omitted)
  */
  async startTracking(location, orderId, steps = null) {
    const { driverLat, driverLng, destLat, destLng } = location;

    this._orderId = orderId;
    this._dest    = { lat: destLat, lng: destLng };

    /* ── 1. Map ── */
    this._map = new MapManager('deliveryMap');
    this._map.init([driverLat, driverLng], 14);

    /* Show "Follow Driver" button when user manually drags the map */
    this._map.on('drag_start', () => {
      this._followMode = false;
      const btn = document.getElementById('followDriverBtn');
      if (btn) btn.style.display = 'flex';
    });

    /* ── 2. GPS ── */
    this._gps = new GPSManager();
    this._gps.setInitialPosition(driverLat, driverLng);

    this._gps.on('simulation_step', ({ lat, lng }) => {
      this._completedPath.push([lat, lng]);
      this._onPosition(lat, lng);
    });

    this._gps.on('arrived', () => {
      if (this._completed) return;
      this._completed = true;
      this._ui.setStatus('🎉 Delivered!');
      this._ui.showCompletionOverlay(this._orderId);
    });

    /* ── 3. Route (async — fetches road geometry from OSRM) ── */
    this._route = new RouteManager();
    this._route.attachTo(this._map.getMap());
    this._route.setDestination(destLat, destLng);
    await this._route.initRoute(driverLat, driverLng, destLat, destLng);
    this._completedPath = [[driverLat, driverLng]];

    /* ── 4. UI ── */
    this._ui = new UIManager();
    this._ui.showMapContainer();
    this._ui.setOrderId(orderId);
    this._ui.setStatus('📦 Driver on the way…');
    this._ui.startStalenessTimer();
    this._ui.renderTimeline(steps || this._defaultSteps());

    /* ── 5. Driver marker ── */
    this._driverMarker = this._createDriverMarker(driverLat, driverLng, 0);
    this._driverMarker.addTo(this._map.getMap());

    /* ── 6. Fit initial bounds ── */
    this._map.fitBounds([[driverLat, driverLng], [destLat, destLng]]);

    /* ── 7. Offline / online listeners ── */
    this._offlineHandler = () => this._ui.showOfflineBanner();
    this._onlineHandler  = () => { this._ui.hideOfflineBanner(); this._ui.markGPSUpdate(); };
    window.addEventListener('offline', this._offlineHandler);
    window.addEventListener('online',  this._onlineHandler);

    /* ── 8. Re-center on visibility restore ── */
    this._map.on('visible', () => {
      if (this._followMode) {
        const pos = this._gps.getPosition();
        if (pos.lat) this._map.panTo(pos.lat, pos.lng);
      }
    });

    /* ── 9. Start simulation along road waypoints ── */
    const roadPath = this._route.getRoadPath();
    this._gps.startSimulation(
      { lat: driverLat, lng: driverLng },
      { lat: destLat,   lng: destLng   },
      { roadPath }
    );

    return this;
  }

  /* ── Called by Firestore GPS listener ───────────────── */
  /*
     This replaces window._moveLiveDriver in track.html.
     When real driver data arrives it stops the simulation
     and uses live coordinates instead.
  */
  onLiveGPS(lat, lng) {
    if (!this._gps) return;
    this._gps.stopSimulation();   // drop simulated movement

    this._completedPath.push([lat, lng]);
    this._onPosition(lat, lng);
    this._ui.markGPSUpdate();
  }

  /* ── Follow mode ─────────────────────────────────────── */
  enableFollowMode() {
    this._followMode = true;
    const btn = document.getElementById('followDriverBtn');
    if (btn) btn.style.display = 'none';   // hide the "re-follow" prompt
    const pos = this._gps?.getPosition();
    if (pos?.lat) this._map?.panTo(pos.lat, pos.lng);
  }

  /* ── Marketplace layer toggle ────────────────────────── */
  toggleMarketLayer() {
    const visible = this._route?.toggleMarketLayer();
    const btn = document.getElementById('marketLayerBtn');
    if (btn) btn.style.background = visible
      ? 'rgba(113,255,0,0.25)'
      : 'rgba(0,0,0,0.7)';
  }

  /* ── Teardown ────────────────────────────────────────── */
  destroy() {
    this._gps?.destroy();
    this._route?.destroy();
    this._ui?.destroy();
    this._map?.destroy();
    if (this._offlineHandler) window.removeEventListener('offline', this._offlineHandler);
    if (this._onlineHandler)  window.removeEventListener('online',  this._onlineHandler);
    this._gps = this._route = this._ui = this._map = null;
    this._driverMarker = null;
    this._completedPath = [];
    this._completed = false;
  }

  /* ── Private ─────────────────────────────────────────── */

  /*
     Central position handler called after every GPS update
     (both simulated and real). Drives the animation, route,
     and all UI updates from one place.
  */
  _onPosition(lat, lng) {
    if (!this._map?.isReady()) return;
    const dest = this._dest;

    /* Animate the marker — the onFrame callback pans the map */
    this._gps.animateTo(
      this._driverMarker, lat, lng, 2600,
      ({ lat: fLat, lng: fLng, bearing, speed }) => {
        /* Update vehicle icon rotation every frame */
        this._driverMarker.setIcon(this._buildDriverIcon(bearing));
        /* Pan map if follow mode is on */
        if (this._followMode) {
          this._map.panTo(fLat, fLng, { animate: true, duration: 0.4, easeLinearity: 0.5 });
        }
        /* Update remaining route every few frames (not every RAF tick to reduce DOM churn) */
        if (dest.lat) {
          this._route.updateDriverPosition(fLat, fLng, dest.lat, dest.lng, null);
        }
      }
    );

    /* Route completed breadcrumb */
    if (dest.lat) {
      this._route.updateDriverPosition(lat, lng, dest.lat, dest.lng, this._completedPath);
    }

    /* Distance + ETA calculations */
    const km      = this._gps.distanceKm(lat, lng, dest.lat, dest.lng);
    const etaMins = Math.max(0, Math.round(km / 0.45));
    const pos     = this._gps.getPosition();

    /* UI updates */
    this._ui.updateEtaCard(km.toFixed(1), etaMins);
    this._ui.updateStatsBar(km.toFixed(1), etaMins, pos.speed);
    this._ui.updateConfidence(km.toFixed(1));

    const smartMsg = this._ui.buildSmartStatus(lat, lng, km.toFixed(1), etaMins);
    this._ui.setStatus(smartMsg);

    /* Mark GPS active so the staleness ticker has a baseline */
    this._ui.markGPSUpdate();

    /* Completion check — guarded so confetti only fires once */
    if (km < 0.12 && !this._completed) {
      this._completed = true;
      this._gps.stopSimulation();
      this._ui.showCompletionOverlay(this._orderId);
    }
  }

  _createDriverMarker(lat, lng, bearing) {
    return L.marker([lat, lng], {
      icon:   this._buildDriverIcon(bearing),
      zIndexOffset: 1000,
    });
  }

  _buildDriverIcon(bearing) {
    return L.divIcon({
      className: '',
      html: `<div class="driver-icon-root">
               <div class="driver-vehicle" style="transform:rotate(${Math.round(bearing)}deg)">🛵</div>
               <div class="driver-pulse"></div>
               <div class="driver-pulse-2"></div>
             </div>`,
      iconSize:   [52, 52],
      iconAnchor: [26, 26],
    });
  }

  _defaultSteps() {
    return [
      { label: 'Order placed',    done: true  },
      { label: 'Preparing',       done: true  },
      { label: 'Out for delivery',done: false },
      { label: 'Delivered',       done: false },
    ];
  }
}

/* ── Convenience factory exposed on window ───────────── */
/*
   track.html uses:
     window.SokoniTracking = new TrackingManager();
     window.SokoniTracking.startTracking(...)
     window.SokoniTracking.onLiveGPS(lat, lng)
*/
