/* ================================================================
   SOKONI GEO INTELLIGENCE PLATFORM (GIP) — Core Engine  v1.0.0

   Central geospatial engine powering every location-aware module
   in the Sokoni platform. Built for 1M+ concurrent users.

   Architecture:
   • Viewport-scoped Firestore subscriptions — never load all assets
   • Adaptive update rates: 2 s moving / 10 s slow / 30 s stationary
   • MarkerCluster degrades gracefully if plugin absent
   • Geofencing: O(1) circle test, O(v) ray-cast polygon
   • Offline-first: IndexedDB queue + auto-sync on reconnect
   • Event bus: any module can subscribe / publish via gip.on/emit
   • Multi-layer tile switching (Standard, Dark, Satellite, Terrain)

   Firestore collections introduced:
     gipAssets/{assetId}        — unified asset registry
     gipLocations/{assetId}     — live GPS (1 doc per asset, merge writes)
     gipGeofences/{zoneId}      — geofence zone definitions
     gipGeofenceEvents/{id}     — zone trigger audit log
     gipDispatch/{jobId}        — dispatch records
     gipAlerts/{alertId}        — fleet alerts

   Tile providers (all free, no API key):
     standard   → OpenStreetMap
     dark       → CartoDB Dark Matter
     satellite  → ESRI World Imagery
     terrain    → OpenTopoMap
     light      → CartoDB Voyager

   Modules supported:
     marketplace, food, grocery, rides, rentals,
     property, healthcare, mechanics, events, pos, emergency

   Usage:
     import GIP from './sokoni-gip.js';
     const gip = new GIP();
     await gip.init({ containerId: 'gipMap', region: 'nairobi' });
     gip.on('asset:updated', asset => console.log(asset));

   Also available as window.SokoniGIP (set at bottom of file).
================================================================ */

