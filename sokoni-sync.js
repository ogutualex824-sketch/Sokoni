/* ================================================================
   SOKONI SYNC ENGINE v2.0
   Universal localStorage ↔ Firestore cross-device sync.
   Auto-loaded on every page via security.js injection.
   ──────────────────────────────────────────────────────────────
   HOW IT WORKS
   • Patches localStorage.setItem / removeItem globally.
   • Any write to a known SYNC_KEY auto-schedules a Firestore push
     (debounced 3 s to batch rapid changes).
   • On login  : SokoniSync.pull(uid) restores everything from
                 Firestore into localStorage before the page renders.
   • On logout : SokoniSync.clear() stops future syncs.
   • Products  : stored as individual Firestore documents under
                 userSync/{uid}/products/{productId} to stay well
                 under Firestore's 1 MB per-document limit.
   • All other keys: userSync/{uid}/kv/{key}
================================================================ */

(function () {
  'use strict';

  /* ── Keys to sync cross-device ─────────────────────────────── */
  const SYNC_KEYS = new Set([
    /* Seller & Shop */
    'msStoreSettings','sellerProducts','sokoniFlashSales','sokoniEmployees',
    'sokoniOffers','sokoniStories','sokoniQA','sokoniPromoCodes','sokoniBoosts',
    'sokoniSubscriptions','sokoniWalletTx','sokoniWallet','sokoniExpenses',
    'sokoniInvoices','sokoniDisputes','sokoniReturns','sokoniSellerRatings',
    /* 'sokoniPremiumPlan' removed 2026-08-28 — it was a forgeable client premium
       grant (seller.js activatePlan), retired in favour of the server entitlement
       (entitlements/{uid} via SokoniAuthority). Syncing a self-granted premium
       flag across a user's devices only propagated the fabrication. */
    'sokoniCampaigns','sokoniAds','sokoniStockAlerts',
    'sokoniOwnershipQueue','sokoniMiniStore','sokoniFeaturedShops',
    'sokoniSellerVerification','sokoniVerifiedSellers',
    /* Orders & Shopping */
    /* 'sokoniWishlist' removed 2026-08-12 — the same dead entry as in auth.js. Nothing has
       ever written that key, so there is nothing on any device to sync.
       'wishlist' is DELIBERATELY KEPT. It also has zero writers now, but unlike the other
       key it holds real data on existing devices, frozen at the moment Track 3 migrated the
       UI off it. Dropping it here would stop backing that data up while a decision on the
       legacy wishlist migration is still open. It is dead weight, not dead data. */
    'sokoniOrders','cart','sokoniCart','wishlist',
    'sokoniPoints','sokoniRedeemed','sokoniAppliedPromo','sokoniDeliveries',
    'sokoniDeliveryRequests',
    /* Messaging & Social */
    'sokoniMessages','sokoniFollowNotifications','sokoniFollowing',
    'sokoniStoreFollowers','sokoniStoreLikeCounts','sokoniStoreLikes',
    'sokoniCommunityPosts','sokoniCommunity','ccGroups','ccMyGroups',
    /* Provider / Services */
    'sokoniProviderProfile','sokoniProviderBookings','sokoniProviderServices',
    'sokoniProviderAvailability','sokoniProviderStories',
    'sokoniServiceBookings','sokoniServiceProviders',
    /* Car Hub */
    'sokoniCarBookings','sokoniCarFleet','sokoniDLRecord','sokoniDLQueue',
    /* Healthcare */
    'sokoniAppointments','sokoniMedOrders','sokoniMyPharmacy',
    'sokoniPharmacyInventory','sokoniHcFacPending',
    /* Fitness */
    'sokoniGyms','sokoniGymEquip','sokoniWorkouts','gymCheckins','myGymProfile',
    /* Sports */
    'sokoniTeams','sokoniTeamRegistry','sokoniSquad','sokoniGroundSlots',
    'sokoniGroundBookings','sokoniFixtures','sokoniScheduledGames',
    'sokoniSlotsBookings','sokoniMyGround','sokoniMyGrounds','sokoniEquip',
    'sokoniGameAlerts','sokoniScheduledGames',
    /* Legal */
    'sokoniLegalBookings','sokoniLegalCompletions','sokoniCourtChecklist',
    'sokoniCommissionObligation','sokoni_firm_registrations',
    /* Home Services */
    'sokoniHomeBookings','sokoniHomeProviders','hsQuoteRequests',
    /* Cleaning / Mechanics / Tech */
    'sokoniCleaningBookings','sokoniMechBookings','sokoniMechanics',
    'sokoniParts','sokoniRepairs','sokoniReminders','sokoniDevices',
    /* Construction */
    'sokoniBuildOrders','sokoniBuildQuotes',
    /* Events / Entertainment */
    'sokoniEvents',
    /* BnB / Real Estate */
    'sokoniBnBs','sokoniBnBBookings','sokoniLandlordProperties',
    'sokoniProperties_listings','sokoniMaintenance','sokoniNotices',
    'sokoniAgreements',
    /* Delivery */
    'sokoniPackages',
    /* B2B / Banking */
    'sokoniRFQs','sokoniChamas','sokoniBankApplications',
    /* Profile & Community */
    'profileImage','sokoniRatings','sokoniReviews','sokoniUnboxingReviews',
    'sokoniReferrals','sokoniRequests',
    /* KRA / Financial */
    'kraPinSaved','sokoniTaxPayments','sokoniCommissions','sokoniCosts',
    /* Life Goals & Trust */
    'sokoniPassport','sokoniUserName',
    /* Business OS */
    'bosOrders','bosAccounts','bosCustomers','bosStaff','bosBizProfile',
    'bosInventory','bosSuppliers','bosExpenses','bosInvoices','bosReports',
    /* Food Hub */
    'sokoniFoodOrders','sokoniFoodMenus','sokoniFoodFavorites','sokoniFoodProviders',
    'sokoniFoodCart','sokoniFoodRestaurants',
    /* Entertainment */
    'sokoniTickets','sokoniEventBookings','sokoniWatchlist','sokoniEntProviders',
    /* Tournaments */
    'sokoniTournaments','sokoniTourneyReg',
    /* Fitness */
    'sokoniFitnessBookings','sokoniFitnessProviders','sokoniFitnessClasses',
  ]);

  /* ── Dynamic key prefixes that also sync ───────────────────── */
  const SYNC_PREFIXES = ['leProgress_', 'hubRep_', 'askHub_', 'cmReacted_',
    'hwListing_', 'hwBooking_', 'hwStatus_'];

  function shouldSync(key) {
    if (SYNC_KEYS.has(key)) return true;
    return SYNC_PREFIXES.some(p => key.startsWith(p));
  }

  /* ── Internal state ─────────────────────────────────────────── */
  let _db          = null;
  let _uid         = null;
  let _pending     = {};   /* key → 'set' | 'delete' */
  let _flushTimer  = null;
  let _retryCount  = {};
  const MAX_RETRIES    = 3;
  const MAX_DOC_BYTES  = 900 * 1024;   /* 900 KB — safe under 1 MB Firestore limit */
  const FS_URL         = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* ── Patch localStorage globally ───────────────────────────── */
  const _origSet    = localStorage.setItem.bind(localStorage);
  const _origRemove = localStorage.removeItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    _origSet(key, value);
    if (_uid && _db && shouldSync(key)) _schedule(key, 'set');
  };

  localStorage.removeItem = function (key) {
    _origRemove(key);
    if (_uid && _db && shouldSync(key)) _schedule(key, 'delete');
  };

  /* ── Debounce helpers ───────────────────────────────────────── */
  function _schedule(key, op) {
    _pending[key] = op;
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(_flush, 3000);
  }

  /* ── Main flush (kv store) ──────────────────────────────────── */
  async function _flush() {
    if (!_db || !_uid) return;
    const snap = { ..._pending };
    _pending = {};

    try {
      const { doc, writeBatch, deleteDoc, serverTimestamp } = await import(FS_URL);
      const batch = writeBatch(_db);
      let ops = 0;

      for (const [key, op] of Object.entries(snap)) {
        if (key === 'sellerProducts') {
          // Products handled separately — don't add to batch
          _flushProducts().catch(e => console.warn('[SokoniSync] product sync:', e.message));
          continue;
        }

        if (op === 'delete') {
          batch.delete(doc(_db, 'userSync', _uid, 'kv', key));
          ops++;
          continue;
        }

        const raw = localStorage.getItem(key);
        if (raw == null) continue;

        const bytes = new Blob([raw]).size;
        if (bytes > MAX_DOC_BYTES) {
          // Too large for one doc — skip with warning
          console.warn('[SokoniSync] Skipping oversized key:', key, '—', Math.round(bytes / 1024), 'KB');
          continue;
        }

        batch.set(doc(_db, 'userSync', _uid, 'kv', key), { v: raw, t: serverTimestamp() });
        ops++;

        if (ops >= 490) {
          // Firestore batch limit — commit and warn
          console.warn('[SokoniSync] Batch full; deferring remaining keys.');
          break;
        }
      }

      if (ops > 0) await batch.commit();

    } catch (e) {
      console.warn('[SokoniSync] Flush error:', e.message);
      // Re-queue failed keys for retry
      for (const key of Object.keys(snap)) {
        _retryCount[key] = (_retryCount[key] || 0) + 1;
        if (_retryCount[key] <= MAX_RETRIES) _pending[key] = snap[key];
        else delete _retryCount[key];
      }
      if (Object.keys(_pending).length) {
        _flushTimer = setTimeout(_flush, 10000); // back-off 10 s
      }
    }
  }

  /* ── Products: one Firestore doc per product ────────────────── */
  async function _flushProducts() {
    if (!_db || !_uid) return;
    const { doc, writeBatch, getDocs, collection, serverTimestamp } = await import(FS_URL);

    const prods     = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
    const col       = collection(_db, 'userSync', _uid, 'products');
    const fsSnap    = await getDocs(col);
    const fsIds     = new Set(fsSnap.docs.map(d => d.id));
    const localIds  = new Set(prods.map(p => String(p.id)));
    const batch     = writeBatch(_db);
    let   ops       = 0;

    // Delete Firestore products that no longer exist locally
    for (const id of fsIds) {
      if (!localIds.has(id)) {
        batch.delete(doc(_db, 'userSync', _uid, 'products', id));
        ops++;
      }
    }

    // Upsert each local product
    for (const p of prods) {
      const payload = { ...p, uid: _uid, _syncedAt: serverTimestamp() };
      const fullSize = new Blob([JSON.stringify(payload)]).size;

      if (fullSize > MAX_DOC_BYTES) {
        // Strip the images array (extra photos) but keep main image
        const { images, _syncedAt, ...stripped } = payload;
        stripped._imagesStripped = true;
        stripped._syncedAt = serverTimestamp();
        batch.set(doc(_db, 'userSync', _uid, 'products', String(p.id)), stripped);
      } else {
        batch.set(doc(_db, 'userSync', _uid, 'products', String(p.id)), payload);
      }

      ops++;
      if (ops >= 490) { await batch.commit(); return; }
    }

    if (ops > 0) await batch.commit();
  }

  /* ── Pull ALL user data Firestore → localStorage ────────────── */
  async function pull(uid) {
    if (!_db) { console.warn('[SokoniSync] pull() called before init()'); return; }
    _uid = uid;

    try {
      const { collection, getDocs } = await import(FS_URL);

      /* 1. Restore all kv keys */
      const kvSnap = await getDocs(collection(_db, 'userSync', uid, 'kv'));
      kvSnap.forEach(d => {
        if (d.data().v != null) _origSet(d.id, d.data().v);
      });

      /* 2. Restore products — merge with local (local wins for images) */
      const prodSnap = await getDocs(collection(_db, 'userSync', uid, 'products'));
      if (!prodSnap.empty) {
        const fsProds   = prodSnap.docs.map(d => {
          const data = { ...d.data() };
          delete data._syncedAt;
          return data;
        });

        let localProds;
        try { localProds = JSON.parse(localStorage.getItem('sellerProducts') || '[]'); }
        catch(e) { localProds = []; }

        const localMap = new Map(localProds.map(p => [String(p.id), p]));

        const merged = fsProds.map(fsP => {
          const lp = localMap.get(String(fsP.id));
          if (lp) {
            // Local version has image data Firestore had to strip — restore it
            if (fsP._imagesStripped && lp.images) {
              return { ...fsP, image: lp.image, images: lp.images, _imagesStripped: undefined };
            }
            // For products that exist on both, use whichever has a newer uploadedAt
            const fsTime = fsP.uploadedAt || 0;
            const lTime  = lp.uploadedAt  || 0;
            return fsTime > lTime ? fsP : lp;
          }
          return fsP; // only on Firestore (added from another device)
        });

        // Append local-only products not yet pushed to Firestore
        const fsIds = new Set(fsProds.map(p => String(p.id)));
        for (const lp of localProds) {
          if (!fsIds.has(String(lp.id))) merged.push(lp);
        }

        _origSet('sellerProducts', JSON.stringify(merged));
      }

      // Dispatch event so pages can react
      window.dispatchEvent(new CustomEvent('sokoniSyncPulled', { detail: { uid } }));

    } catch (e) {
      console.warn('[SokoniSync] Pull error:', e.message);
    }
  }

  /* ── Force push everything right now ───────────────────────── */
  function pushAll() {
    for (const key of Object.keys(localStorage)) {
      if (shouldSync(key)) _schedule(key, 'set');
    }
  }

  /* ── Wire up init / clear ───────────────────────────────────── */
  function init(db, uid) {
    _db  = db;
    _uid = uid;
  }

  function clear() {
    clearTimeout(_flushTimer);
    _db = null; _uid = null; _pending = {}; _retryCount = {};
  }

  /* ── Domain change-propagation facade (MERGED — extends this engine, does not
     replace it) ──────────────────────────────────────────────────
     The cross-device localStorage↔Firestore sync above is unchanged. These add the
     merchant domain vocabulary (Product/Stock/Availability/Shop/Order/Payment/Refund/
     Customer Changed) on the existing window.SokoniEventBus, so one canonical change
     reaches every module (POS, Shop, Orders, Inventory, Analytics, Dashboard) via the
     bus's same-origin BroadcastChannel — instead of pages manually refreshing each other. */
  const _SYNC_EVENTS = {
    ProductChanged: 'Product.Changed', StockChanged: 'Stock.Changed',
    AvailabilityChanged: 'Availability.Changed', ShopChanged: 'Shop.Changed',
    OrderChanged: 'Order.Changed', PaymentChanged: 'Payment.Changed',
    RefundChanged: 'Refund.Changed', CustomerChanged: 'Customer.Changed'
  };
  function _syncEmit(name, payload, opts) {
    const busName = _SYNC_EVENTS[name] || name;
    payload = payload || {}; opts = opts || {};
    const bus = window.SokoniEventBus;
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit(busName, payload, { source: opts.source || 'sokoni-sync', broadcast: opts.broadcast !== false }); } catch (_) {}
      return true;
    }
    try { window.dispatchEvent(new CustomEvent('sokoni:sync', { detail: { event: name, payload } })); } catch (_) {}
    return true;
  }
  function _syncOn(name, handler) {
    const busName = _SYNC_EVENTS[name] || name;
    const bus = window.SokoniEventBus;
    if (bus && typeof bus.on === 'function') {
      return bus.on(busName, function (evt) { try { handler(evt.payload, evt); } catch (_) {} });
    }
    const domFn = function (e) { if (e.detail && (e.detail.event === name)) { try { handler(e.detail.payload, e.detail); } catch (_) {} } };
    window.addEventListener('sokoni:sync', domFn);
    return function () { window.removeEventListener('sokoni:sync', domFn); };
  }
  function _syncOnAny(handler) {
    const offs = Object.keys(_SYNC_EVENTS).map(function (name) {
      return _syncOn(name, function (payload, evt) { try { handler(name, payload, evt); } catch (_) {} });
    });
    return function () { offs.forEach(function (f) { try { f(); } catch (_) {} }); };
  }

  /* ── Expose globally (cross-device engine + domain-event facade on ONE object) ── */
  window.SokoniSync = {
    /* cross-device sync engine (unchanged contract firebase.js depends on) */
    init, pull, pushAll, clear,
    /* domain change-propagation facade */
    EVENTS: _SYNC_EVENTS,
    emit: _syncEmit, on: _syncOn, onAny: _syncOnAny,
    productChanged:      function (p, o) { return _syncEmit('ProductChanged', p, o); },
    stockChanged:        function (p, o) { return _syncEmit('StockChanged', p, o); },
    availabilityChanged: function (p, o) { return _syncEmit('AvailabilityChanged', p, o); },
    shopChanged:         function (p, o) { return _syncEmit('ShopChanged', p, o); },
    orderChanged:        function (p, o) { return _syncEmit('OrderChanged', p, o); },
    paymentChanged:      function (p, o) { return _syncEmit('PaymentChanged', p, o); },
    refundChanged:       function (p, o) { return _syncEmit('RefundChanged', p, o); },
    customerChanged:     function (p, o) { return _syncEmit('CustomerChanged', p, o); }
  };

  /* ── Pick up any pending init queued by firebase.js ─────────── */
  if (window._sokoniSyncPending) {
    const { db, uid } = window._sokoniSyncPending;
    window._sokoniSyncPending = null;
    init(db, uid);
    pull(uid);
  }

  /* ── Notify firebase.js that we are ready ───────────────────── */
  window.dispatchEvent(new Event('sokoniSyncLoaded'));

})();
