/* ================================================================
   sokoni-loyalty.js — Portable Loyalty Points Engine  v1.0
   Safe to include on ANY page. Skips setup if loyalty.html
   already defined the functions (avoids duplicate definitions).
   Usage: <script defer src="sokoni-loyalty.js"></script>
================================================================ */
(function () {
  'use strict';

  /* Already loaded by loyalty.html inline script — nothing to do */
  if (typeof window.onSokoniPurchase === 'function') return;

  /* ── Storage ── */
  function _load() {
    try { return JSON.parse(localStorage.getItem('sokoniLoyaltyPoints')) || { total: 0, history: [] }; }
    catch(e) { return { total: 0, history: [] }; }
  }
  function _save(d) {
    try {
      localStorage.setItem('sokoniLoyaltyPoints', JSON.stringify(d));
      /* Keep legacy key in sync for profile.html display */
      localStorage.setItem('sokoniPoints', String(d.total || 0));
    } catch(e) {}
  }
  function _loadOT() {
    try { return JSON.parse(localStorage.getItem('sokoniOneTime')) || {}; } catch(e) { return {}; }
  }
  function _saveOT(o) { try { localStorage.setItem('sokoniOneTime', JSON.stringify(o)); } catch(e) {} }

  /* ── Tier table (matches loyalty.html) ── */
  var TIERS = [
    { name:'Bronze',   min:0,     max:999,   col:'#cd7f32' },
    { name:'Silver',   min:1000,  max:4999,  col:'#c0c0c0' },
    { name:'Gold',     min:5000,  max:19999, col:'#ffd700' },
    { name:'Platinum', min:20000, max:Infinity, col:'#e5e4e2' },
  ];
  function _getTier(pts) {
    return TIERS.find(function(t){ return pts >= t.min && pts <= t.max; }) || TIERS[0];
  }

  /* ── Core add-points ── */
  function _addRaw(pts, reason) {
    var d = _load();
    var prevTier = _getTier(d.total || 0).name;
    d.total = (d.total || 0) + pts;
    if (!Array.isArray(d.history)) d.history = [];
    d.history.unshift({
      points: pts,
      description: String(reason || 'Points earned').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
      date: new Date().toLocaleDateString('en-KE', { day:'numeric', month:'short', year:'numeric' }),
      orderId: 'AUTO'
    });
    if (d.history.length > 100) d.history = d.history.slice(0, 100);
    _save(d);
    /* Tier-up notification */
    var newTier = _getTier(d.total).name;
    if (newTier !== prevTier) _notifyTierUp(newTier);
    return d;
  }

  function _notifyTierUp(tierName) {
    var msg = 'You reached ' + tierName + ' tier on SOKONI Loyalty!';
    /* Toast */
    try {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#71ff00;color:#000;font-weight:900;font-size:13px;padding:12px 22px;border-radius:50px;box-shadow:0 4px 20px rgba(113,255,0,0.4);white-space:nowrap;pointer-events:none;';
      t.textContent = '🎉 ' + msg;
      document.body.appendChild(t);
      setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 4000);
    } catch(e){}
    /* Browser notification */
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('SOKONI Loyalty', { body: msg, icon: '/assets/logosokoni.png' });
      }
    } catch(e){}
  }

  /* ── Daily cap: max 500 auto-awarded pts per calendar day (prevents console abuse) ── */
  var _TODAY = new Date().toISOString().slice(0,10);
  function _dailyAwarded() {
    try { var s=JSON.parse(localStorage.getItem('_loyaltyDaily')||'{}'); return s.date===_TODAY ? (s.pts||0) : 0; } catch(e){ return 0; }
  }
  function _addDailyAwarded(pts) {
    try { var cur=_dailyAwarded(); localStorage.setItem('_loyaltyDaily',JSON.stringify({date:_TODAY,pts:cur+pts})); } catch(e){}
  }
  var DAILY_CAP = 500;

  /* ── Public API ── */
  window.sokoniAddPoints = function (pts, reason) {
    if (typeof pts !== 'number' || pts <= 0) return;
    var awarded = _dailyAwarded();
    if (awarded >= DAILY_CAP) return; /* silently cap */
    var allowed = Math.min(Math.round(pts), DAILY_CAP - awarded);
    _addRaw(allowed, reason || 'Points earned');
    _addDailyAwarded(allowed);
  };

  window.onSokoniPurchase = function (amount) {
    if (typeof amount !== 'number' || amount <= 0) return;
    var pts = Math.max(1, Math.floor(amount / 10));
    _addRaw(pts, 'Purchase — KES ' + Number(amount).toLocaleString('en-KE'));
    /* First purchase one-time bonus */
    var ot = _loadOT();
    if (!ot.firstPurchase) {
      ot.firstPurchase = true;
      _saveOT(ot);
      _addRaw(100, 'First purchase bonus');
    }
  };

  window.onSokoniFirstPurchase = function () {
    var code = '';
    try { code = localStorage.getItem('sokoniReferredBy') || ''; } catch(e){}
    if (!code) return;
    var ot = _loadOT();
    if (ot.referralCredited) return;
    ot.referralCredited = true;
    _saveOT(ot);
    /* Award 50pts welcome bonus to THIS user (the new buyer) */
    _addRaw(50, 'Referral welcome bonus');
    /* Queue 100pt credit for the REFERRER via Firestore (v9 API) — cross-device */
    try {
      if (window.firebaseDB) {
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
          .then(function(fs) {
            return fs.addDoc(fs.collection(window.firebaseDB, 'referralCompletions'), {
              referrerCode: code,
              completedAt: Date.now(),
              ptsToAward: 100,
              credited: false
            });
          })
          .catch(function(){});
      }
    } catch(e){}
    /* Also record locally for referral.html dashboard display */
    try {
      var refs = JSON.parse(localStorage.getItem('sokoniReferrals') || '[]');
      refs.push({ code: code, status: 'completed', ts: Date.now(), pointsAwarded: 50 });
      localStorage.setItem('sokoniReferrals', JSON.stringify(refs));
    } catch(e){}
    /* Clear so no double-credit on next purchase */
    try { localStorage.removeItem('sokoniReferredBy'); } catch(e){}
  };

  window.onSokoniReview = function () {
    _addRaw(20, 'Review submitted');
  };

  window.onSokoniReferral = function () {
    _addRaw(100, 'Referral bonus');
  };

  window.onSokoniProfileComplete = function () {
    var ot = _loadOT();
    if (ot.profileComplete) return;
    ot.profileComplete = true;
    _saveOT(ot);
    _addRaw(50, 'Profile complete bonus');
  };

})();
