/* ================================================================
   SOKONI Verifications  —  sokoni-verifications.js  v1.0

   Provides verified badges for sellers, businesses, professionals,
   drivers, doctors, lawyers, and property agents.

   USAGE:
     // Check one uid and get result
     SokoniVerifications.check('uid123').then(v => console.log(v));

     // Inject badge HTML next to an element
     SokoniVerifications.badge('uid123', document.getElementById('sellerName'));

     // Render a badge string (for innerHTML templates)
     SokoniVerifications.html('uid123').then(html => el.innerHTML += html);

   BADGE LEVELS (stored in Firestore verifications/{uid}):
     status: 'pending' | 'approved' | 'rejected'
     type:   'seller' | 'business' | 'professional' | 'driver'
             | 'doctor' | 'lawyer' | 'property_agent' | 'premium'

   Firestore collection: verifications/{uid}
   Required fields: status, type, verifiedAt (timestamp)
================================================================ */

'use strict';

const SokoniVerifications = (function () {

  const FB_CFG = {
    apiKey: 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE',
    authDomain: 'sokoni-aeb26.firebaseapp.com',
    projectId: 'sokoni-aeb26',
    storageBucket: 'sokoni-aeb26.firebasestorage.app',
    messagingSenderId: '24799054989',
    appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",measurementId:"G-QT32H65TJS",
  };

  /* In-memory + sessionStorage cache — TTL 10 minutes */
  const _mem = new Map();
  const CACHE_KEY = 'skVerif_';
  const TTL = 10 * 60 * 1000;

  const TYPE_CFG = {
    seller:         { label: 'Verified Seller',     icon: '✅', color: '#71ff00', bg: 'rgba(113,255,0,0.1)',  border: 'rgba(113,255,0,0.25)' },
    business:       { label: 'Verified Business',   icon: '🏢', color: '#00d4ff', bg: 'rgba(0,212,255,0.1)',  border: 'rgba(0,212,255,0.25)' },
    professional:   { label: 'Professional',        icon: '🎓', color: '#a855f7', bg: 'rgba(168,85,247,0.1)', border: 'rgba(168,85,247,0.25)' },
    driver:         { label: 'Verified Driver',     icon: '🛵', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.25)' },
    doctor:         { label: 'Licensed Doctor',     icon: '🩺', color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.25)' },
    lawyer:         { label: 'Licensed Lawyer',     icon: '⚖️', color: '#818cf8', bg: 'rgba(129,140,248,0.1)',border: 'rgba(129,140,248,0.25)' },
    property_agent: { label: 'Licensed Agent',      icon: '🏠', color: '#fb923c', bg: 'rgba(251,146,60,0.1)', border: 'rgba(251,146,60,0.25)' },
    premium:        { label: 'Premium Member',      icon: '👑', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.25)' },
  };

  /* ── Firestore lazy-loader ── */
  let _db = null;
  async function _getDB() {
    if (_db) return _db;
    const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const app = getApps().length ? getApps()[0] : initializeApp(FB_CFG);
    _db = getFirestore(app);
    return _db;
  }

  /* ── Cache helpers ── */
  function _cacheGet(uid) {
    if (_mem.has(uid)) {
      const e = _mem.get(uid);
      if (Date.now() < e.exp) return e.val;
      _mem.delete(uid);
    }
    try {
      const raw = sessionStorage.getItem(CACHE_KEY + uid);
      if (raw) {
        const e = JSON.parse(raw);
        if (Date.now() < e.exp) { _mem.set(uid, e); return e.val; }
        sessionStorage.removeItem(CACHE_KEY + uid);
      }
    } catch (err) {}
    return null;
  }

  function _cacheSet(uid, val) {
    const entry = { val, exp: Date.now() + TTL };
    _mem.set(uid, entry);
    try { sessionStorage.setItem(CACHE_KEY + uid, JSON.stringify(entry)); } catch (err) {}
  }

  /* ── Core check ── */
  async function check(uid) {
    if (!uid) return null;

    const cached = _cacheGet(uid);
    if (cached !== null) return cached;

    try {
      const [{ doc, getDoc }, db] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
        _getDB(),
      ]);
      const snap = await getDoc(doc(db, 'verifications', uid));
      if (!snap.exists()) { _cacheSet(uid, null); return null; }
      const data = snap.data();
      if (data.status !== 'approved') { _cacheSet(uid, null); return null; }
      const result = {
        uid,
        type:       data.type || 'seller',
        status:     data.status,
        verifiedAt: data.verifiedAt?.toDate?.() || null,
        level:      data.level || 'standard',
      };
      _cacheSet(uid, result);
      return result;
    } catch (err) {
      return null;
    }
  }

  /* ── Badge HTML string ── */
  async function html(uid, opts) {
    const v = await check(uid);
    if (!v) return '';
    return _badgeHTML(v, opts);
  }

  function _badgeHTML(v, opts) {
    opts = opts || {};
    const cfg = TYPE_CFG[v.type] || TYPE_CFG.seller;
    const size = opts.size || 'sm'; /* sm | md | lg */
    const sizes = {
      sm: { font: '9px',  pad: '2px 7px',  gap: '4px', iconSize: '10px' },
      md: { font: '11px', pad: '4px 10px', gap: '5px', iconSize: '12px' },
      lg: { font: '13px', pad: '6px 14px', gap: '6px', iconSize: '14px' },
    };
    const s = sizes[size] || sizes.sm;
    return (
      '<span class="sk-verified-badge" title="' + cfg.label + '" style="' +
        'display:inline-flex;align-items:center;gap:' + s.gap + ';' +
        'padding:' + s.pad + ';' +
        'background:' + cfg.bg + ';' +
        'border:1px solid ' + cfg.border + ';' +
        'border-radius:999px;' +
        'font-size:' + s.font + ';font-weight:800;' +
        'color:' + cfg.color + ';' +
        'white-space:nowrap;vertical-align:middle;' +
        'font-family:\'Segoe UI\',system-ui,sans-serif;line-height:1.2;">' +
        '<span style="font-size:' + s.iconSize + ';">' + cfg.icon + '</span>' +
        '<span>' + cfg.label + '</span>' +
      '</span>'
    );
  }

  /* ── Inject badge next to a DOM element ── */
  async function badge(uid, targetEl, opts) {
    if (!targetEl) return;
    const v = await check(uid);
    if (!v) return;
    /* Remove any existing badge to avoid duplicates */
    const existing = targetEl.parentNode
      ? targetEl.parentNode.querySelector('.sk-verified-badge[data-uid="' + uid + '"]')
      : null;
    if (existing) return;

    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-uid', uid);
    wrapper.innerHTML = _badgeHTML(v, opts);
    const badgeEl = wrapper.firstChild;
    badgeEl.setAttribute('data-uid', uid);

    /* Insert after the target element */
    if (targetEl.nextSibling) {
      targetEl.parentNode.insertBefore(badgeEl, targetEl.nextSibling);
    } else {
      targetEl.parentNode.appendChild(badgeEl);
    }
  }

  /* ── Batch check multiple uids at once ── */
  async function checkBatch(uids) {
    if (!uids || !uids.length) return {};
    const results = {};
    await Promise.all(uids.map(async function(uid) {
      results[uid] = await check(uid);
    }));
    return results;
  }

  /* ── Wire all [data-verif-uid] elements on the page ── */
  async function wireAll(opts) {
    const els = document.querySelectorAll('[data-verif-uid]');
    if (!els.length) return;
    for (const el of els) {
      const uid = el.getAttribute('data-verif-uid');
      if (!uid) continue;
      await badge(uid, el, opts);
    }
  }

  /* ── Admin: submit a verification request ── */
  async function submitRequest(uid, type, docs) {
    if (!uid || !type) throw new Error('uid and type are required');
    const [{ doc, setDoc, serverTimestamp }, db] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
      _getDB(),
    ]);
    await setDoc(doc(db, 'verifications', uid), {
      uid,
      type,
      status: 'pending',
      submittedAt: serverTimestamp(),
      docs: docs || [],
    }, { merge: true });
  }

  /* ── Public API ── */
  return Object.freeze({
    check,
    html,
    badge,
    checkBatch,
    wireAll,
    submitRequest,
    TYPE_CFG,
  });

})();

window.SokoniVerifications = SokoniVerifications;
