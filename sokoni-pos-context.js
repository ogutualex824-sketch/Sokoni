/* ════════════════════════════════════════════════════════════════════════════
   SOKONI — POS context resolver
   ════════════════════════════════════════════════════════════════════════════
   Answers, for an authenticated user, the only question /pos actually needs:

       who is this, which businesses may they operate,
       which branches, and is THIS device already paired?

   WHY IT EXISTS
   /pos decided "setup or POS" from localStorage flags, so a merchant on a new
   phone was pushed back through business registration. Device storage answers
   "new browser", never "new business". This resolves the question from the
   server instead, and device storage becomes a CACHE of the answer.

   ── THE SECURITY BOUNDARY ───────────────────────────────────────────────────
   A device must never be able to manufacture business identity. The client may
   REQUEST a business or branch — it may not ASSERT one.

     · `merchantId`, `role`, `branchId` and capabilities are never read from
       localStorage, a query string, or any client input as AUTHORITY.
     · Ownership is proved by `businesses/{id}.ownerId === auth.uid`, the same
       corroboration firestore.rules performs, so a forged request fails in the
       app AND at the rules layer rather than relying on either alone.
     · `users/{uid}.merchantId` is a KNOWN self-writable field and is never
       consulted. That is a recorded open defect, not a shortcut to reuse.

   ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
   It resolves EMPLOYEE relationships only as far as the schema currently
   allows. `shopEmployees` is keyed by uid alone, so one person can hold exactly
   one employment; genuine multi-shop employment needs the relationship re-key
   and is deliberately left to that slice rather than half-built here.

   It performs no writes. Pairing a device is a separate, explicit action.
   ════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DEVICE_KEY = 'sk_device_id';

  function _s(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 128); }

  /* The stable per-device id firebase.js already maintains. Deliberately NOT
     regenerated here: a new id would look like a new device on every call and
     re-pair endlessly. If it is absent the caller is told, rather than one
     being invented. */
  function deviceId() {
    try { return localStorage.getItem(DEVICE_KEY) || null; } catch (e) { return null; }
  }

  /* ── businesses this user OWNS ──────────────────────────────────────────
     Proved by ownerId, never by anything the device stored. */
  function ownedBusinesses(db, uid) {
    return db.collection('businesses').where('ownerId', '==', uid).get()
      .then(function (snap) {
        return snap.docs.map(function (d) {
          var v = d.data() || {};
          return {
            id: d.id,
            name: _s(v.name || v.businessName || v.shopName) || d.id,
            ownerId: _s(v.ownerId),
            status: _s(v.status, 32) || null,
            source: 'owner'
          };
        });
      })
      .catch(function () { return []; });
  }

  /* ── branches under a business ──────────────────────────────────────────
     Read is permitted only because the caller owns the business; a caller who
     does not will be refused by rules, and the empty result is honest. */
  function branchesOf(db, merchantId) {
    return db.collection('branches').where('merchantId', '==', merchantId).get()
      .then(function (snap) {
        return snap.docs.map(function (d) {
          var v = d.data() || {};
          return {
            id: d.id,
            merchantId: _s(v.merchantId),
            name: _s(v.name) || d.id,
            isDefault: v.isDefault === true,
            status: _s(v.status, 32) || null
          };
        }).sort(function (a, b) { return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0); });
      })
      .catch(function () { return []; });
  }

  /* ── is THIS device already paired? ─────────────────────────────────────
     Looked up by the stable device id, then CORROBORATED: the record only
     counts if its merchantId is one this user actually owns. A device document
     naming someone else's merchant grants nothing. */
  function deviceRegistration(db, authorisedMerchantIds) {
    var id = deviceId();
    if (!id) return Promise.resolve({ deviceId: null, registered: false, reason: 'no-device-id' });
    return db.collection('posDevices').doc(id).get()
      .then(function (doc) {
        if (!doc.exists) return { deviceId: id, registered: false, reason: 'not-paired' };
        var v = doc.data() || {};
        var mid = _s(v.merchantId);
        if (!mid || authorisedMerchantIds.indexOf(mid) === -1) {
          /* The record exists but names a merchant this user cannot operate.
             That is NOT a pairing, and it must not become one. */
          return { deviceId: id, registered: false, reason: 'paired-elsewhere' };
        }
        return {
          deviceId: id, registered: true, merchantId: mid,
          branchId: _s(v.branchId) || null,
          status: _s(v.status, 32) || null,
          suspended: !!v.suspendedAt,
          lastSeenAt: v.lastSeenAt || null
        };
      })
      .catch(function () {
        /* A refused read is not proof of absence. Say so, rather than treating
           it as "unpaired" and sending the merchant into setup. */
        return { deviceId: id, registered: false, reason: 'unreadable' };
      });
  }

  /* ── the whole answer ───────────────────────────────────────────────────
     Returns a decision, not a redirect. The caller decides what to render;
     this file never navigates. */
  function resolve(opts) {
    opts = opts || {};
    var db = opts.db, uid = _s(opts.uid);
    if (!db) return Promise.resolve({ ok: false, reason: 'no-db' });
    if (!uid) return Promise.resolve({ ok: false, reason: 'unauthenticated', decision: 'sign-in' });

    return ownedBusinesses(db, uid).then(function (owned) {
      var ids = owned.map(function (b) { return b.id; });

      if (!owned.length) {
        /* No owned business. This is NOT the same as "create a business": the
           user may be an employee, which the current schema cannot express for
           more than one shop. Reported honestly instead of guessed. */
        return { ok: true, uid: uid, businesses: [], branches: [], device: null,
                 decision: 'no-owned-business',
                 note: 'employee relationships are not resolved by this slice' };
      }

      return Promise.all([
        branchesOf(db, ids[0]),
        deviceRegistration(db, ids)
      ]).then(function (r) {
        var branches = r[0], device = r[1];
        var decision =
          device.registered && device.suspended ? 'device-suspended' :
          device.registered ? 'open-pos' :
          device.reason === 'unreadable' ? 'retry' :
          'pair-device';
        return {
          ok: true, uid: uid,
          businesses: owned, branches: branches, device: device,
          selected: { merchantId: ids[0], branchId: device.branchId ||
                      (branches[0] && branches[0].id) || null },
          decision: decision
        };
      });
    });
  }

  global.SokoniPosContext = {
    resolve: resolve,
    deviceId: deviceId,
    _internal: { ownedBusinesses: ownedBusinesses, branchesOf: branchesOf,
                 deviceRegistration: deviceRegistration }
  };
}(typeof window !== 'undefined' ? window : globalThis));

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniPosContext;
}
