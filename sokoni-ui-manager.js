/* ============================================================
   SOKONI UIManager
   Single responsibility: all DOM mutations.
   No map code, no GPS logic — receives data objects and
   writes them to the correct elements. Also manages the
   GPS staleness ticker, offline banner, confetti completion,
   and smart status messages.
============================================================ */

export class UIManager {
  _stalenessInterval = null;
  _lastUpdateMs      = 0;
  _isOffline         = false;
  _riderName         = null;

  static RIDER_NAMES  = ['James','Amina','Peter','Faith','Brian','Grace','Samuel'];
  static NAIROBI_ZONES = [
    { lat: -1.2921, lng: 36.8219, name: 'Nairobi CBD'  },
    { lat: -1.2673, lng: 36.8062, name: 'Westlands'    },
    { lat: -1.3192, lng: 36.8278, name: 'South B'      },
    { lat: -1.2588, lng: 36.8933, name: 'Eastleigh'    },
    { lat: -1.2978, lng: 36.7539, name: 'Karen'        },
    { lat: -1.2197, lng: 36.8839, name: 'Kasarani'     },
  ];

  constructor() {
    this._riderName = UIManager.RIDER_NAMES[Math.floor(Math.random() * UIManager.RIDER_NAMES.length)];
  }

  /* ── Show the map container ──────────────────────────── */
  showMapContainer() {
    const mc = document.getElementById('mapContainer');
    if (mc) mc.style.display = 'block';
  }

  /* ── Order ID in the status card ────────────────────── */
  setOrderId(orderId) {
    this._set('tscOrderId', orderId ? `Order #${orderId}` : 'Live Tracking');
  }

  /* ── Status card top-level message ──────────────────── */
  setStatus(msg) {
    this._set('tscStatus', msg);
  }

  /* ── ETA + Distance in top card ─────────────────────── */
  updateEtaCard(km, etaMins) {
    this._set('tscEta',   etaMins > 0 ? `${etaMins} min` : 'Arriving');
    this._set('tscDist',  parseFloat(km).toFixed(1));
  }

  /* ── Stats bar (distance, ETA, speed) ───────────────── */
  updateStatsBar(km, etaMins, speedKmh) {
    this._set('riderDistance', `${parseFloat(km).toFixed(1)} km`);
    this._set('riderEta',      etaMins > 0 ? `${etaMins} min` : 'Arriving');
    this._set('statSpeed',     `${Math.round(speedKmh || 0)} km/h`);
  }

  /* ── GPS timestamp and confidence indicator ─────────── */
  markGPSUpdate() {
    this._lastUpdateMs = Date.now();
    this._set('statUpdate', 'just now');
    this._setGPSIndicator('🟢 GPS');
  }

  startStalenessTimer() {
    if (this._stalenessInterval) return;
    this._stalenessInterval = setInterval(() => {
      if (!this._lastUpdateMs) return;

      const secs = Math.round((Date.now() - this._lastUpdateMs) / 1000);
      const el   = document.getElementById('statUpdate');
      if (el) {
        el.textContent  = secs < 5 ? 'just now' : `${secs}s ago`;
        el.style.color  = secs > 15 ? '#ffc107' : 'white';
      }

      if (!this._isOffline) {
        if (secs > 20) this._setGPSIndicator('🟡 GPS');
        else           this._setGPSIndicator('🟢 GPS');
      }
    }, 1000);
  }

  stopStalenessTimer() {
    if (this._stalenessInterval) {
      clearInterval(this._stalenessInterval);
      this._stalenessInterval = null;
    }
  }

  /* ── Confidence meter (0–100) ────────────────────────── */
  updateConfidence(km) {
    const dist = parseFloat(km);
    let pct, icon, label, color;
    if (dist > 3)      { pct = Math.min(90, 60 + dist * 2); icon = '🟢'; label = 'On Track'; color = '#71ff00'; }
    else if (dist > 1) { pct = 80;                           icon = '🟢'; label = 'On Track'; color = '#71ff00'; }
    else               { pct = 96;                           icon = '🟢'; label = 'Nearby';   color = '#71ff00'; }

    const fill = document.getElementById('confFill');
    if (fill) { fill.style.width = `${Math.min(100, pct)}%`; fill.style.background = color; }
    const val  = document.getElementById('confVal');
    if (val)  val.textContent = `${label} (${Math.round(pct)}%)`;
    const ic   = document.getElementById('confIcon');
    if (ic)   ic.textContent = icon;
  }

