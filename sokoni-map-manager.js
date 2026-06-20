/* ============================================================
   SOKONI MapManager
   Single responsibility: Leaflet map lifecycle, tile loading,
   and bulletproof invalidateSize across every scenario that
   causes blank/gray tiles — tab switch, screen lock, PWA
   resume, modal reveal, orientation change, accordion expand.
============================================================ */

export class MapManager {
  _map        = null;
  _containerId;
  _cleanups   = [];   // fns to call on destroy
  _handlers   = new Map();

  constructor(containerId) {
    this._containerId = containerId;
  }

  /* ── Init ─────────────────────────────────────────────── */

  init(center = [-1.2921, 36.8219], zoom = 14) {
    if (this._map) return this;

    const el = document.getElementById(this._containerId);
    if (!el) { console.warn(`MapManager: #${this._containerId} not found`); return this; }

    this._map = L.map(el, {
      center,
      zoom,
      fadeAnimation:  false,   // prevents blank-tile flash on iOS Safari
      zoomAnimation:  false,   // same — tile compositing issue
      zoomControl:    false,   // we add our own at bottomRight
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom:     19,
      detectRetina: false,     // retina tiles sometimes blank on iOS
    }).addTo(this._map);

    L.control.zoom({ position: 'bottomright' }).addTo(this._map);

    // Emit drag_start so TrackingManager can disable follow mode
    this._map.on('dragstart', () => this._emit('drag_start'));

    this._setupResize();
    this._setupVisibility();
    this._invalidateSequence();

    return this;
  }

  destroy() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
    if (this._map) { this._map.remove(); this._map = null; }
    this._handlers.clear();
  }

  /* ── Map accessors ────────────────────────────────────── */

  getMap()    { return this._map; }
  isReady()   { return !!this._map; }

  invalidateSize() {
    this._map?.invalidateSize(true);
  }

  fitBounds(latlngs, padding = [60, 60]) {
    if (!this._map || latlngs.length < 2) return;
    try {
      this._map.fitBounds(L.latLngBounds(latlngs), {
        padding, animate: true, duration: 0.5,
      });
    } catch(_) {}
  }

  panTo(lat, lng, opts = {}) {
    this._map?.panTo([lat, lng], {
      animate: true, duration: 0.4, easeLinearity: 0.5, ...opts,
    });
  }

  setView(lat, lng, zoom, opts = {}) {
    this._map?.setView([lat, lng], zoom, { animate: true, ...opts });
  }

  /* ── Events ───────────────────────────────────────────── */

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const h = this._handlers.get(event);
    if (h) this._handlers.set(event, h.filter(f => f !== fn));
  }

  /* ── Private ──────────────────────────────────────────── */

  _emit(event, ...args) {
    (this._handlers.get(event) || []).forEach(fn => fn(...args));
  }

  /* Multi-shot invalidateSize: handles deferred reflows and iOS Safari blank tiles */
  _invalidateSequence() {
    [100, 300, 700, 1400, 2600].forEach(ms =>
      setTimeout(() => this._map?.invalidateSize(true), ms)
    );
  }

  _setupResize() {
    const onResize = () => this._map?.invalidateSize(true);
    window.addEventListener('resize', onResize);
    this._cleanups.push(() => window.removeEventListener('resize', onResize));

    // Standard orientation change
    const onOrient = () => setTimeout(() => this._map?.invalidateSize(true), 350);
    window.addEventListener('orientationchange', onOrient);
    this._cleanups.push(() => window.removeEventListener('orientationchange', onOrient));

    // screen.orientation API (Chrome Android)
    if (screen.orientation) {
      screen.orientation.addEventListener('change', onOrient);
      this._cleanups.push(() => screen.orientation.removeEventListener('change', onOrient));
    }
  }

  _setupVisibility() {
    // visibilitychange fires on tab switch, screen lock, PWA minimize
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        this._invalidateSequence();
        this._emit('visible');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this._cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

    // IntersectionObserver fires when the map div enters the viewport
    // (handles accordion open, tab panel reveal, scroll-into-view)
    if (typeof IntersectionObserver !== 'undefined') {
      const el = document.getElementById(this._containerId);
      if (el) {
        const obs = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting)) {
            this._map?.invalidateSize(true);
            setTimeout(() => this._map?.invalidateSize(true), 200);
            this._emit('visible');
          }
        }, { threshold: 0.1 });
        obs.observe(el);
        this._cleanups.push(() => obs.disconnect());
      }
    }
  }
}
