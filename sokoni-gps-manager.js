/* ============================================================
   SOKONI GPSManager
   Single responsibility: smooth marker interpolation,
   bearing (direction) calculation, speed estimation,
   Bezier-curve simulation, and real device geolocation.

   The requestAnimationFrame ease-in-out interpolation is
   what makes the driver icon "glide" rather than jump —
   the most visible quality difference from basic apps.
============================================================ */

export class GPSManager {
  _animFrame  = null;
  _simInterval = null;
  _handlers   = new Map();

  /* Last confirmed position — updated at end of each animation */
  _position = { lat: null, lng: null, bearing: 0, speed: 0 };

  /* ── Set starting position before first animateTo call ── */
  setInitialPosition(lat, lng) {
    this._position.lat = lat;
    this._position.lng = lng;
  }

  getPosition() {
    return { ...this._position };
  }

  /* ── Smooth marker animation (requestAnimationFrame) ──── */
  /*
     Uses the marker's actual current visual position as the
     "from" point so interrupting an in-progress animation
     never causes a jump to a stale coordinate.

     The ease-in-out quad formula:
       t < 0.5  →  2t²          (accelerate)
       t ≥ 0.5  →  -1+(4-2t)t   (decelerate)
  */
  animateTo(marker, toLat, toLng, durationMs = 2600, onFrame = null) {
    if (!marker) return;

    // Use the marker's live visual position as the start point
    const ll      = marker.getLatLng();
    const fromLat = ll.lat;
    const fromLng = ll.lng;
    const t0      = performance.now();

    // Derive bearing + speed from the vector
    if (Math.abs(fromLat - toLat) > 1e-7 || Math.abs(fromLng - toLng) > 1e-7) {
      this._position.bearing = this.calcBearing(fromLat, fromLng, toLat, toLng);

      // Metres per second → km/h
      const dM = Math.sqrt(
        Math.pow((toLat - fromLat) * 111_000, 2) +
        Math.pow((toLng - fromLng) * 111_000 * Math.cos(fromLat * Math.PI / 180), 2)
      );
      this._position.speed = Math.min(80, Math.round(dM / (durationMs / 1000) * 3.6));
    }

    if (this._animFrame) cancelAnimationFrame(this._animFrame);

    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;  // ease-in-out

      const lat = fromLat + (toLat - fromLat) * e;
      const lng = fromLng + (toLng - fromLng) * e;

      marker.setLatLng([lat, lng]);

      // Optional per-frame callback — used by TrackingManager to pan the map
      if (onFrame) onFrame({ lat, lng, bearing: this._position.bearing, speed: this._position.speed });

      if (t < 1) {
        this._animFrame = requestAnimationFrame(step);
      } else {
        // Animation complete — store confirmed position
        this._position.lat = toLat;
        this._position.lng = toLng;
        this._emit('position', { ...this._position });
      }
    };

    this._animFrame = requestAnimationFrame(step);
  }

  /* ── Road-following simulation ────────────────────────── */
  /*
     When a roadPath is supplied (from RouteManager.getRoadPath),
     the driver steps through actual road waypoints.
     Falls back to quadratic Bezier if no road path is available.
     Each step emits 'simulation_step' — TrackingManager calls
     animateTo in response.
  */
  startSimulation(origin, destination, { steps = 35, intervalMs = 2800, roadPath = null } = {}) {
    this.stopSimulation();

    const { lat: oLat, lng: oLng } = origin;

    this._position.lat = oLat;
    this._position.lng = oLng;

    if (roadPath && roadPath.length > 1) {
      /* Subsample road path to ~steps waypoints for consistent timing */
      const sampled = this._samplePath(roadPath, Math.max(steps, roadPath.length > 60 ? 60 : roadPath.length));
      let idx = 0;

      this._simInterval = setInterval(() => {
        if (idx >= sampled.length) {
          this.stopSimulation();
          this._emit('arrived');
          return;
        }
        const [lat, lng] = sampled[idx];
        const t = idx / Math.max(1, sampled.length - 1);
        this._emit('simulation_step', { step: idx + 1, total: sampled.length, lat, lng, t });
        idx++;
      }, intervalMs);
      return;
    }

    /* Bezier fallback when no road path */
    const { lat: dLat, lng: dLng } = destination;
    const cpLat = oLat + (dLat - oLat) * 0.5 - 0.004;
    const cpLng = oLng + (dLng - oLng) * 0.5 + 0.006;
    let step = 0;

    this._simInterval = setInterval(() => {
      if (step >= steps) {
        this.stopSimulation();
        this._emit('arrived');
        return;
      }
      step++;
      const t = step / steps;
      const lat = (1-t)*(1-t)*oLat + 2*(1-t)*t*cpLat + t*t*dLat;
      const lng = (1-t)*(1-t)*oLng + 2*(1-t)*t*cpLng + t*t*dLng;
      this._emit('simulation_step', { step, total: steps, lat, lng, t });
    }, intervalMs);
  }

  /* Evenly sample n points from a path array */
  _samplePath(path, n) {
    if (path.length <= n) return path;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(path[Math.round(i * (path.length - 1) / (n - 1))]);
    }
    return out;
  }

  stopSimulation() {
    if (this._simInterval)  { clearInterval(this._simInterval);       this._simInterval = null; }
    if (this._animFrame)    { cancelAnimationFrame(this._animFrame);  this._animFrame   = null; }
  }

  /* ── Bearing (compass heading 0–360°) ────────────────── */
  calcBearing(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    return (Math.atan2(
      Math.sin(Δλ) * Math.cos(φ2),
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    ) * 180 / Math.PI + 360) % 360;
  }

  /* ── Straight-line distance in km ────────────────────── */
  distanceKm(lat1, lng1, lat2, lng2) {
    return Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lng2 - lng1, 2)) * 111;
  }

  /* ── Real device GPS ──────────────────────────────────── */
  getUserLocation(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        reject,
        { enableHighAccuracy: true, timeout: 8000, ...opts }
      );
    });
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
    return this;
  }

  _emit(event, ...args) {
    (this._handlers.get(event) || []).forEach(fn => fn(...args));
  }

  destroy() {
    this.stopSimulation();
    this._handlers.clear();
  }
}
