/* ================================================================
   PROVIDER WIRING  v1.0
   Fixes all cross-hub provider & booking gaps in one file.
   Auto-loaded on every page via security.js injection.
   ─────────────────────────────────────────────────────────────────
   1. FOOD CART BRIDGE   sokoniCart ↔ cart (fixes food checkout)
   2. PROVIDER SYNC      any hub's provider save → Firestore providers
   3. BOOKING SYNC       car / BnB / ride bookings → Firestore bookings
   4. DISCOVERY PULL     hub pages without local data pull from Firestore
================================================================ */

(function () {
  'use strict';

  const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  let _db  = null;
  let _uid = null;
  let _bridging = false;  /* recursion guard for cart bridge */

  function _getDb() {
    if (_db) return _db;
    if (window.firebaseDB) { _db = window.firebaseDB; return _db; }
    return null;
  }

  /* ── XSS safe escape ───────────────────────────────────────── */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Firestore write (merge) ────────────────────────────────── */
  async function _fsSet(col, docId, data) {
    const db = _getDb();
    if (!db || !docId) return;
    try {
      const { doc, setDoc, serverTimestamp } = await import(FS_URL);
      const safe = Object.assign({}, data);
      delete safe._syncedAt;
      await setDoc(doc(db, col, String(docId)), { ...safe, _syncedAt: serverTimestamp() }, { merge: true });
    } catch(e) {
      console.warn('[ProviderWiring]', col, e.message);
    }
  }

  /* ── Firestore getDocs helper ───────────────────────────────── */
  async function _fsGetAll(col) {
    const db = _getDb();
    if (!db) return [];
    try {
      const { collection, getDocs } = await import(FS_URL);
      const snap = await getDocs(collection(db, col));
      return snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; });
    } catch(e) {
      console.warn('[ProviderWiring] getDocs', col, e.message);
      return [];
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     1. FOOD CART BRIDGE — sync sokoniCart ↔ cart
     food.html uses "sokoniCart", checkout cart.html uses "cart"
  ═══════════════════════════════════════════════════════════════ */

  function _mergeCarts() {
    try {
      const sc  = JSON.parse(localStorage.getItem('sokoniCart') || '[]');
      const mc  = JSON.parse(localStorage.getItem('cart')       || '[]');
      const scIds = new Set(sc.map(i => i.id));
      const mcIds = new Set(mc.map(i => i.id));

      /* Merge food items into main cart */
      if (sc.length > 0) {
        const merged = [...mc];
        sc.forEach(item => { if (!mcIds.has(item.id)) merged.push(item); });
        if (merged.length !== mc.length) {
          localStorage.setItem('cart', JSON.stringify(merged));
        }
      }

      /* Merge main cart items into sokoniCart so food.html badge counts match */
      if (mc.length > 0) {
        const merged2 = [...sc];
        mc.forEach(item => { if (!scIds.has(item.id)) merged2.push(item); });
        if (merged2.length !== sc.length) {
          localStorage.setItem('sokoniCart', JSON.stringify(merged2));
        }
      }
    } catch(e) {}
  }

  /* Patch localStorage.setItem to keep carts in sync in real time */
  (function _patchCartBridge() {
    const prev = localStorage.setItem;
    localStorage.setItem = function(key, value) {
      prev.call(this, key, value);
      if (_bridging) return;
      if (key === 'sokoniCart') {
        _bridging = true;
        try { prev.call(this, 'cart', value); } finally { _bridging = false; }
      } else if (key === 'cart') {
        _bridging = true;
        try { prev.call(this, 'sokoniCart', value); } finally { _bridging = false; }
      }
    };
  }());

  /* Run merge on load (covers food→cart.html redirect) */
  _mergeCarts();

  /* ═══════════════════════════════════════════════════════════════
     2. PROVIDER SYNC — write to Firestore providers collection
  ═══════════════════════════════════════════════════════════════ */

  /* Generic: write any provider/listing object to Firestore */
  function _writeProvider(hub, id, data) {
    if (!id || !_uid) return;
    _fsSet('providers', String(id), {
      ...data,
      uid: _uid,
      hub: hub,
      status: data.status || 'available',
      updatedAt: new Date().toISOString(),
    });
    /* Also write to hub-specific collection if applicable */
    if (hub === 'legal') {
      _fsSet('lawyers', String(id), { ...data, uid: _uid });
    }
    if (hub === 'mechanics') {
      _fsSet('mechanics', String(id), { ...data, uid: _uid });
    }
  }

  /* Healthcare: patch submitRegFac */
  function _patchHealthcare() {
    if (!window.submitRegFac || window.submitRegFac.__pw) return;
    const orig = window.submitRegFac;
    window.submitRegFac = function(...a) {
      orig.apply(this, a);
      setTimeout(() => {
        try {
          const pending = JSON.parse(localStorage.getItem('sokoniHcFacPending') || '[]');
          const latest  = Array.isArray(pending) ? pending[0] : pending;
          if (latest) {
            const id = 'hc_' + (latest.phone || latest.name || Date.now()).toString().replace(/\W/g, '').slice(0, 20);
            _writeProvider('healthcare', id, { ...latest, type: 'healthcare' });
          }
        } catch(e) {}
      }, 400);
    };
    window.submitRegFac.__pw = true;
  }

  /* Services: patch registerProvider */
  function _patchServicesProvider() {
    if (!window.registerProvider || window.registerProvider.__pw) return;
    const orig = window.registerProvider;
    window.registerProvider = function(...a) {
      orig.apply(this, a);
      setTimeout(() => {
        try {
          const profile = JSON.parse(localStorage.getItem('sokoniProviderProfile') || 'null');
          if (profile) {
            const id = 'svc_' + (_uid || profile.phone || Date.now()).toString().replace(/\W/g,'').slice(0,20);
            _writeProvider('services', id, profile);
          }
        } catch(e) {}
      }, 400);
    };
    window.registerProvider.__pw = true;
  }

  /* Legal: patch any advocate/lawyer registration function */
  function _patchLegal() {
    ['submitAdvocate', 'registerLawyer', 'saveLawyerProfile', 'submitFirmRegistration'].forEach(fn => {
      if (!window[fn] || window[fn].__pw) return;
      const orig = window[fn];
      window[fn] = function(...a) {
        orig.apply(this, a);
        setTimeout(() => {
          try {
            const lawyers = JSON.parse(
              localStorage.getItem('sokoni_firm_registrations') ||
              localStorage.getItem('sokoniLegalApplications') ||
              '[]'
            );
            const latest = Array.isArray(lawyers) ? lawyers[0] : lawyers;
            if (latest) {
              const id = 'law_' + (_uid || Date.now()).toString().replace(/\W/g,'').slice(0,20);
              _writeProvider('legal', id, { ...latest, type: 'lawyer' });
            }
          } catch(e) {}
        }, 400);
      };
      window[fn].__pw = true;
    });
  }

  /* BnB host: patch bnb listing save */
  function _patchBnBHost() {
    ['saveProperty', 'addBnBListing', 'saveBnBProperty'].forEach(fn => {
      if (!window[fn] || window[fn].__pw) return;
      const orig = window[fn];
      window[fn] = function(...a) {
        orig.apply(this, a);
        setTimeout(() => {
          try {
            const bnbs = JSON.parse(localStorage.getItem('sokoniBnBs') || '[]');
            const latest = bnbs[bnbs.length - 1] || bnbs[0];
            if (latest) {
              const id = 'bnb_' + (_uid || latest.name || Date.now()).toString().replace(/\W/g,'').slice(0,20);
              _writeProvider('bnb', id, { ...latest, type: 'bnb_host' });
            }
          } catch(e) {}
        }, 400);
      };
      window[fn].__pw = true;
    });
  }

  /* Mechanics: patch mechanic save */
  function _patchMechanics() {
    ['saveMechanic', 'registerMechanic', 'submitMechanicApp'].forEach(fn => {
      if (!window[fn] || window[fn].__pw) return;
      const orig = window[fn];
      window[fn] = function(...a) {
        orig.apply(this, a);
        setTimeout(() => {
          try {
            const mechs = JSON.parse(localStorage.getItem('sokoniMechanics') || '[]');
            const latest = mechs[0];
            if (latest) {
              const id = 'mech_' + (_uid || latest.phone || Date.now()).toString().replace(/\W/g,'').slice(0,20);
              _writeProvider('mechanics', id, { ...latest, type: 'mechanic' });
            }
          } catch(e) {}
        }, 400);
      };
      window[fn].__pw = true;
    });
  }

  /* Also watch localStorage for provider-related key writes */
  (function _watchProviderKeys() {
    const PROVIDER_KEYS = {
      'sokoniHcFacPending'       : 'healthcare',
      'sokoniMechanics'          : 'mechanics',
      'sokoniBnBs'               : 'bnb',
      'sokoniGyms'               : 'fitness',
      'sokoniServiceProviders'   : 'services',
      'sokoni_firm_registrations': 'legal',
    };

    const prevSet = localStorage.setItem;
    localStorage.setItem = function(key, value) {
      prevSet.call(this, key, value);
      const hub = PROVIDER_KEYS[key];
      if (!hub || !_uid) return;
      setTimeout(() => {
        try {
          const arr  = JSON.parse(value || '[]');
          const list = Array.isArray(arr) ? arr : [arr];
          list.forEach((item, i) => {
            if (!item) return;
            const id = hub + '_' + (_uid || '') + '_' + (item.phone || item.name || i).toString().replace(/\W/g,'').slice(0,20);
            _writeProvider(hub, id, item);
          });
        } catch(e) {}
      }, 500);
    };
  }());

  /* ═══════════════════════════════════════════════════════════════
     3. BOOKING SYNC — car & BnB bookings → Firestore bookings
  ═══════════════════════════════════════════════════════════════ */

  /* Car hub: confirmBooking */
  function _patchCarBooking() {
    if (!window.confirmBooking || window.confirmBooking.__pw) return;
    const orig = window.confirmBooking;
    window.confirmBooking = function(...a) {
      orig.apply(this, a);
      setTimeout(() => {
        try {
          const bookings = JSON.parse(localStorage.getItem('sokoniCarBookings') || '[]');
          const latest   = bookings[0];
          if (latest) {
            _fsSet('bookings', latest.id, {
              ...latest,
              uid    : _uid || latest.uid || '',
              userId : _uid || '',
              hub    : 'car',
              type   : 'car_rental',
            });
          }
        } catch(e) {}
      }, 600);
    };
    window.confirmBooking.__pw = true;
  }

  /* BnB: confirmBooking (bnb.html may use same name — only patch if car version not already patched) */
  function _patchBnBBooking() {
    ['confirmBnBBooking', 'bookBnB', 'submitBnBBooking'].forEach(fn => {
      if (!window[fn] || window[fn].__pw) return;
      const orig = window[fn];
      window[fn] = function(...a) {
        orig.apply(this, a);
        setTimeout(() => {
          try {
            const bkgs  = JSON.parse(localStorage.getItem('sokoniBnBBookings') || '[]');
            const latest = bkgs[0];
            if (latest) {
              _fsSet('bookings', latest.id || ('bnb_' + Date.now()), {
                ...latest,
                uid : _uid || '',
                hub : 'bnb',
                type: 'bnb',
              });
            }
          } catch(e) {}
        }, 600);
      };
      window[fn].__pw = true;
    });
  }

  /* Watch sokoniBnBBookings & sokoniCarBookings localStorage writes */
  (function _watchBookingKeys() {
    const BK_KEYS = {
      'sokoniBnBBookings'  : 'bnb',
      'sokoniCarBookings'  : 'car',
    };

    const prevSet = localStorage.setItem;
    localStorage.setItem = function(key, value) {
      prevSet.call(this, key, value);
      const hub = BK_KEYS[key];
      if (!hub) return;
      setTimeout(() => {
        try {
          const arr  = JSON.parse(value || '[]');
          const list = Array.isArray(arr) ? arr : [arr];
          const latest = list[0];
          if (latest && latest.id) {
            _fsSet('bookings', latest.id, {
              ...latest,
              uid : _uid || latest.uid || '',
              hub,
              _autoSynced: true,
            });
          }
        } catch(e) {}
      }, 800);
    };
  }());

  /* ═══════════════════════════════════════════════════════════════
     4. DISCOVERY PULL — pull Firestore providers into hub pages
  ═══════════════════════════════════════════════════════════════ */

  const HUB_DISCOVER_MAP = {
    'services'         : { ls: 'sokoniServiceProviders', fn: ['renderProviders','displayProviders'] },
    'healthcare'       : { ls: 'sokoniHcFacPending',     fn: ['renderFacilities','renderHealthcare'] },
    'legal-hub'        : { ls: 'sokoni_firm_registrations', fn: ['renderLawyers'] },
    'fitness-hub'      : { ls: 'sokoniGyms',             fn: ['renderGyms','renderFitness'] },
    'mechanics'        : { ls: 'sokoniMechanics',        fn: ['renderMechanics'] },
  };

  async function _pullProvidersForHub(hub) {
    const cfg = HUB_DISCOVER_MAP[hub];
    if (!cfg) return;

    const fsProviders = await _fsGetAll('providers');
    const hubProviders = fsProviders.filter(p => p.hub === hub || p.type === hub);
    if (!hubProviders.length) return;

    /* Merge into localStorage so existing render functions pick them up */
    try {
      const local = JSON.parse(localStorage.getItem(cfg.ls) || '[]');
      const localIds = new Set(local.map(p => String(p.id || p.name || '')));
      const toAdd = hubProviders.filter(p => !localIds.has(String(p.id || p.name || '')));
      if (toAdd.length) {
        const merged = [...local, ...toAdd];
        localStorage.setItem(cfg.ls, JSON.stringify(merged));
      }
    } catch(e) {}

    /* Call render functions if they exist */
    cfg.fn.forEach(fnName => {
      if (typeof window[fnName] === 'function') {
        try { window[fnName](); } catch(e) {}
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     AUTH WIRING
  ═══════════════════════════════════════════════════════════════ */

  const _prevOnSokoniAuth = window.onSokoniAuth;
  window.onSokoniAuth = function(uid) {
    _uid = uid || null;
    _db  = window.firebaseDB || null;
    if (typeof _prevOnSokoniAuth === 'function') _prevOnSokoniAuth(uid);
  };

  document.addEventListener('sokoniAuthReady', function(e) {
    if (e && e.detail && e.detail.uid) {
      _uid = e.detail.uid;
      _db  = window.firebaseDB || null;
    }
  });

  /* Piggyback on SokoniSync init to get db */
  window.addEventListener('sokoniSyncLoaded', function() {
    if (window.SokoniSync && !window.SokoniSync.init.__pwHooked) {
      const origInit = window.SokoniSync.init;
      window.SokoniSync.init = function(db, uid) {
        _db  = db;
        _uid = uid;
        origInit.call(this, db, uid);
      };
      window.SokoniSync.init.__pwHooked = true;
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════════ */

  function _init() {
    _db  = window.firebaseDB || null;
    const user = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
    if (user && user.uid) _uid = user.uid;

    /* Detect current hub and pull providers */
    const path = location.pathname.replace(/^\//, '').replace(/\.html$/, '').toLowerCase();
    Object.keys(HUB_DISCOVER_MAP).forEach(hub => {
      if (path.includes(hub)) {
        setTimeout(() => _pullProvidersForHub(hub), 1200);
      }
    });

    /* Apply function patches (delayed so hub scripts load first) */
    setTimeout(() => {
      _patchHealthcare();
      _patchServicesProvider();
      _patchLegal();
      _patchBnBHost();
      _patchMechanics();
      _patchCarBooking();
      _patchBnBBooking();
    }, 800);

    setTimeout(() => {
      _patchHealthcare();
      _patchServicesProvider();
      _patchLegal();
      _patchBnBHost();
      _patchMechanics();
      _patchCarBooking();
      _patchBnBBooking();
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* ── Public API ── */
  window.ProviderWiring = {
    mergeCarts       : _mergeCarts,
    writeProvider    : _writeProvider,
    pullProviders    : _pullProvidersForHub,
  };

}());
