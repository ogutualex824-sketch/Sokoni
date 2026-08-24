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
      /* A FAILED QUERY IS NOT AN EMPTY RESULT.

         This used to `.catch(() => [])`, so a permission error, an auth token
         that had not attached yet, or a dropped request all became "this user
         owns no businesses" — and the till told a merchant with 103 products
         and 7 paired devices that they do not have a shop. The diagnostic
         path happened to work only because it waits on a second module first,
         giving the token time to arrive: the same code, a few hundred
         milliseconds later, answering correctly.

         The error is now carried so resolve() can tell "we could not ask"
         apart from "we asked and the answer is none". */
      .catch(function (e) {
        var err = new Error('businesses lookup failed: ' + ((e && (e.code || e.message)) || e));
        err.__lookupFailed = true;
        err.cause = e;
        throw err;
      });
  }

  /* ── branches under a business ──────────────────────────────────────────
     The old comment here said "a caller who does not [own it] will be refused
     by rules, and the empty result is honest". That reasoning is what produced
     the defect: it is only honest when the refusal is the ANSWER. A refusal
     because the token had not attached yet, or a dropped request, produced the
     same empty list — and a business with no branches loses the selection to
     one that has them, so a transient failure could hand the till the WRONG
     business. Same failure class as ownedBusinesses(); same treatment. */
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
      .catch(function (e) {
        var err = new Error('branches lookup failed for ' + merchantId + ': ' +
                            ((e && (e.code || e.message)) || e));
        err.__lookupFailed = true;
        err.cause = e;
        throw err;
      });
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

    /* ONE RETRY, because the failure this guards against is a race and not a
       verdict. If the token was simply not attached yet, asking again a beat
       later succeeds — which is precisely what the diagnostic path was doing
       by accident. If it fails twice, the caller is told the LOOKUP failed
       rather than being handed a confident wrong answer. */
    function ownedWithRetry() {
      return ownedBusinesses(db, uid).catch(function (e1) {
        return new Promise(function (res) { setTimeout(res, 350); })
          .then(function () { return ownedBusinesses(db, uid); })
          .catch(function (e2) { throw (e2 && e2.__lookupFailed ? e2 : e1); });
      });
    }

    return ownedWithRetry().catch(function (e) {
      /* NOT 'no-owned-business'. The question was never answered. */
      return { ok: false, uid: uid, businesses: [], branches: [], device: null,
               decision: 'lookup-failed',
               reason: (e && e.message) || 'businesses lookup failed' };
    }).then(function (owned) {
      if (owned && owned.decision === 'lookup-failed') return owned;
      var ids = owned.map(function (b) { return b.id; });

      if (!owned.length) {
        /* No owned business. This is NOT the same as "create a business": the
           user may be an employee, which the current schema cannot express for
           more than one shop. Reported honestly instead of guessed. */
        return { ok: true, uid: uid, businesses: [], branches: [], device: null,
                 decision: 'no-owned-business',
                 note: 'employee relationships are not resolved by this slice' };
      }

      /* ── BRANCHES ACROSS EVERY OWNED BUSINESS, NOT JUST THE FIRST ────────
         An owner can hold more than one business document — measured in
         production: one keyed by their uid and one keyed SOK-…, both with the
         same ownerId. Asking only businesses[0] for branches reported
         "BRANCH: none" for a merchant whose branch existed under the OTHER
         document. That was a defect in this resolver, not in their data.

         All owned businesses are queried, and the SELECTED business is the one
         that actually has branches — preferring a default — because a business
         with no branch cannot be operated by a till. Falling back to the first
         id keeps the previous behaviour when nobody has branches yet. */
      /* The branch fan-out gets the SAME one retry as the business lookup, for
         the same reason: these fire microseconds apart, so whatever starved one
         of a token starved the other. Retrying only the businesses query would
         have moved the failure one step down instead of removing it. */
      function branchesForAll() {
        return Promise.all(ids.map(function (id) { return branchesOf(db, id); }));
      }
      return Promise.all([
        branchesForAll().catch(function (e1) {
          return new Promise(function (res) { setTimeout(res, 350); })
            .then(branchesForAll)
            .catch(function (e2) { throw (e2 && e2.__lookupFailed ? e2 : e1); });
        }),
        deviceRegistration(db, ids)
      ]).catch(function (e) {
        /* NOT a business without branches. The question was never answered, and
           answering it wrongly here picks the wrong shop for a real till. */
        return { __lookupFailed: true, reason: (e && e.message) || 'branches lookup failed' };
      }).then(function (r) {
        if (r && r.__lookupFailed) {
          return { ok: false, uid: uid, businesses: owned, branches: [], device: null,
                   decision: 'lookup-failed', reason: r.reason };
        }
        var perBusiness = r[0], device = r[1];
        var branches = [];
        perBusiness.forEach(function (list) { branches = branches.concat(list); });

        var withBranches = null;
        for (var i = 0; i < ids.length; i++) {
          if (perBusiness[i] && perBusiness[i].length) {
            if (!withBranches) withBranches = ids[i];
            if (perBusiness[i].some(function (b) { return b.isDefault; })) { withBranches = ids[i]; break; }
          }
        }
        var chosen = withBranches || ids[0];
        var decision =
          device.registered && device.suspended ? 'device-suspended' :
          device.registered ? 'open-pos' :
          device.reason === 'unreadable' ? 'retry' :
          'pair-device';
        return {
          ok: true, uid: uid,
          businesses: owned, branches: branches, device: device,
          selected: { merchantId: chosen, branchId: device.branchId ||
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