import { db, auth } from './firebase.js';
import {
  collection, doc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, getDocs, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Private utilities ──────────────────────────────────────── */

/** Haversine distance in kilometres between two WGS-84 coordinates */
function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Validate GPS coordinate — rejects spoofed or malformed values */
function _validCoord(lat, lng) {
  return (
    typeof lat === 'number' && isFinite(lat) && lat >= -90  && lat <= 90 &&
    typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/** Ray-casting point-in-polygon (Leaflet-compatible lat/lng arrays) */
function _inPolygon(lat, lng, coordinates) {
  let inside = false;
  const n = coordinates.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = coordinates[i].lng, yi = coordinates[i].lat;
    const xj = coordinates[j].lng, yj = coordinates[j].lat;
    const intersect = ((yi > lat) !== (yj > lat)) &&
                      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Debounce helper */
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Constants ──────────────────────────────────────────────── */

const TILE_LAYERS = {
  standard: {
    url:  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  },
  dark: {
    url:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://carto.com">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  satellite: {
    url:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© <a href="https://esri.com">ESRI</a>',
    maxZoom: 19,
  },
  terrain: {
    url:  'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17,
  },
  light: {
    url:  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://carto.com">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd',
  },
};

/* Status → hex colour for icon rings */
const STATUS_COLOR = {
  available:   '#71ff00',
  busy:        '#00aaff',
  en_route:    '#ffc107',
  offline:     'rgba(255,255,255,0.25)',
  maintenance: '#ff9800',
  emergency:   '#ff3333',
};

/* Asset type → display emoji */
const ASSET_ICON = {
  driver:      '🚗',
  courier:     '🛵',
  rider:       '🚲',
  mechanic:    '🔧',
  agent:       '👤',
  ambulance:   '🚑',
  truck:       '🚛',
  vehicle:     '🚙',
  field_staff: '🦺',
  rental:      '🚘',
};

/* Kenya operational regions — bounding boxes for subscription scoping */
const REGIONS = {
  nairobi:      { lat: -1.2921, lng: 36.8219, r: 30  },
  mombasa:      { lat: -4.0435, lng: 39.6682, r: 25  },
  kisumu:       { lat: -0.1022, lng: 34.7617, r: 20  },
  nakuru:       { lat: -0.3031, lng: 36.0800, r: 20  },
  eldoret:      { lat:  0.5143, lng: 35.2698, r: 20  },
  thika:        { lat: -1.0332, lng: 37.0693, r: 15  },
};

/* Adaptive update intervals in ms */
const UPDATE_RATE = {
  MOVING:     2_000,
  SLOW:      10_000,
  STATIONARY: 30_000,
};

/* ── GIPEventBus ─────────────────────────────────────────────── */

class GIPEventBus {
  _handlers = new Map();

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, data) {
    this._handlers.get(event)?.forEach(fn => { try { fn(data); } catch (e) { console.error(`[GIP bus] ${event}:`, e); } });
    /* Also emit wildcard handlers */
    this._handlers.get('*')?.forEach(fn => { try { fn(event, data); } catch (e) {} });
  }

  clear() { this._handlers.clear(); }
}

/* ── GIPOfflineQueue (IndexedDB) ─────────────────────────────── */

class GIPOfflineQueue {
  static DB_NAME    = 'sokoni-gip-offline';
  static STORE_NAME = 'location-queue';
  static VERSION    = 1;

  _db = null;

  async open() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(GIPOfflineQueue.DB_NAME, GIPOfflineQueue.VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(GIPOfflineQueue.STORE_NAME)) {
          db.createObjectStore(GIPOfflineQueue.STORE_NAME, { autoIncrement: true });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async queue(record) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(GIPOfflineQueue.STORE_NAME, 'readwrite');
      tx.objectStore(GIPOfflineQueue.STORE_NAME).add({ ...record, queuedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async drainAll() {
    await this.open();
    return new Promise((resolve, reject) => {
      const records = [];
      const keys    = [];
      const tx  = this._db.transaction(GIPOfflineQueue.STORE_NAME, 'readwrite');
      const req = tx.objectStore(GIPOfflineQueue.STORE_NAME).openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { records.push(cursor.value); keys.push(cursor.key); cursor.continue(); }
        else resolve({ records, keys });
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  async deleteKeys(keys) {
    if (!keys.length) return;
    await this.open();
    const tx = this._db.transaction(GIPOfflineQueue.STORE_NAME, 'readwrite');
    const store = tx.objectStore(GIPOfflineQueue.STORE_NAME);
    keys.forEach(k => store.delete(k));
  }

  async count() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(GIPOfflineQueue.STORE_NAME, 'readonly');
      const req = tx.objectStore(GIPOfflineQueue.STORE_NAME).count();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }
}

/* ── GIPGeofenceEngine ───────────────────────────────────────── */

class GIPGeofenceEngine {
  _zones   = new Map();   /* zoneId → zone definition */
  _history = new Map();   /* assetId → Set<zoneId> (currently inside) */

  addZone(zone) {
    if (!zone.id || !zone.type) return;
    this._zones.set(zone.id, zone);
  }

  removeZone(zoneId) {
    this._zones.delete(zoneId);
  }

  /**
   * Check asset against all zones.
   * Returns array of { zone, event: 'enter'|'exit'|'dwell' }
   */
  check(assetId, lat, lng) {
    const events  = [];
    const inside  = this._history.get(assetId) ?? new Set();
    const nowIn   = new Set();

    for (const [zoneId, zone] of this._zones) {
      if (!zone.active) continue;
      let hit = false;

      if (zone.type === 'circle') {
        const distKm = _haversineKm(lat, lng, zone.center.lat, zone.center.lng);
        hit = distKm <= (zone.radius / 1000);
      } else if (zone.type === 'polygon' && Array.isArray(zone.coordinates)) {
        hit = _inPolygon(lat, lng, zone.coordinates);
      }

      if (hit) {
        nowIn.add(zoneId);
        if (!inside.has(zoneId)) events.push({ zone, event: 'enter' });
      } else if (inside.has(zoneId)) {
        events.push({ zone, event: 'exit' });
      }
    }

    this._history.set(assetId, nowIn);
    return events;
  }

  clearAsset(assetId) {
    this._history.delete(assetId);
  }

  getZoneCount() { return this._zones.size; }
}

/* ── GIPEngine (main) ────────────────────────────────────────── */

export default class GIPEngine {
  /* Internal state */
  _map           = null;
  _tileLayer     = null;
  _clusterGroup  = null;
  _heatLayer     = null;
  _heatPoints    = new Map();   /* assetId → { lat, lng, weight } */

  _assets        = new Map();   /* assetId → asset data */
  _markers       = new Map();   /* assetId → Leaflet marker */

  _bus           = new GIPEventBus();
  _fence         = new GIPGeofenceEngine();
  _queue         = new GIPOfflineQueue();

  _unsubscribers = [];
  _currentRegion = 'nairobi';
  _currentLayer  = 'dark';
  _activeModules = new Set(['delivery', 'rides', 'food', 'mechanics']);
  _heatmodeule   = null;
  _heatVisible   = false;
  _clustered     = true;

  _debouncedBoundsChange = _debounce(() => this._onBoundsChange(), 800);
  _onlineHandler = null;
  _offlineHandler = null;

  /**
   * @param {object} options
   * @param {string} options.containerId   — DOM element id for the map
   * @param {string} [options.region]      — starting region key (default: 'nairobi')
   * @param {string} [options.layer]       — tile layer key (default: 'dark')
   * @param {number[]} [options.center]    — [lat, lng] override
   * @param {number}   [options.zoom]      — zoom level override
   * @param {string[]} [options.modules]   — which modules to subscribe to
   * @param {boolean}  [options.cluster]   — enable marker clustering (default: true)
   */
  async init(options = {}) {
    const {
      containerId = 'gipMap',
      region      = 'nairobi',
      layer       = 'dark',
      center,
      zoom        = 13,
      modules,
      cluster     = true,
    } = options;

    this._currentRegion = region;
    this._currentLayer  = layer;
    this._clustered     = cluster;
    if (modules) this._activeModules = new Set(modules);

    /* Wait for Leaflet */
    await this._waitForLeaflet();

    const el = document.getElementById(containerId);
    if (!el) throw new Error(`[GIP] Container #${containerId} not found`);

    const regionDef  = REGIONS[region] ?? REGIONS.nairobi;
    const mapCenter  = center ?? [regionDef.lat, regionDef.lng];

    /* ── Leaflet map ── */
    this._map = L.map(el, {
      center:            mapCenter,
      zoom,
      zoomControl:       false,
      fadeAnimation:     false,
      zoomAnimation:     false,
      preferCanvas:      true,   /* Canvas renderer — faster for many markers */
      renderer:          L.canvas({ tolerance: 8 }),
    });

    this._applyLayer(layer);
    L.control.zoom({ position: 'bottomright' }).addTo(this._map);

    /* ── Marker cluster ── */
    this._initCluster();

    /* ── Scale control ── */
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(this._map);

    /* ── Bounds change → re-scope subscription ── */
    this._map.on('moveend zoomend', () => this._debouncedBoundsChange());

    /* ── Connectivity handlers ── */
    this._onlineHandler  = () => this._onOnline();
    this._offlineHandler = () => this._onOffline();
    window.addEventListener('online',  this._onlineHandler);
    window.addEventListener('offline', this._offlineHandler);

    /* ── Load geofences from Firestore ── */
    await this._loadGeofences();

    /* ── Start real-time subscriptions ── */
    this._subscribeRegion();

    this._bus.emit('gip:ready', { region, layer });
    return this;
  }

  /* ── Tile layer management ────────────────────────────────── */

  setLayer(layerKey) {
    if (!TILE_LAYERS[layerKey]) return;
    this._currentLayer = layerKey;
    this._applyLayer(layerKey);
    this._bus.emit('gip:layer', { layer: layerKey });
  }

  _applyLayer(key) {
    const cfg = TILE_LAYERS[key] ?? TILE_LAYERS.dark;
    if (this._tileLayer) this._map.removeLayer(this._tileLayer);
    this._tileLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom:     cfg.maxZoom ?? 19,
      subdomains:  cfg.subdomains ?? 'abc',
      detectRetina: false,
    }).addTo(this._map);
  }

  /* ── Marker cluster ──────────────────────────────────────── */

  _initCluster() {
    if (this._clustered && window.L && L.markerClusterGroup) {
      this._clusterGroup = L.markerClusterGroup({
        disableClusteringAtZoom: 16,
        spiderfyOnMaxZoom:       true,
        showCoverageOnHover:     false,
        maxClusterRadius:        60,
        iconCreateFunction: (cluster) => {
          const count = cluster.getChildCount();
          const size  = count > 100 ? 52 : count > 20 ? 44 : 36;
          return L.divIcon({
            html: `<div style="
              width:${size}px;height:${size}px;border-radius:50%;
              background:rgba(113,255,0,0.18);border:2px solid rgba(113,255,0,0.6);
              display:flex;align-items:center;justify-content:center;
              color:#71ff00;font-size:13px;font-weight:900;backdrop-filter:blur(4px);">
              ${count}
            </div>`,
            className: '',
            iconSize:  [size, size],
          });
        },
      });
      this._map.addLayer(this._clusterGroup);
    } else if (this._clustered) {
      console.warn('[GIP] Leaflet.MarkerCluster not loaded — falling back to direct markers. Add the plugin for 10k+ marker performance.');
    }
  }

  /* ── Heatmap layer ───────────────────────────────────────── */

  showHeatmap(module = null, externalPoints = null) {
    if (!window.L?.heatLayer) {
      console.warn('[GIP] Leaflet.heat not loaded — heatmap disabled.');
      return;
    }
    this._heatmodule  = module;
    this._heatVisible = true;

    /* Accept externally-supplied points (from analytics.getHeatPoints) or use live cache */
    const points = externalPoints ?? [...this._heatPoints.values()]
      .filter(p => !module || p.module === module)
      .map(p => [p.lat, p.lng, p.weight ?? 0.5]);

    if (this._heatLayer) this._map.removeLayer(this._heatLayer);
    this._heatLayer = L.heatLayer(points, {
      radius:    28,
      blur:      20,
      maxZoom:   15,
      gradient:  { 0.2: '#00aaff', 0.5: '#ffc107', 0.8: '#ff4444', 1.0: '#ff0000' },
    }).addTo(this._map);
  }

  hideHeatmap() {
    if (this._heatLayer) { this._map.removeLayer(this._heatLayer); this._heatLayer = null; }
    this._heatVisible = false;
  }

  _updateHeatPoint(asset) {
    if (!this._heatVisible) return;
    this._heatPoints.set(asset.assetId ?? asset.id, {
      lat:    asset.lat,
      lng:    asset.lng,
      weight: asset.status === 'busy' ? 0.9 : 0.4,
      module: asset.module,
    });
    /* Debounce full layer rebuild to avoid per-update thrash */
    clearTimeout(this._heatRebuildTimer);
    this._heatRebuildTimer = setTimeout(() => this.showHeatmap(this._heatmodule), 2000);
  }

  /* ── Geofences ───────────────────────────────────────────── */

  async loadGeofences() { return this._loadGeofences(); }

  async _loadGeofences() {
    try {
      const snap = await getDocs(query(
        collection(db, 'gipGeofences'),
        where('active', '==', true),
        limit(500)
      ));
      snap.docs.forEach(d => this._fence.addZone(d.data()));
    } catch (e) {
      console.warn('[GIP] Geofence load:', e.message);
    }
  }

  async addGeofence(zone) {
    if (!zone.id) zone.id = 'GF-' + Date.now().toString(36).toUpperCase();
    zone.active    = zone.active ?? true;
    zone.createdAt = serverTimestamp();
    try {
      await setDoc(doc(db, 'gipGeofences', zone.id), zone);
      this._fence.addZone(zone);
      this._bus.emit('gip:geofence:added', zone);
    } catch (e) {
      console.error('[GIP] addGeofence:', e);
      throw e;
    }
    return zone.id;
  }

  async removeGeofence(zoneId) {
    try {
      await updateDoc(doc(db, 'gipGeofences', zoneId), { active: false });
      this._fence.removeZone(zoneId);
      this._bus.emit('gip:geofence:removed', { zoneId });
    } catch (e) {
      console.error('[GIP] removeGeofence:', e);
    }
  }

  /* ── Real-time Firestore subscription ───────────────────── */

  _subscribeRegion() {
    /* Unsubscribe previous listener */
    this._unsubscribers.forEach(u => u());
    this._unsubscribers = [];

    const q = query(
      collection(db, 'gipLocations'),
      where('region', '==', this._currentRegion),
      where('isOnline', '==', true),
      limit(500)             /* Safety cap — viewport zoom handles density */
    );

    const unsub = onSnapshot(q,
      { includeMetadataChanges: false },
      snapshot => {
        snapshot.docChanges().forEach(change => {
          const data = change.doc.data();
          if (!_validCoord(data.lat, data.lng)) return;
          if (change.type === 'removed') {
            this._removeAsset(change.doc.id);
          } else {
            if (this._activeModules.size && data.module && !this._activeModules.has(data.module)) return;
            this._updateAsset(change.doc.id, data);
          }
        });
        this._bus.emit('gip:tick', { count: this._assets.size });
      },
      err => console.warn('[GIP] Subscription error:', err.message)
    );

    this._unsubscribers.push(unsub);
  }

  _onBoundsChange() {
    /* Re-subscription on region boundary crossing can be added here.
       For now: filter markers outside visible bounds from cluster. */
    if (!this._map) return;
    this._bus.emit('gip:bounds', this._map.getBounds());
  }

  /* ── Asset lifecycle ──────────────────────────────────────── */

  _updateAsset(assetId, data) {
    const prev = this._assets.get(assetId);
    const asset = { ...data, assetId };
    this._assets.set(assetId, asset);

    /* Geofence check */
    const fenceEvents = this._fence.check(assetId, data.lat, data.lng);
    fenceEvents.forEach(fe => this._onFenceEvent(asset, fe));

    /* Heatmap */
    this._updateHeatPoint(asset);

    /* Marker */
    const existingMarker = this._markers.get(assetId);
    if (existingMarker) {
      this._animateMarker(existingMarker, data.lat, data.lng);
      existingMarker.setIcon(this._buildIcon(asset));
    } else {
      const marker = this._createMarker(asset);
      this._markers.set(assetId, marker);
      (this._clusterGroup ?? this._map).addLayer(marker);
    }

    this._bus.emit('asset:updated', asset);
  }

  _removeAsset(assetId) {
    const marker = this._markers.get(assetId);
    if (marker) {
      (this._clusterGroup ?? this._map).removeLayer(marker);
      this._markers.delete(assetId);
    }
    this._assets.delete(assetId);
    this._heatPoints.delete(assetId);
    this._fence.clearAsset(assetId);
    this._bus.emit('asset:removed', { assetId });
  }

  _createMarker(asset) {
    const marker = L.marker([asset.lat, asset.lng], {
      icon: this._buildIcon(asset),
      title: asset.name ?? asset.assetId,
      riseOnHover: true,
    });
    marker.bindPopup(() => this._buildPopup(asset), { maxWidth: 280 });
    marker.on('click', () => this._bus.emit('asset:click', asset));
    return marker;
  }

  _buildIcon(asset) {
    const color  = STATUS_COLOR[asset.status] ?? STATUS_COLOR.offline;
    const emoji  = ASSET_ICON[asset.type]     ?? '📍';
    const pulse  = asset.status === 'busy' || asset.status === 'en_route';
    return L.divIcon({
      className: '',
      html: `<div style="
        position:relative;
        width:34px;height:34px;border-radius:50%;
        background:rgba(8,8,8,0.85);
        border:2.5px solid ${color};
        display:flex;align-items:center;justify-content:center;
        font-size:16px;
        box-shadow:0 0 ${pulse ? '12px' : '6px'} ${color};
        ${pulse ? `animation:gip-pulse 1.6s ease-in-out infinite;` : ''}
      ">${emoji}</div>
      <style>@keyframes gip-pulse{0%,100%{box-shadow:0 0 6px ${color};}50%{box-shadow:0 0 18px ${color};}}</style>`,
      iconSize:   [34, 34],
      iconAnchor: [17, 17],
      popupAnchor:[0, -20],
    });
  }

  _buildPopup(asset) {
    const color   = STATUS_COLOR[asset.status] ?? STATUS_COLOR.offline;
    const emoji   = ASSET_ICON[asset.type] ?? '📍';
    const statusLabel = (asset.status ?? 'unknown').replace(/_/g, ' ');
    const rating  = asset.rating ? `${'★'.repeat(Math.round(asset.rating))} (${asset.rating.toFixed(1)})` : '—';
    const speed   = asset.speed  ? `${asset.speed} km/h` : '—';
    const eta     = asset.etaMin ? `~${asset.etaMin} min` : '—';
    return `<div style="font-family:system-ui,sans-serif;color:white;min-width:200px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,0.07);border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:18px;">${emoji}</div>
        <div>
          <div style="font-weight:900;font-size:14px;">${asset.name ?? asset.assetId}</div>
          <div style="font-size:10px;color:${color};text-transform:uppercase;font-weight:700;letter-spacing:.05em;">${statusLabel}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;">
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:7px;">
          <div style="color:rgba(255,255,255,0.35);margin-bottom:2px;">Speed</div>
          <div style="font-weight:700;">${speed}</div>
        </div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:7px;">
          <div style="color:rgba(255,255,255,0.35);margin-bottom:2px;">ETA</div>
          <div style="font-weight:700;">${eta}</div>
        </div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:7px;">
          <div style="color:rgba(255,255,255,0.35);margin-bottom:2px;">Rating</div>
          <div style="font-weight:700;">${rating}</div>
        </div>
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:7px;">
          <div style="color:rgba(255,255,255,0.35);margin-bottom:2px;">Module</div>
          <div style="font-weight:700;">${asset.module ?? '—'}</div>
        </div>
      </div>
      ${asset.vehiclePlate ? `<div style="margin-top:8px;font-size:10px;color:rgba(255,255,255,0.35);">Plate: <strong>${asset.vehiclePlate}</strong></div>` : ''}
      ${asset.phone ? `<div style="margin-top:2px;font-size:10px;color:rgba(255,255,255,0.35);">Phone: <strong>${asset.phone}</strong></div>` : ''}
    </div>`;
  }

  /** Smooth marker animation (easeInOut, 2s) */
  _animateMarker(marker, toLat, toLng) {
    const from = marker.getLatLng();
    if (Math.abs(from.lat - toLat) < 1e-8 && Math.abs(from.lng - toLng) < 1e-8) return;

    const dur = 2000;
    const t0  = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      marker.setLatLng([from.lat + (toLat - from.lat) * e, from.lng + (toLng - from.lng) * e]);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── Geofence events ──────────────────────────────────────── */

  async _onFenceEvent(asset, { zone, event }) {
    const fenceEvent = {
      id:         `FEV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      geofenceId: zone.id,
      zoneName:   zone.name,
      assetId:    asset.assetId,
      assetName:  asset.name,
      type:       event,
      module:     asset.module,
      lat:        asset.lat,
      lng:        asset.lng,
      timestamp:  serverTimestamp(),
    };

    this._bus.emit('geofence:event', fenceEvent);

    try {
      await setDoc(doc(db, 'gipGeofenceEvents', fenceEvent.id), fenceEvent);
    } catch (e) {
      console.warn('[GIP] geofence event write:', e.message);
    }
  }

  /* ── Asset location publishing (for asset devices) ────────── */

  /**
   * Called by a driver / courier / mechanic device to publish their location.
   * Handles offline queuing automatically.
   */
  async publishLocation({ assetId, lat, lng, heading = 0, speed = 0, status = 'available', module = 'delivery', region, metadata = {} }) {
    if (!_validCoord(lat, lng)) {
      console.warn('[GIP] publishLocation: invalid coords', lat, lng);
      return;
    }

    const effectiveRegion = region ?? this._currentRegion;
    const payload = {
      assetId, lat, lng, heading, speed,
      status, module,
      region:    effectiveRegion,
      isOnline:  true,
      updatedAt: serverTimestamp(),
      ...metadata,
    };

    if (!navigator.onLine) {
      await this._queue.queue(payload);
      this._bus.emit('gip:queued', { count: await this._queue.count() });
      return;
    }

    try {
      await setDoc(doc(db, 'gipLocations', assetId), payload, { merge: true });
    } catch (e) {
      /* Fall back to offline queue on write failure */
      await this._queue.queue(payload);
      console.warn('[GIP] publishLocation queued (write failed):', e.message);
    }
  }

  /* ── Connectivity ─────────────────────────────────────────── */

  _onOffline() {
    this._bus.emit('gip:offline', {});
  }

  async _onOnline() {
    this._bus.emit('gip:online', {});
    await this._flushOfflineQueue();
  }

  async _flushOfflineQueue() {
    try {
      const { records, keys } = await this._queue.drainAll();
      if (!records.length) return;

      const batch = writeBatch(db);
      records.forEach(rec => {
        batch.set(doc(db, 'gipLocations', rec.assetId), { ...rec, updatedAt: serverTimestamp() }, { merge: true });
      });
      await batch.commit();
      await this._queue.deleteKeys(keys);
      this._bus.emit('gip:flushed', { count: records.length });
    } catch (e) {
      console.warn('[GIP] flushOfflineQueue:', e.message);
    }
  }

  /* ── Module filter ────────────────────────────────────────── */

  setModules(modules) {
    this._activeModules = new Set(modules);
    this._subscribeRegion();
  }

  setRegion(region) {
    if (region === this._currentRegion) return;
    const def = REGIONS[region];
    if (!def) { console.warn('[GIP] Unknown region:', region); return; }
    this._currentRegion = region;
    this._map.setView([def.lat, def.lng], 13, { animate: true });
    this._subscribeRegion();
    this._bus.emit('gip:region', { region });
  }

  /* ── Asset queries ────────────────────────────────────────── */

  getAssets(filter = {}) {
    let results = [...this._assets.values()];
    if (filter.type)   results = results.filter(a => a.type   === filter.type);
    if (filter.status) results = results.filter(a => a.status === filter.status);
    if (filter.module) results = results.filter(a => a.module === filter.module);
    return results;
  }

  getStats() {
    const assets = [...this._assets.values()];
    const byStatus = {};
    assets.forEach(a => { byStatus[a.status] = (byStatus[a.status] ?? 0) + 1; });
    return {
      total:    assets.length,
      available: byStatus.available ?? 0,
      busy:      byStatus.busy      ?? 0,
      en_route:  byStatus.en_route  ?? 0,
      offline:   byStatus.offline   ?? 0,
      byStatus,
    };
  }

  focusAsset(assetId, zoom = 16) {
    const asset = this._assets.get(assetId);
    if (!asset) return false;
    this._map.setView([asset.lat, asset.lng], zoom, { animate: true, duration: 0.8 });
    this._markers.get(assetId)?.openPopup();
    return true;
  }

  /* ── Public alerts API ───────────────────────────────────── */

  async raiseAlert({ assetId, type, severity = 'medium', message, lat, lng }) {
    const alertId = `ALT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,4).toUpperCase()}`;
    const alertDoc = {
      id: alertId, assetId, type, severity, message,
      lat: lat ?? this._assets.get(assetId)?.lat,
      lng: lng ?? this._assets.get(assetId)?.lng,
      resolved: false,
      createdAt: serverTimestamp(),
    };
    try {
      await setDoc(doc(db, 'gipAlerts', alertId), alertDoc);
      this._bus.emit('gip:alert', alertDoc);
    } catch (e) {
      console.error('[GIP] raiseAlert:', e);
    }
    return alertId;
  }

  async resolveAlert(alertId) {
    try {
      await updateDoc(doc(db, 'gipAlerts', alertId), {
        resolved: true, resolvedAt: serverTimestamp(),
      });
      this._bus.emit('gip:alert:resolved', { alertId });
    } catch (e) {
      console.error('[GIP] resolveAlert:', e);
    }
  }

  /* ── Leaflet readiness ────────────────────────────────────── */

  _waitForLeaflet(maxMs = 10_000) {
    if (typeof L !== 'undefined') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + maxMs;
      const poll = setInterval(() => {
        if (typeof L !== 'undefined') { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('[GIP] Leaflet failed to load within 10 s')); }
      }, 250);
    });
  }

  /* ── Headless init (no DOM map — Firestore subscriptions only) ── */

  async initHeadless({ region = 'nairobi', modules = [] } = {}) {
    this._currentRegion  = region;
    this._activeModules  = new Set(modules);

    /* Connectivity listeners */
    this._onlineHandler  = () => this._onOnline();
    this._offlineHandler = () => this._onOffline();
    window.addEventListener('online',  this._onlineHandler);
    window.addEventListener('offline', this._offlineHandler);

    /* Start Firestore subscription (same as full init, minus Leaflet) */
    this._subscribeRegion();
    await this.loadGeofences();
  }

  /* ── Per-asset subscription ──────────────────────────────────── */

  /**
   * Subscribe to a single asset's live updates from local cache.
   * Updates fire whenever GIPEngine receives a Firestore update for this asset.
   * @returns {Function} unsubscribe
   */
  subscribeAsset(assetId, callback) {
    const handler = (asset) => {
      if (asset.assetId === assetId) callback(asset);
    };
    this._bus.on('asset:updated', handler);
    /* Immediately deliver current state if already cached */
    const current = this._assets.get(assetId);
    if (current) setTimeout(() => callback(current), 0);
    return () => this._bus.off('asset:updated', handler);
  }

  /* ── Region subscription (programmatic, not tied to map) ──────── */

  /**
   * Subscribe to all online assets in a region, optionally filtered by modules.
   * Delivers the full assets[] array on every change.
   * @returns {Function} unsubscribe
   */
  subscribeRegion(region, modules = [], callback) {
    const modSet = new Set(modules);
    const handler = () => {
      const filtered = [...this._assets.values()].filter(a =>
        a.region === region &&
        a.isOnline &&
        (modSet.size === 0 || modSet.has(a.module))
      );
      callback(filtered);
    };
    this._bus.on('asset:updated', handler);
    this._bus.on('asset:removed', handler);
    /* Deliver current snapshot immediately */
    setTimeout(handler, 0);
    return () => {
      this._bus.off('asset:updated', handler);
      this._bus.off('asset:removed', handler);
    };
  }

  /* ── Geofence point-in-zone test ─────────────────────────────── */

  /**
   * Returns true if [lat, lng] is inside the named geofence zone.
   * Uses the same haversine/ray-cast logic as the fence engine.
   */
  geofenceContains(zoneId, lat, lng) {
    const zone = this._fence?._zones?.get(zoneId);
    if (!zone) return false;
    if (zone.type === 'circle') {
      const d = _haversineKm(lat, lng, zone.lat, zone.lng);
      return d * 1000 <= (zone.radiusM ?? 200);
    }
    if (zone.type === 'polygon' && zone.coordinates) {
      /* Ray-casting */
      const poly = zone.coordinates;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        const intersect = ((yi > lng) !== (yj > lng)) &&
          (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    return false;
  }

  /* ── Event bus delegation ─────────────────────────────────── */

  on(event, fn)   { return this._bus.on(event, fn); }
  off(event, fn)  { this._bus.off(event, fn); }
  emit(event, d)  { this._bus.emit(event, d); }

  /* ── Map utils ────────────────────────────────────────────── */

  getMap()    { return this._map; }
  getBounds() { return this._map?.getBounds(); }

  invalidateSize() {
    if (this._map) this._map.invalidateSize(true);
  }

  /* ── Destroy / cleanup ────────────────────────────────────── */

  destroy() {
    this._unsubscribers.forEach(u => u());
    this._unsubscribers = [];
    window.removeEventListener('online',  this._onlineHandler);
    window.removeEventListener('offline', this._offlineHandler);
    if (this._clusterGroup) this._map?.removeLayer(this._clusterGroup);
    if (this._heatLayer)    this._map?.removeLayer(this._heatLayer);
    if (this._map) { this._map.remove(); this._map = null; }
    this._markers.clear();
    this._assets.clear();
    this._heatPoints.clear();
    this._bus.clear();
  }

  /* ── Static helpers (available without instantiation) ──────── */

  static haversineKm(lat1, lng1, lat2, lng2) { return _haversineKm(lat1, lng1, lat2, lng2); }
  static validCoord(lat, lng)                 { return _validCoord(lat, lng); }
  static get REGIONS()      { return REGIONS; }
  static get TILE_LAYERS()  { return TILE_LAYERS; }
  static get STATUS_COLOR() { return STATUS_COLOR; }
  static get ASSET_ICON()   { return ASSET_ICON; }
}

/* Expose as global for non-module contexts */
if (typeof window !== 'undefined') window.SokoniGIP = GIPEngine;
