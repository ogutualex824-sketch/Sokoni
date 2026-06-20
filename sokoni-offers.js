/* ============================================================
   sokoni-offers.js — Product Offers / Promotions Engine
   Exposes: window.SokoniOffers
   Admin: create / update / delete / toggle offers
   Public: getActiveOffer(productId), listenActive(cb)
============================================================ */
(function (window) {
  'use strict';

  var firestoreImport = (function () {
    var _mod = null;
    return async function () {
      if (!_mod) _mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      return _mod;
    };
  })();

  function getDB() { return window.firebaseDB || null; }
  function getUID() {
    var a = window.firebaseAuth;
    return (a && a.currentUser) ? a.currentUser.uid : null;
  }
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isNowActive(offer) {
    if (!offer.active) return false;
    var now = Date.now();
    if (offer.startDate && new Date(offer.startDate).getTime() > now) return false;
    if (offer.endDate   && new Date(offer.endDate).getTime()   < now) return false;
    return true;
  }

  var SokoniOffers = {

    /* ── PUBLIC ── */

    getActiveOffer: async function (productId) {
      try {
        var db = getDB(); if (!db) return null;
        var fs = await firestoreImport();
        var q  = fs.query(
          fs.collection(db, 'offers'),
          fs.where('productId', '==', String(productId)),
          fs.where('active', '==', true)
        );
        var snap = await fs.getDocs(q);
        var now  = Date.now();
        var hit  = null;
        snap.forEach(function (d) {
          var o = Object.assign({ id: d.id }, d.data());
          if (isNowActive(o)) hit = o;
        });
        return hit;
      } catch (e) { console.warn('[SokoniOffers.getActiveOffer]', e); return null; }
    },

    /* Returns Map{ productId → offer } for all currently-active offers */
    listenActive: async function (callback) {
      try {
        var db = getDB(); if (!db) { callback(new Map()); return function () {}; }
        var fs = await firestoreImport();
        var q  = fs.query(fs.collection(db, 'offers'), fs.where('active', '==', true));
        return fs.onSnapshot(q, function (snap) {
          var map = new Map();
          snap.forEach(function (d) {
            var o = Object.assign({ id: d.id }, d.data());
            if (isNowActive(o)) map.set(o.productId, o);
          });
          callback(map);
        });
      } catch (e) { console.warn('[SokoniOffers.listenActive]', e); callback(new Map()); return function () {}; }
    },

    /* Inject offer badge into a price element. el = container, offer = offer doc */
    applyBadge: function (container, offer) {
      var orig    = Number(offer.originalPrice) || 0;
      var price   = Number(offer.offerPrice)    || 0;
      var badge   = esc(offer.badgeText  || (offer.discountPercent ? offer.discountPercent + '% OFF' : 'OFFER'));
      var label   = esc(offer.label      || 'Special Offer');
      container.innerHTML =
        '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
          '<span style="font-size:11px;font-weight:900;background:#ff4444;color:white;padding:2px 7px;border-radius:6px;">' + badge + '</span>' +
          '<span style="text-decoration:line-through;color:rgba(255,255,255,0.35);font-size:13px;">KES ' + orig.toLocaleString() + '</span>' +
          '<span style="color:#71ff00;font-weight:900;">KES ' + price.toLocaleString() + '</span>' +
        '</span>' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px;">' + label + '</div>';
    },

    /* ── ADMIN ── */

    getAll: async function () {
      try {
        var db = getDB(); if (!db) return [];
        var fs = await firestoreImport();
        var q  = fs.query(fs.collection(db, 'offers'), fs.orderBy('createdAt', 'desc'));
        var snap = await fs.getDocs(q);
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return out;
      } catch (e) { console.warn('[SokoniOffers.getAll]', e); return []; }
    },

    create: async function (data) {
      var uid = getUID();
      if (!uid) { (window._skToast||alert)('Admin sign-in required.'); return null; }
      if (!data.productId || !data.offerPrice || !data.originalPrice) {
        (window._skToast||alert)('Product ID, original price and offer price are required.'); return null;
      }
      var discount = Math.round((1 - data.offerPrice / data.originalPrice) * 100);
      try {
        var db = getDB(); if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var doc = {
          productId:       String(data.productId).slice(0, 128),
          productName:     String(data.productName || '').slice(0, 100),
          sellerName:      String(data.sellerName  || '').slice(0, 100),
          originalPrice:   Number(data.originalPrice),
          offerPrice:      Number(data.offerPrice),
          discountPercent: discount,
          badgeText:       String(data.badgeText || (discount + '% OFF')).slice(0, 30),
          label:           String(data.label     || 'Special Offer').slice(0, 60),
          startDate:       data.startDate || new Date().toISOString(),
          endDate:         data.endDate   || '',
          active:          data.active !== false,
          createdBy:       uid,
          createdAt:       new Date().toISOString(),
          updatedAt:       new Date().toISOString()
        };
        var ref = await fs.addDoc(fs.collection(db, 'offers'), doc);
        return ref.id;
      } catch (e) { console.error('[SokoniOffers.create]', e); (window._skToast||alert)('Failed to create offer.'); return null; }
    },

    update: async function (offerId, data) {
      var uid = getUID();
      if (!uid) { (window._skToast||alert)('Admin sign-in required.'); return; }
      try {
        var db = getDB(); if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var patch = { updatedAt: new Date().toISOString() };
        if (data.productName   != null) patch.productName   = String(data.productName).slice(0, 100);
        if (data.originalPrice != null) patch.originalPrice = Number(data.originalPrice);
        if (data.offerPrice    != null) patch.offerPrice    = Number(data.offerPrice);
        if (data.badgeText     != null) patch.badgeText     = String(data.badgeText).slice(0, 30);
        if (data.label         != null) patch.label         = String(data.label).slice(0, 60);
        if (data.startDate     != null) patch.startDate     = data.startDate;
        if (data.endDate       != null) patch.endDate       = data.endDate;
        if (data.active        != null) patch.active        = Boolean(data.active);
        if (patch.originalPrice && patch.offerPrice) {
          patch.discountPercent = Math.round((1 - patch.offerPrice / patch.originalPrice) * 100);
        }
        await fs.updateDoc(fs.doc(db, 'offers', offerId), patch);
      } catch (e) { console.error('[SokoniOffers.update]', e); (window._skToast||alert)('Failed to update offer.'); }
    },

    toggle: async function (offerId, active) {
      var uid = getUID();
      if (!uid) { (window._skToast||alert)('Admin sign-in required.'); return; }
      try {
        var db = getDB(); if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        await fs.updateDoc(fs.doc(db, 'offers', offerId), { active: Boolean(active), updatedAt: new Date().toISOString() });
      } catch (e) { console.error('[SokoniOffers.toggle]', e); }
    },

    delete: async function (offerId) {
      var uid = getUID();
      if (!uid) { (window._skToast||alert)('Admin sign-in required.'); return; }
      if(!_c){_skConfirm('Delete this offer permanently?',()=>SokoniOffers.delete(id,true));return;}
      try {
        var db = getDB(); if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        await fs.deleteDoc(fs.doc(db, 'offers', offerId));
      } catch (e) { console.error('[SokoniOffers.delete]', e); (window._skToast||alert)('Failed to delete offer.'); }
    }

  };

  window.SokoniOffers = SokoniOffers;

})(window);