  /* ── Smart status message ────────────────────────────── */
  buildSmartStatus(lat, lng, km, etaMins) {
    const dist  = parseFloat(km);
    const name  = this._riderName;

    if (dist < 0.12) return `🎉 ${name} has arrived!`;
    if (dist < 0.5)  return `📍 ${name} is just around the corner!`;
    if (dist < 1)    return `🛵 ${name} is less than 1 km away. Expected in ${etaMins} min.`;

    // Find nearest named zone for contextual message
    let nearest = null, nearestDist = Infinity;
    UIManager.NAIROBI_ZONES.forEach(z => {
      const d = Math.sqrt(Math.pow(z.lat - lat, 2) + Math.pow(z.lng - lng, 2));
      if (d < nearestDist) { nearestDist = d; nearest = z; }
    });

    if (nearest && nearestDist < 0.025) {
      return `🛵 ${name} is near ${nearest.name}. Expected in ${etaMins} min.`;
    }
    return `📦 ${name} is on the way. Expected in ${etaMins} min.`;
  }

  /* ── Delivery timeline steps ─────────────────────────── */
  /*
     steps: array of { label, done }
     done:true → ✓ checkmark, current (first not done) → 🚚, rest → ○
  */
  renderTimeline(steps) {
    const container = document.getElementById('deliveryTimeline');
    if (!container || !steps) return;

    const currentIdx = steps.findIndex(s => !s.done);

    container.innerHTML = steps.map((s, i) => {
      let icon;
      if (s.done)          icon = `<span class="dt-check">✓</span>`;
      else if (i === currentIdx) icon = `<span class="dt-current">🚚</span>`;
      else                 icon = `<span class="dt-pending">○</span>`;
      return `<div class="dt-step ${s.done ? 'done' : ''}">${icon}<span>${s.label}</span></div>`;
    }).join('');
  }

  /* ── Offline banner ──────────────────────────────────── */
  /* Uses the existing #offlineBanner div in track.html (toggled via .show class) */
  showOfflineBanner() {
    this._isOffline = true;
    this._setGPSIndicator('📵 Offline');
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.add('show');
  }

  hideOfflineBanner() {
    this._isOffline = false;
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.remove('show');
  }

  /* ── Delivery completion ─────────────────────────────── */
  showCompletionOverlay(orderId) {
    const overlay = document.getElementById('deliveryComplete');
    if (!overlay) return;
    overlay.classList.add('show');   // CSS .delivery-complete.show { display:flex }
    this._fireConfetti();
    // Update sub-text with rider name + order id
    const sub = document.getElementById('dcSub');
    if (sub) sub.textContent = `Delivered by ${this._riderName}. Hope you love your order!`;
  }

  _fireConfetti() {
    const colors = ['#71ff00', '#00e676', '#ffee58', '#29b6f6', '#ff7043'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.style.cssText = `
        position:fixed;top:-10px;
        left:${Math.random() * 100}%;
        width:${6 + Math.random() * 8}px;
        height:${6 + Math.random() * 8}px;
        background:${colors[Math.floor(Math.random() * colors.length)]};
        border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
        z-index:10000;
        animation:confettiFall ${1.5 + Math.random() * 1.5}s ease-in forwards;
        animation-delay:${Math.random() * 0.8}s;`;
      document.body.appendChild(piece);
      piece.addEventListener('animationend', () => piece.remove());
    }
  }

  /* ── Share tracking link ─────────────────────────────── */
  shareTrackingLink(orderId) {
    const url = `https://mysokoni.co.ke/track/${orderId || 'SK0000'}`;
    if (navigator.share) {
      navigator.share({ title: 'Track my SOKONI delivery', url });
    } else {
      navigator.clipboard?.writeText(url).then(() => {
        this._toast('Link copied!');
      }).catch(() => {
        this._toast(url);
      });
    }
  }

  _toast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:rgba(113,255,0,0.9);color:#0a0a0a;font-weight:700;
      padding:10px 20px;border-radius:20px;font-size:13px;z-index:9998;
      animation:fadeToast 2.5s ease forwards;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  /* ── Internal helpers ────────────────────────────────── */
  _set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  _setGPSIndicator(text) {
    const gps = document.getElementById('gpsConfidence');
    if (gps) gps.textContent = text;
  }

  destroy() {
    this.stopStalenessTimer();
  }
}
