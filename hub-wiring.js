/* ================================================================
   HUB WIRING  v1.0
   Universal provider + booking + listing wiring for ALL hubs.
   Auto-loaded on every page via security.js injection.
   ──────────────────────────────────────────────────────────────
   • HubWiring.saveBooking(data)  → Firestore bookings + localStorage
   • HubWiring.saveListing(data)  → Firestore listings + localStorage
   • HubWiring.deleteListing(id)  → Firestore listings + localStorage
   • HubWiring.getMyListings()    → array of listings owned by current user
   • HubWiring.initHub(hubId)     → injects Edit/Status buttons on owned cards
   • HubWiring.setStatus(id,st)   → toggle listing status (available/busy/offline)
   • HubWiring.onAuth(uid)        → called by auth.js after login
================================================================ */

(function () {
  'use strict';

  /* ── XSS helper ─────────────────────────────────────────── */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  /* ── Hub page detection ─────────────────────────────────── */
  const HUB_MAP = {
    'car-hub'         : 'car',
    'bnb'             : 'bnb',
    'landlord'        : 'bnb',
    'food-hub'        : 'food',
    'fitness-hub'     : 'fitness',
    'healthcare-hub'  : 'healthcare',
    'legal-hub'       : 'legal',
    'entertainment-hub': 'entertainment',
    'sports-hub'      : 'sports',
    'mechanic'        : 'mechanics',
    'cleaning'        : 'cleaning',
    'construction'    : 'construction',
    'home-services'   : 'home',
    'business-os'     : 'business',
    'services'        : 'services',
  };

  function _detectHub() {
    const path = location.pathname.replace(/^\//, '').replace(/\.html$/, '').toLowerCase();
    for (const [key, val] of Object.entries(HUB_MAP)) {
      if (path.includes(key)) return val;
    }
    return null;
  }

  /* ── Internal state ─────────────────────────────────────── */
  let _db  = null;
  let _uid = null;
  const LISTINGS_LS_KEY = 'hwListings';

  /* ── Firestore helpers ──────────────────────────────────── */
  function _getDb() {
    if (_db) return _db;
    if (window.firebase && firebase.firestore) {
      try { _db = firebase.firestore(); } catch(e) {}
    }
    return _db;
  }

  function _fsWrite(collection, docId, data) {
    const db = _getDb();
    if (!db) return Promise.resolve();
    return db.collection(collection).doc(docId).set(data, { merge: true })
      .catch(e => console.warn('[HubWiring] Firestore write failed:', e));
  }

  function _fsDelete(collection, docId) {
    const db = _getDb();
    if (!db) return Promise.resolve();
    return db.collection(collection).doc(docId).delete()
      .catch(e => console.warn('[HubWiring] Firestore delete failed:', e));
  }

  /* ── localStorage helpers ───────────────────────────────── */
  function _lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch(e) { return null; }
  }
  function _lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
  }

  /* ── ID generator ───────────────────────────────────────── */
  function _id(prefix) {
    return (prefix || 'hw') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */

  const HubWiring = {

    /* Called by auth.js / sokoni-db.js after login */
    onAuth(uid) {
      _uid = uid || null;
    },

    /* ── Save a provider listing ─────────────────────────── */
    saveListing(data) {
      if (!data) return;
      const id = data.id || _id('lst');
      const hub = data.hub || _detectHub() || 'general';
      const doc = Object.assign({}, data, {
        id,
        hub,
        ownerId  : _uid || data.ownerId || '',
        updatedAt: new Date().toISOString(),
        createdAt: data.createdAt || new Date().toISOString(),
        status   : data.status || 'available',
      });

      /* localStorage */
      const all = _lsGet(LISTINGS_LS_KEY) || {};
      all[id] = doc;
      _lsSet(LISTINGS_LS_KEY, all);
      _lsSet('hwListing_' + id, JSON.stringify(doc));

      /* Firestore */
      if (_uid) {
        _fsWrite('listings', id, doc);
        _fsWrite('providers', _uid + '_' + hub, {
          uid       : _uid,
          hub,
          listingId : id,
          status    : doc.status,
          updatedAt : doc.updatedAt,
        });
      }

      return id;
    },

    /* ── Delete a provider listing ───────────────────────── */
    deleteListing(id) {
      const all = _lsGet(LISTINGS_LS_KEY) || {};
      delete all[id];
      _lsSet(LISTINGS_LS_KEY, all);
      localStorage.removeItem('hwListing_' + id);
      if (_uid) _fsDelete('listings', id);
    },

    /* ── Save a booking ──────────────────────────────────── */
    saveBooking(data) {
      if (!data) return;
      const id = data.id || _id('bk');
      const hub = data.hub || _detectHub() || 'general';
      const doc = Object.assign({}, data, {
        id,
        hub,
        userId   : _uid || data.userId || '',
        createdAt: data.createdAt || new Date().toISOString(),
        status   : data.status || 'pending',
      });

      /* localStorage — use the hub's native key + a universal key */
      _lsSet('hwBooking_' + id, JSON.stringify(doc));

      /* Firestore */
      if (_uid) {
        _fsWrite('bookings', id, doc);
      }

      return id;
    },

    /* ── Toggle listing status ───────────────────────────── */
    setStatus(id, status) {
      if (!id) return;
      const all = _lsGet(LISTINGS_LS_KEY) || {};
      if (all[id]) {
        all[id].status = status;
        all[id].updatedAt = new Date().toISOString();
        _lsSet(LISTINGS_LS_KEY, all);
      }
      _lsSet('hwStatus_' + id, status);
      if (_uid) {
        _fsWrite('listings', id, { status, updatedAt: new Date().toISOString() });
      }
    },

    /* ── Get listings owned by current user ──────────────── */
    getMyListings(hub) {
      const all = _lsGet(LISTINGS_LS_KEY) || {};
      return Object.values(all).filter(l =>
        (!hub || l.hub === hub) && (l.ownerId === _uid || !_uid)
      );
    },

    /* ── Get all listings for a hub (public) ─────────────── */
    getListings(hub) {
      const all = _lsGet(LISTINGS_LS_KEY) || {};
      return Object.values(all).filter(l => !hub || l.hub === hub);
    },

    /* ── Pull listings from Firestore ───────────────────────
       One-shot seed; realtime.js installs an onSnapshot on top. */
    pullListings(hub) {
      const db = _getDb();
      if (!db) return Promise.resolve([]);
      let q = db.collection('listings');
      if (hub) q = q.where('hub', '==', hub);
      return q.get().then(snap => {
        const all = _lsGet(LISTINGS_LS_KEY) || {};
        snap.forEach(d => { const data = d.data(); all[data.id || d.id] = data; });
        _lsSet(LISTINGS_LS_KEY, all);
        return Object.values(all).filter(l => !hub || l.hub === hub);
      }).catch(e => { console.warn('[HubWiring] pullListings failed:', e); return []; });
    },

    /* ── Init hub: inject manage-UI on owned cards ───────── */
    initHub(hubId) {
      const hub = hubId || _detectHub();
      if (!hub || !_uid) return;

      /* Defer until DOM settles */
      setTimeout(() => _injectManageButtons(hub), 800);

      /* Also re-inject when content changes (for dynamically rendered cards) */
      if (window.MutationObserver) {
        const obs = new MutationObserver(_debounce(() => _injectManageButtons(hub), 500));
        obs.observe(document.body, { childList: true, subtree: true });
      }
    },
  };

  /* ── Status badge colours ───────────────────────────────── */
  const STATUS_STYLES = {
    available: 'background:#22c55e;color:#fff',
    busy      : 'background:#f59e0b;color:#fff',
    offline   : 'background:#6b7280;color:#fff',
  };

  function _nextStatus(cur) {
    const cycle = ['available', 'busy', 'offline'];
    const i = cycle.indexOf(cur);
    return cycle[(i + 1) % cycle.length];
  }

  /* ── Inject manage buttons on cards owned by current user ─ */
  function _injectManageButtons(hub) {
    if (!_uid) return;
    const listings = HubWiring.getMyListings(hub);
    if (!listings.length) return;

    /* Look for cards that reference a known listing id */
    listings.forEach(lst => {
      /* Try data-listing-id, data-id, or id attr on card elements */
      const selectors = [
        `[data-listing-id="${lst.id}"]`,
        `[data-id="${lst.id}"]`,
        `#${CSS.escape ? CSS.escape(lst.id) : lst.id}`,
      ];
      selectors.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(card => {
            if (card.querySelector('.hw-manage-bar')) return; /* already injected */
            _appendManageBar(card, lst);
          });
        } catch(e) {}
      });
    });
  }

  function _appendManageBar(card, lst) {
    const bar = document.createElement('div');
    bar.className = 'hw-manage-bar';
    bar.style.cssText = [
      'display:flex','align-items:center','gap:8px','padding:6px 10px',
      'background:rgba(0,0,0,.05)','border-radius:0 0 10px 10px',
      'font-size:13px','font-weight:600','flex-wrap:wrap',
    ].join(';');

    const curStatus = lst.status || 'available';
    const stStyle   = STATUS_STYLES[curStatus] || STATUS_STYLES.available;

    bar.innerHTML = `
      <button class="hw-status-btn" data-id="${_esc(lst.id)}" data-status="${_esc(curStatus)}"
        style="border:none;border-radius:20px;padding:3px 10px;cursor:pointer;font-size:12px;${stStyle}">
        ${_esc(curStatus.charAt(0).toUpperCase() + curStatus.slice(1))}
      </button>
      <button class="hw-edit-btn" data-id="${_esc(lst.id)}"
        style="border:none;border-radius:20px;padding:3px 10px;cursor:pointer;
               background:#3b82f6;color:#fff;font-size:12px;">
        ✏️ Edit
      </button>
      <button class="hw-del-btn" data-id="${_esc(lst.id)}"
        style="border:none;border-radius:20px;padding:3px 10px;cursor:pointer;
               background:#ef4444;color:#fff;font-size:12px;">
        🗑 Delete
      </button>`;

    card.style.position = card.style.position || 'relative';
    card.appendChild(bar);

    /* Status toggle */
    bar.querySelector('.hw-status-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const id  = this.dataset.id;
      const cur = this.dataset.status;
      const nxt = _nextStatus(cur);
      HubWiring.setStatus(id, nxt);
      this.dataset.status = nxt;
      this.textContent = nxt.charAt(0).toUpperCase() + nxt.slice(1);
      Object.assign(this.style, _parseStyle(STATUS_STYLES[nxt]));
    });

    /* Edit — opens generic modal or hub-specific one */
    bar.querySelector('.hw-edit-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const id = this.dataset.id;
      if (typeof window.hwOpenEdit === 'function') {
        window.hwOpenEdit(id);
      } else {
        _openGenericEditModal(id);
      }
    });

    /* Delete */
    bar.querySelector('.hw-del-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const id = this.dataset.id;
      if(!_c){_skConfirm('Delete this listing?',()=>_doHwDelListing(_lid,true));return;}
      HubWiring.deleteListing(id);
      const card = this.closest('[data-listing-id],[data-id]');
      if (card) card.remove();
    });
  }

  /* ── Generic edit modal ────────────────────────────────────*/
  function _openGenericEditModal(id) {
    const all = _lsGet(LISTINGS_LS_KEY) || {};
    const lst = all[id];
    if (!lst) return;

    let modal = document.getElementById('hwGenericEditModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'hwGenericEditModal';
      modal.style.cssText = [
        'position:fixed','inset:0','z-index:9999',
        'background:rgba(0,0,0,.5)',
        'display:flex','align-items:center','justify-content:center',
      ].join(';');
      modal.innerHTML = `
        <div style="background:#fff;border-radius:16px;padding:24px;width:min(420px,95vw);max-height:90vh;overflow-y:auto">
          <h3 style="margin:0 0 16px;font-size:18px">Edit Listing</h3>
          <label style="display:block;margin-bottom:8px;font-size:14px">Title
            <input id="hwEditTitle" style="display:block;width:100%;margin-top:4px;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:16px">
          </label>
          <label style="display:block;margin-bottom:8px;font-size:14px">Description
            <textarea id="hwEditDesc" rows="3" style="display:block;width:100%;margin-top:4px;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:16px;resize:vertical"></textarea>
          </label>
          <label style="display:block;margin-bottom:8px;font-size:14px">Price (KSh)
            <input id="hwEditPrice" type="number" min="0" style="display:block;width:100%;margin-top:4px;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:16px">
          </label>
          <label style="display:block;margin-bottom:16px;font-size:14px">Phone
            <input id="hwEditPhone" type="tel" style="display:block;width:100%;margin-top:4px;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:16px">
          </label>
          <input type="hidden" id="hwEditId">
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="hwEditCancel" style="padding:10px 20px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:15px">Cancel</button>
            <button id="hwEditSave" style="padding:10px 20px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer;font-size:15px;font-weight:600">Save</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      document.getElementById('hwEditCancel').addEventListener('click', () => { modal.style.display = 'none'; });
      document.getElementById('hwEditSave').addEventListener('click', () => {
        const eid   = document.getElementById('hwEditId').value;
        const eAll  = _lsGet(LISTINGS_LS_KEY) || {};
        if (eAll[eid]) {
          eAll[eid].title       = document.getElementById('hwEditTitle').value.trim();
          eAll[eid].description = document.getElementById('hwEditDesc').value.trim();
          eAll[eid].price       = parseFloat(document.getElementById('hwEditPrice').value) || 0;
          eAll[eid].phone       = document.getElementById('hwEditPhone').value.trim();
          eAll[eid].updatedAt   = new Date().toISOString();
          _lsSet(LISTINGS_LS_KEY, eAll);
          if (_uid) _fsWrite('listings', eid, eAll[eid]);
        }
        modal.style.display = 'none';
      });
    }

    document.getElementById('hwEditId').value    = id;
    document.getElementById('hwEditTitle').value  = lst.title || '';
    document.getElementById('hwEditDesc').value   = lst.description || '';
    document.getElementById('hwEditPrice').value  = lst.price || '';
    document.getElementById('hwEditPhone').value  = lst.phone || '';
    modal.style.display = 'flex';
  }

  /* ── Helper: parse "key:val;key:val" style string into object ─ */
  function _parseStyle(str) {
    const obj = {};
    str.split(';').forEach(part => {
      const [k, v] = part.split(':');
      if (k && v) obj[k.trim().replace(/-([a-z])/g, (_,c) => c.toUpperCase())] = v.trim();
    });
    return obj;
  }

  /* ── Debounce ───────────────────────────────────────────── */
  function _debounce(fn, ms) {
    let t;
    return function(...args) { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── Wire into auth events ──────────────────────────────── */
  document.addEventListener('sokoniAuthReady', function(e) {
    const uid = e.detail && e.detail.uid;
    if (uid) HubWiring.onAuth(uid);
  });

  /* Listen for Firebase auth changes via global hook */
  const _origOnAuth = window.onSokoniAuth;
  window.onSokoniAuth = function(uid) {
    HubWiring.onAuth(uid);
    if (typeof _origOnAuth === 'function') _origOnAuth(uid);
  };

  /* ── Auto-init on DOMContentLoaded ─────────────────────── */
  document.addEventListener('DOMContentLoaded', function() {
    const hub = _detectHub();
    if (!hub) return;

    /* Pull fresh listings from Firestore for this hub */
    if (_uid) HubWiring.pullListings(hub);

    /* Init manage buttons after a short delay (let hub render) */
    HubWiring.initHub(hub);
  });

  /* ── Expose globally ────────────────────────────────────── */
  window.HubWiring = HubWiring;

}());

