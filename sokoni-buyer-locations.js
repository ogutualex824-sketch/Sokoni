/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — BUYER SAVED LOCATIONS
   ══════════════════════════════════════════════════════════════════════════════
   The buyer's own address book: Home, Work, anywhere else they deliver to.

   ── WHAT THIS PHASE DELIBERATELY DOES NOT DO ────────────────────────────────
   It does NOT write a destination into any order. The canonical order-destination
   contract is frozen for design but its migration is unproven (nine orders, one
   seller — see docs/CANONICAL_ORDER_DESTINATION.md), so writing an order field now
   would add a twelfth spelling to the eleven already measured. This module saves
   places and nothing else.

   It also does not copy a place into any shop or seller document. A seller receives
   a destination only through an ORDER that authorises them to see it.

   ── THE SNAPSHOT RULE ───────────────────────────────────────────────────────
   When an order eventually selects a place, it must take an IMMUTABLE COPY. A
   saved place is mutable by its owner, and a past order must keep the address the
   buyer chose at the time — editing "Home" next year cannot be allowed to rewrite
   where last year's parcel went. `snapshot()` below produces that frozen copy and
   stamps which place it came from, without linking the two by reference.

   ── STORAGE ─────────────────────────────────────────────────────────────────
   userLocations/{uid}/places/{placeId}   — owned by the buyer alone, enforced in
   firestore.rules. NOT `deliveryLocations`, which is a rider's live GPS.

   Field shape follows the frozen canonical model so the two cannot drift.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var COL = 'userLocations';
  var SUB = 'places';

  /* The canonical field set, frozen in docs/CANONICAL_ORDER_DESTINATION.md. Kept in
     one place so a form, a snapshot and a test cannot disagree about what a place is. */
  var FIELDS = ['label', 'recipientName', 'phone', 'building', 'unit', 'street',
                'area', 'town', 'instructions', 'formatted', 'lat', 'lng', 'placeId'];
  var LABELS = ['Home', 'Work', 'Shop', 'Other'];

  function _sdk () {
    if (!global.firebaseApp) throw new Error('SOKONI is still starting up.');
    return Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
    ]).then(function (m) { return { fs: m[0], db: m[0].getFirestore(m[1].getApp()) }; });
  }
  function _uid () {
    var a = global.firebaseAuth;
    return (a && a.currentUser && a.currentUser.uid) || null;
  }

  var _s = function (v, n) { return String(v == null ? '' : v).slice(0, n || 120).trim(); };

  /* A human-readable single line, built from the parts the buyer actually filled in.
     Never invents a component, and never returns a stray comma for an empty field. */
  function formatted (p) {
    return [p.building, p.unit, p.street, p.area, p.town]
      .map(function (x) { return _s(x); })
      .filter(Boolean).join(' · ');
  }

  /* Normalise before write. Unknown keys are dropped rather than stored — a place is
     the canonical shape, not whatever a caller happened to pass. */
  function normalise (input) {
    var p = {};
    FIELDS.forEach(function (k) {
      if (k === 'lat' || k === 'lng') {
        var n = Number(input[k]);
        if (input[k] !== undefined && input[k] !== null && input[k] !== '' && isFinite(n)) p[k] = n;
      } else if (input[k] !== undefined) {
        var v = _s(input[k], k === 'instructions' ? 300 : 120);
        if (v) p[k] = v;
      }
    });
    if (!p.label) p.label = 'Other';
    /* A pin is a PAIR. One coordinate alone is not a location, and storing half of
       one would put a point on the equator or the prime meridian. */
    if ((p.lat === undefined) !== (p.lng === undefined)) { delete p.lat; delete p.lng; }
    p.formatted = formatted(p);
    return p;
  }

  /* Enough to deliver to: either a written address, or a pin. Coordinates alone are
     valid — a buyer who drops a pin has told us where, even without a street name. */
  function isDeliverable (p) {
    return !!(p && (_s(p.building) || _s(p.street) || _s(p.area) || _s(p.town) ||
                    (typeof p.lat === 'number' && typeof p.lng === 'number')));
  }

  /* THE SNAPSHOT. An immutable copy for an order, stamped with its source so it can
     be reconciled later — but NOT a reference, because a reference would follow the
     buyer's future edits back into a completed order. */
  function snapshot (place, at) {
    var out = {};
    FIELDS.forEach(function (k) { if (place[k] !== undefined) out[k] = place[k]; });
    out.savedPlaceId = place.id || null;
    out.capturedAt = at || null;   /* the CALLER supplies a server timestamp */
    return out;
  }

  function _col (m, uid) { return m.fs.collection(m.db, COL, uid, SUB); }

  async function list () {
    var uid = _uid(); if (!uid) return [];
    var m = await _sdk();
    var snap = await m.fs.getDocs(_col(m, uid));
    var rows = [];
    snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
    /* Default first, then most recently updated. */
    rows.sort(function (a, b) {
      if (!!b.isDefault - !!a.isDefault) return !!b.isDefault - !!a.isDefault;
      return (b.updatedAt && b.updatedAt.seconds || 0) - (a.updatedAt && a.updatedAt.seconds || 0);
    });
    return rows;
  }

  async function save (input) {
    var uid = _uid(); if (!uid) throw new Error('Sign in to save a delivery location.');
    var p = normalise(input || {});
    if (!isDeliverable(p)) throw new Error('Add an address or drop a pin so we know where to deliver.');
    var m = await _sdk();
    p.updatedAt = m.fs.serverTimestamp();
    if (input.id) {
      await m.fs.updateDoc(m.fs.doc(m.db, COL, uid, SUB, String(input.id)), p);
      return String(input.id);
    }
    p.createdAt = m.fs.serverTimestamp();
    var ref = await m.fs.addDoc(_col(m, uid), p);
    return ref.id;
  }

  async function remove (id) {
    var uid = _uid(); if (!uid || !id) return false;
    var m = await _sdk();
    await m.fs.deleteDoc(m.fs.doc(m.db, COL, uid, SUB, String(id)));
    return true;
  }

  /* Exactly one default. Cleared on every other place in the same batch, so two
     places can never both claim it. */
  async function setDefault (id) {
    var uid = _uid(); if (!uid || !id) return false;
    var m = await _sdk();
    var snap = await m.fs.getDocs(_col(m, uid));
    var batch = m.fs.writeBatch(m.db);
    snap.forEach(function (d) {
      batch.update(m.fs.doc(m.db, COL, uid, SUB, d.id), { isDefault: d.id === String(id) });
    });
    await batch.commit();
    return true;
  }

  /* Browser geolocation. Refusal is a NORMAL answer, not an error state: the buyer
     must still be able to type a building and house number. The caller receives null
     and keeps its form exactly as it was. */
  function currentPin (timeoutMs) {
    return new Promise(function (resolve) {
      if (!global.navigator || !global.navigator.geolocation) return resolve(null);
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs || 10000);
      global.navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (done) return; done = true; clearTimeout(t);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        function () { if (done) return; done = true; clearTimeout(t); resolve(null); },
        { enableHighAccuracy: true, timeout: timeoutMs || 10000, maximumAge: 60000 }
      );
    });
  }

  global.SokoniBuyerLocations = {
    FIELDS: FIELDS, LABELS: LABELS,
    normalise: normalise, formatted: formatted, isDeliverable: isDeliverable,
    snapshot: snapshot, currentPin: currentPin,
    list: list, save: save, remove: remove, setDefault: setDefault,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniBuyerLocations;
}
